import { fstatSync, write } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { isMainThread } from 'node:worker_threads';
import { assertPermission } from './permission.js';

/** Mode for a newly created output file: owner read/write only. An existing file keeps its mode. */
export const AGENT_OUTPUT_FILE_MODE = 0o600;

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
      if (next >= chunk.length) {
        callback();
      } else if (bytesWritten === 0) {
        callback(new Error(`write to fd ${String(this.#fd)} made no progress`));
      } else {
        this.#writeFrom(chunk, next, callback);
      }
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
  stdoutIsPipe: () => boolean,
): boolean {
  return platform === 'win32' && mainThread && stdoutIsPipe();
}

function stdoutIsPipe(): boolean {
  try {
    return fstatSync(1).isFIFO();
  } catch {
    // No usable fd 1: fall back to process.stdout, whose first write reports the error.
    return false;
  }
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
    return writesStdoutItself(process.platform, isMainThread, stdoutIsPipe)
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
