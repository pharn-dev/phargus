/// <reference types="node" />
import { fstatSync, write } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { isMainThread } from 'node:worker_threads';
import { loadAgentConfig, readConfigEnv } from './config.js';
import {
  DEFAULT_SPAN_BUFFER_SIZE,
  enable as enableTracing,
  disable as disableTracing,
  drainSpans,
  setSpanBufferSize,
} from './http-tracing.js';
import { createNdjsonExporter } from './ndjson-exporter.js';
import { assertPermission } from './permission.js';
import { createSamplerController } from './sampler-controller.js';
import type { AgentSample } from './sampler-controller.js';
import type { SpanDrain } from './span-buffer.js';
import { SPAN_RECORD_TYPE } from './span-record.js';
import type { AgentLossCounters, AgentSampleLine, SpanRecord } from './span-record.js';

/** Mode for a newly created output file: owner read/write only. An existing file keeps its mode. */
const AGENT_OUTPUT_FILE_MODE = 0o600;

/** Where a full output file goes: `<file>.1`, replacing an older one. */
export function rotatedOutputPath(file: string): string {
  return `${file}.1`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * An append-mode file that holds at most `maxBytes` (0 = no bound). Each `write()` is one NDJSON
 * line; before a line that would take the file past the bound, the file is renamed to `<file>.1`
 * and a new `<file>` is opened, so rotation happens between lines and never splits one. Only
 * asynchronous `node:fs/promises` calls are used; lines written meanwhile wait in the stream's
 * buffer and the exporter's bounded lanes.
 */
class BoundedFileOutput extends Writable {
  readonly #file: string;
  readonly #maxBytes: number;
  #handle: FileHandle | undefined;
  #size = 0;

  constructor(file: string, maxBytes: number) {
    super();
    this.#file = file;
    this.#maxBytes = maxBytes;
  }

  override _construct(callback: (error?: Error | null) => void): void {
    this.#open().then(() => {
      callback();
    }, callback);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#append(chunk).then(() => {
      callback();
    }, callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const handle = this.#handle;
    this.#handle = undefined;
    if (handle === undefined) {
      callback(error);
      return;
    }
    handle.close().then(
      () => {
        callback(error);
      },
      (closeError: unknown) => {
        callback(error ?? new Error(errorMessage(closeError), { cause: closeError }));
      },
    );
  }

  async #open(): Promise<void> {
    this.#handle = await open(this.#file, 'a', AGENT_OUTPUT_FILE_MODE);
    this.#size = (await this.#handle.stat()).size;
  }

  async #rotate(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    await handle?.close();
    const target = rotatedOutputPath(this.#file);
    try {
      await rename(this.#file, target);
    } catch (err) {
      throw new Error(`cannot rotate ${this.#file} to ${target}: ${errorMessage(err)}`, {
        cause: err,
      });
    }
    await this.#open();
  }

  async #append(chunk: Buffer): Promise<void> {
    if (this.#maxBytes > 0 && this.#size > 0 && this.#size + chunk.length > this.#maxBytes) {
      await this.#rotate();
    }
    const handle = this.#handle;
    if (handle === undefined) {
      throw new Error(`output file ${this.#file} is not open`);
    }
    let offset = 0;
    while (offset < chunk.length) {
      const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
      offset += bytesWritten;
    }
    this.#size += chunk.length;
  }
}

/**
 * An already-open file descriptor written with asynchronous `fs.write`, which runs on libuv's
 * thread pool, so a write that blocks in the OS blocks a pool thread and never the event loop. One
 * write is in flight at a time; lines written meanwhile wait in the stream's buffer and the
 * exporter's bounded lanes. The descriptor is never closed.
 */
class FdOutput extends Writable {
  readonly #fd: number;

  constructor(fd: number) {
    super();
    this.#fd = fd;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#writeFrom(chunk, 0, callback);
  }

  #writeFrom(chunk: Buffer, offset: number, callback: (error?: Error | null) => void): void {
    write(this.#fd, chunk, offset, chunk.length - offset, null, (err, bytesWritten) => {
      if (err !== null) {
        callback(err);
        return;
      }
      const next = offset + bytesWritten;
      if (next < chunk.length && bytesWritten > 0) {
        this.#writeFrom(chunk, next, callback);
        return;
      }
      callback(
        next < chunk.length ? new Error(`write to fd ${String(this.#fd)} made no progress`) : null,
      );
    });
  }
}

