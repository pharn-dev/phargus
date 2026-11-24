// Shared scaffolding for the integration tests: spawn the built CLI (or any node process) and wait
// for its output, raw HTTP and SSE helpers, temporary directories, and the CLI's `counts:` line.
// dist/ is built once per run by test/global-setup.ts, so nothing here builds or locks.
// Each test file that uses these helpers calls `afterAll(cleanup, 60_000)`.
import {
  spawn,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
export const BIN = join(repoRoot, 'dist', 'esm', 'cli', 'bin.js');

export const RUN_TIMEOUT_MS = 30_000;
export const STARTUP_TIMEOUT_MS = 30_000;
export const HTTP_TIMEOUT_MS = 15_000;
export const EVENT_TIMEOUT_MS = 30_000;
export const STOP_TIMEOUT_MS = 15_000;

/** The dashboard URL line the CLI prints on stderr. */
export const URL_LINE = /http:\/\/127\.0\.0\.1:(\d+)/;
export const INPUT_ENDED_LINE = /input ended/i;
/** The CLI's `counts:` line: decoder invalid, oversized and foreign skips, collector ignored. */
export const COUNTS_LINE =
  /decoder\.invalid=(\d+)[^\n]*decoder\.oversized=(\d+)[^\n]*decoder\.foreign=(\d+)[^\n]*collector\.ignored=(\d+)/;

export function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/** Polls the predicate until it holds, or fails after the timeout naming what it waited for. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string | (() => string),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${typeof what === 'string' ? what : what()}`);
    }
    await sleep(10);
  }
}

/** The test's environment without any PHARGUS_* variable, plus the given extra variables. */
export function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PHARGUS_')) delete env[key];
  }
  return { ...env, ...extra };
}

export type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

export type PipedChild =
  ChildProcessWithoutNullStreams | ChildProcessByStdio<null, Readable, Readable>;

/** A spawned process whose output is collected as it arrives. */
export type Proc<C extends PipedChild = ChildProcessWithoutNullStreams> = {
  child: C;
  stdout: () => string;
  stderr: () => string;
  notes: string[];
  exitInfo: () => ExitInfo | undefined;
  exited: Promise<ExitInfo>;
};
export type CliRun = Proc;

const procs: Proc<PipedChild>[] = [];
const connections: ClientRequest[] = [];
const tempDirs: string[] = [];

/**
 * Collects a child's stderr, records every stream error, and stops it in cleanup(). `stdout: 'read'`
 * collects its stdout too, `'never-read'` leaves that pipe alone (unread, or piped elsewhere by the
 * caller), and `'closed'` closes its read end at once.
 */
export function track<C extends PipedChild>(
  child: C,
  stdoutMode: 'read' | 'never-read' | 'closed' = 'read',
): Proc<C> {
  let stdout = '';
  let stderr = '';
  let exitInfo: ExitInfo | undefined;
  const notes: string[] = [];
  if (stdoutMode === 'read') {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
  } else if (stdoutMode === 'closed') {
    child.stdout.destroy();
  }
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on('error', (err) => notes.push(`child stdout error: ${err.message}`));
  child.stderr.on('error', (err) => notes.push(`child stderr error: ${err.message}`));
  child.stdin?.on('error', (err) => notes.push(`child stdin error: ${err.message}`));
  const exited = new Promise<ExitInfo>((done) => {
    child.once('error', (error: Error) => {
      exitInfo ??= { code: null, signal: null, error };
      done(exitInfo);
    });
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      exitInfo ??= { code, signal };
      done(exitInfo);
    });
  });
  const proc: Proc<C> = {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    notes,
    exitInfo: () => exitInfo,
    exited,
  };
  procs.push(proc);
  return proc;
}

/** Spawns `node <args>` with piped stdio, by default from the repository root. */
export function startNode(
  args: readonly string[],
  env: NodeJS.ProcessEnv = cliEnv(),
  cwd: string = repoRoot,
): Proc {
  return track(spawn(process.execPath, [...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }));
}

/** Spawns `node dist/esm/cli/bin.js <args>`. */
export function startCli(args: readonly string[], env: NodeJS.ProcessEnv = cliEnv()): CliRun {
  return startNode([BIN, ...args], env);
}

export function diagnostics(run: Proc<PipedChild>): string {
  return `stdout:\n${run.stdout()}\nstderr:\n${run.stderr()}\nnotes: ${run.notes.join('; ')}\nexit: ${JSON.stringify(run.exitInfo() ?? null)}`;
}

/** Waits for the run to exit; a run still alive after the timeout is killed and the wait fails. */
export async function waitForExit(run: Proc<PipedChild>, timeoutMs: number): Promise<ExitInfo> {
  const timedOut = await Promise.race([
    run.exited.then(() => false),
    sleep(timeoutMs).then(() => true),
  ]);
  if (timedOut) {
    run.child.kill('SIGKILL');
    await run.exited;
    throw new Error(`the process did not exit within ${timeoutMs} ms\n${diagnostics(run)}`);
  }
  return run.exited;
}

/** Runs the CLI with an empty stdin to completion. */
export async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = cliEnv(),
): Promise<{ run: CliRun; exit: ExitInfo }> {
  const run = startCli(args, env);
  run.child.stdin.end();
  const exit = await waitForExit(run, RUN_TIMEOUT_MS);
  return { run, exit };
}