/** A Writable over the open descriptor `fd` that writes with asynchronous `fs.write`. */
export function createFdOutput(fd: number): Writable {
  return new FdOutput(fd);
}

/**
 * Whether the agent writes stdout through its own `createFdOutput(1)` instead of
 * `process.stdout`: on the main thread on Windows when stdout is a pipe. There Node replaces each
 * write to a stdout pipe with a synchronous write to fd 1, so a stalled reader would stop the
 * whole process once the pipe is full. Elsewhere `process.stdout` already queues in Node.
 */
export function writesStdoutItself(
  platform: NodeJS.Platform,
  mainThread: boolean,
  stdoutMode: () => number,
): boolean {
  return platform === 'win32' && mainThread && isPipeMode(stdoutMode());
}

const S_IFMT = 0o170000;
const S_IFIFO = 0o010000;

/**
 * Whether an `fs.Stats` mode is a pipe. Node's `Stats.isFIFO()` always returns false on Windows,
 * though libuv reports a pipe there with the S_IFIFO bits, so the bits are read directly.
 */
export function isPipeMode(mode: number): boolean {
  return (mode & S_IFMT) === S_IFIFO;
}

function stdoutMode(): number {
  return fstatSync(1).mode;
}

/**
 * Open the NDJSON destination. For 'stdout': `process.stdout`, or on Windows, when stdout is a
 * pipe, the agent's own asynchronous writer on fd 1 (see `writesStdoutItself`). Otherwise an
 * append-mode file (created with mode 0600) that is renamed to `<file>.1` when the next line would
 * take it past `maxBytes` (0 = no bound). Under the Node permission model a file destination needs an
 * `fs.write` grant, and with a bound also `fs.write` on `<file>.1` and `fs.read` on `<file>` (which
 * `rename` checks); a missing grant throws `PhargusPermissionError` before any file is opened.
 */
export function openAgentOutput(output: string, maxBytes: number): Writable {
  if (output === 'stdout') {
    return writesStdoutItself(process.platform, isMainThread, stdoutMode)
      ? createFdOutput(1)
      : process.stdout;
  }
  assertPermission('fs.write', output);
  if (maxBytes > 0) {
    assertPermission('fs.read', output);
    assertPermission('fs.write', rotatedOutputPath(output));
  }
  return new BoundedFileOutput(output, maxBytes);
}

const AGENT_KEY = Symbol.for('phargus.agent');

type AgentGlobal = { [AGENT_KEY]?: true };

let reported = false;

/** Write at most one `[phargus]` line per process; reporting itself never throws. */
function reportOnce(err: unknown): void {
  if (reported) {
    return;
  }
  reported = true;
  try {
    const oneLine = errorMessage(err).replace(/\s+/g, ' ').trim();
    process.stderr.write(`[phargus] agent disabled: ${oneLine}\n`);
  } catch {
    // Reporting must never throw into the monitored process; stderr is the only channel.
  }
}

export type AgentExportOptions = {
  /** Bound of each output lane: sample lines and span lines are queued separately. */
  queueBound: number;
};

export type AgentExport = {
  /** Move the tracer's buffered spans into the span lane. Throws what the drain throws. */
  flushSpans(): void;
  /** Queue one sample line carrying the cumulative loss counters. */
  exportSample(sample: AgentSample): void;
  /** Cumulative integer loss counters, as the next sample line will carry them. */
  readonly dropped: AgentLossCounters;
  /** Flush both lanes and end the destination. */
  stop(): Promise<void>;
  /** The exporter's pipeline() result. */
  readonly done: Promise<void>;
};

/**
 * The agent's output wiring: one NDJSON pipeline with a sample lane and a span lane. Samples are
 * written first and never evicted by spans; each lane drops its own oldest lines when the
 * destination stalls, and every sample line reports the cumulative drops as `dropped`.
 */
export function createAgentExport(
  destination: Writable,
  options: AgentExportOptions,
  drain: () => SpanDrain,
): AgentExport {
  const exporter = createNdjsonExporter(destination, { queueBound: options.queueBound });
  let tracerDrops = 0;
  const lossCounters = (): AgentLossCounters => ({
    samples: exporter.droppedRecords,
    spans: tracerDrops + exporter.droppedSpans,
  });
  return {
    flushSpans(): void {
      const result = drain();
      tracerDrops += result.dropped;
      for (const span of result.spans) {
        const record: SpanRecord = { type: SPAN_RECORD_TYPE, ...span };
        exporter.exportSpan(record);
      }
    },
    exportSample(sample: AgentSample): void {
      const line: AgentSampleLine = { ...sample, pid: process.pid, dropped: lossCounters() };
      exporter.export(line);
    },
    get dropped(): AgentLossCounters {
      return lossCounters();
    },
    stop(): Promise<void> {
      return exporter.stop();
    },
    done: exporter.done,
  };
}

async function start(): Promise<void> {
  const config = await loadAgentConfig(process.cwd(), process.env);
  if (!config.enabled || config.output === 'none') {
    disableTracing();
    return;
  }
  // 0 (here only from the config file: in the environment it never enabled tracing) switches
  // tracing off; the samplers still run.
  if (config.spanBuffer === 0) {
    disableTracing();
  } else {
    setSpanBufferSize(config.spanBuffer);
  }
  const destination = openAgentOutput(config.output, config.outputMaxBytes);
  const output = createAgentExport(destination, { queueBound: config.queueBound }, drainSpans);
  let disable = (err: unknown): void => {
    reportOnce(err);
  };
  const flushSpans = (): void => {
    try {
      output.flushSpans();
    } catch (err) {
      disable(err);
    }
  };
  const onBeforeExit = (): void => {
    flushSpans();
  };
  process.once('beforeExit', onBeforeExit);
  const controller = createSamplerController((sample) => {
    // Spans first, so this sample's `dropped` includes the tick's drain; the sample lane is
    // still written ahead of every queued span.
    flushSpans();
    try {
      output.exportSample(sample);
    } catch (err) {
      disable(err);
    }
  });
  disable = (err: unknown): void => {
    controller.stop();
    disableTracing();
    process.off('beforeExit', onBeforeExit);
    reportOnce(err);
  };
  // pipeline() does not settle while the exporter's source is idle, so listen on the destination too.
  destination.once('error', disable);
  output.done.then(undefined, disable);
  controller.start(config.intervalMs);
}

/** A failed start switches tracing back off and reports once; it never throws. */
function failStart(err: unknown): void {
  try {
    disableTracing();
  } catch (disableError) {
    reportOnce(new AggregateError([err, disableError], 'start failed and tracing stayed on'));
    return;
  }
  reportOnce(err);
}

/**
 * Start the agent once per process (shared across ESM/CJS copies via globalThis). Never throws.
 * Worker threads run preloads too but are not sampled: only the main thread starts the agent.
 */
export function startAgentOnce(): void {
  if (!isMainThread) {
    return;
  }
  try {
    const g = globalThis as AgentGlobal;
    if (g[AGENT_KEY] === true) {
      return;
    }
    g[AGENT_KEY] = true;
    // Off in the environment means off: no patch and no config file lookup. Unknown variables are
    // warned about later by loadAgentConfig; an invalid value throws and is reported below.
    const fromEnv = readConfigEnv(process.env, process.cwd(), () => {});
    if (fromEnv.enabled === false || fromEnv.output === 'none') {
      return;
    }
    // Trace from the first tick: requests that arrive while the config loads still get spans.
    // The buffer is bounded, and tracing is switched off again if the agent ends up disabled.
    // PHARGUS_SPAN_BUFFER=0 means no tracing at all: nothing is patched or subscribed.
    if (fromEnv.spanBuffer !== 0) {
      enableTracing({ spanBufferSize: fromEnv.spanBuffer ?? DEFAULT_SPAN_BUFFER_SIZE });
    }
    start().catch(failStart);
  } catch (err) {
    failStart(err);
  }
}