/** Waits until stderr matches the pattern; fails if the process exits first or the timeout passes. */
export async function waitForStderr(
  run: Proc<PipedChild>,
  pattern: RegExp,
  timeoutMs: number,
  what: () => string = () => diagnostics(run),
): Promise<RegExpExecArray> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = pattern.exec(run.stderr());
    if (match) return match;
    if (run.exitInfo() !== undefined) {
      throw new Error(`the process exited before its stderr matched ${String(pattern)}\n${what()}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for stderr to match ${String(pattern)}\n${what()}`);
    }
    await sleep(25);
  }
}

/** Waits for the dashboard URL line and returns the port it names. */
export async function waitForPort(run: Proc<PipedChild>): Promise<number> {
  const match = await waitForStderr(run, URL_LINE, STARTUP_TIMEOUT_MS);
  return Number(match[1]);
}

/** SIGTERM, then SIGKILL if the process is still alive after STOP_TIMEOUT_MS. */
export async function stopCli(run: Proc<PipedChild>): Promise<void> {
  if (run.exitInfo() !== undefined) return;
  run.child.kill('SIGTERM');
  const timedOut = await Promise.race([
    run.exited.then(() => false),
    sleep(STOP_TIMEOUT_MS).then(() => true),
  ]);
  if (timedOut) {
    run.child.kill('SIGKILL');
    await run.exited;
  }
}

/** Writes a chunk to the process's stdin and resolves once it has been handed to the pipe. */
export function writeStdin(run: Proc, text: string): Promise<void> {
  return new Promise((done, fail) => {
    run.child.stdin.write(text, (err) => {
      if (err) fail(err);
      else done();
    });
  });
}

/** Sends one raw GET with the given target and resolves with the whole reply (latin1). */
export function rawRequest(port: number, target: string): Promise<string> {
  return new Promise((done, fail) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', fail);
    socket.on('close', () => done(Buffer.concat(chunks).toString('latin1')));
    socket.setTimeout(5_000, () => socket.destroy(new Error('raw request timed out')));
    socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  });
}

export type SseConnection = {
  request: ClientRequest;
  statusCode: number;
  contentType: string;
  body: () => string;
  /** Settles when the response ends or its connection closes. */
  ended: Promise<void>;
  errors: string[];
};

/** Opens GET `path` and resolves on the response headers; the body is collected as it arrives. */
export function openEvents(
  port: number,
  headers: Record<string, string> = {},
  path = '/events',
): Promise<SseConnection> {
  return new Promise((done, fail) => {
    let body = '';
    const errors: string[] = [];
    const request = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers, agent: false },
      (response) => {
        clearTimeout(timer);
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('error', (err) => {
          errors.push(err.message);
        });
        const ended = new Promise<void>((settle) => {
          response.once('end', settle);
          response.once('close', settle);
        });
        done({
          request,
          statusCode: response.statusCode ?? 0,
          contentType: String(response.headers['content-type'] ?? ''),
          body: () => body,
          ended,
          errors,
        });
      },
    );
    connections.push(request);
    const timer = setTimeout(() => {
      request.destroy(new Error(`GET ${path} got no response headers in time`));
    }, HTTP_TIMEOUT_MS);
    request.on('error', (err) => {
      clearTimeout(timer);
      errors.push(err.message);
      fail(err);
    });
    request.end();
  });
}

export type SseEvent = { event: string; data: string[] };

/** Parses every complete SSE block of the text into events (comment lines are skipped). */
export function parseSse(raw: string): SseEvent[] {
  const blocks = raw.split('\r\n').join('\n').split('\n\n');
  blocks.pop();
  const events: SseEvent[] = [];
  for (const block of blocks) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        const value = line.slice('data:'.length);
        data.push(value.startsWith(' ') ? value.slice(1) : value);
      }
    }
    if (event !== undefined) {
      events.push({ event, data });
    }
  }
  return events;
}

/** The parsed data of every `window` event the connection has received. */
export function windowsOf(connection: SseConnection): unknown[] {
  return parseSse(connection.body())
    .filter((event) => event.event === 'window')
    .map((event) => JSON.parse(event.data.join('\n')) as unknown);
}

/** Waits until the connection has received at least one `window` event. */
export async function waitForWindow(
  connection: SseConnection,
  run: Proc<PipedChild>,
  timeoutMs: number = EVENT_TIMEOUT_MS,
): Promise<unknown[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const windows = windowsOf(connection);
    if (windows.length > 0) return windows;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for a window event\nSSE body:\n${connection.body()}\n${diagnostics(run)}`,
      );
    }
    await sleep(50);
  }
}

/** A fresh directory under the OS temp directory, removed in cleanup(). */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Closes every connection, stops every process and removes every temp directory made here. */
export async function cleanup(): Promise<void> {
  for (const request of connections.splice(0)) request.destroy();
  for (const proc of procs.splice(0)) await stopCli(proc);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** An agent sample object, the shape the agent writes. */
export function makeSample(timestamp: number, eventLoopMax = 20): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: eventLoopMax, mean: 10, p50: 9, p99: 18 },
    memory: { heapUsed: 100, heapTotal: 200, rss: 1000, external: 0, arrayBuffers: 0 },
    gc: {
      count: 1,
      totalPause: 3,
      maxPause: 3,
      kinds: { minor: 1, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
  };
}
