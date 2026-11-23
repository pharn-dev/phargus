import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const srcDir = join(repoRoot, 'src');
const BIN = join(repoRoot, 'dist', 'esm', 'cli', 'bin.js');
const AGENT_ENTRY = join(repoRoot, 'dist', 'esm', 'agent', 'auto.js');
const REQUIRED_DIST = [
  'dist/esm/agent/auto.js',
  'dist/esm/collector/index.js',
  'dist/esm/dashboard/index.js',
  'dist/esm/cli/bin.js',
].map((p) => join(repoRoot, p));

const BUILD_TIMEOUT_MS = 170_000;
const LOCK_WAIT_MS = 170_000;
const LOCK_STALE_MS = 300_000;
const LOCK_POLL_MS = 250;
const WAIT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 300_000;

const URL_LINE = /http:\/\/127\.0\.0\.1:(\d+)/;
const INPUT_ENDED_LINE = /input ended/;
const COUNTS_LINE =
  /counts: decoder\.invalid=(\d+) decoder\.oversized=(\d+) decoder\.foreign=(\d+) collector\.ignored=(\d+) dashboard\.droppedEvents=(\d+) passthrough\.dropped=(\d+)/;

const lockDir = join(
  tmpdir(),
  `phargus-dist-build-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 16)}.lock`,
);

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

function newestSourceMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtimeMs(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

function distIsFresh(): boolean {
  let oldest = Number.POSITIVE_INFINITY;
  for (const file of REQUIRED_DIST) {
    if (!existsSync(file)) return false;
    oldest = Math.min(oldest, statSync(file).mtimeMs);
  }
  return newestSourceMtimeMs(srcDir) <= oldest;
}

function lockIsStale(): boolean {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

/** Builds dist/ once under the cross-file lock the other CLI integration tests share. */
async function ensureFreshDist(): Promise<void> {
  if (distIsFresh()) return;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err;
      if (lockIsStale()) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the dist build lock at ${lockDir}`, { cause: err });
      }
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    if (distIsFresh()) return;
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: BUILD_TIMEOUT_MS,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`node scripts/build.mjs failed:\n${result.stdout}\n${result.stderr}`);
    }
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/** The test's environment without any PHARGUS_* variable. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PHARGUS_')) delete env[key];
  }
  return env;
}

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

type Proc = {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  exitInfo: () => ExitInfo | undefined;
  exited: Promise<ExitInfo>;
};

const procs: Proc[] = [];
const connections: ClientRequest[] = [];
const tempDirs: string[] = [];

/**
 * Spawns a node process. `stdout: 'read'` collects its stdout, `'never-read'` leaves the pipe
 * unread (it fills and stays full), and `'closed'` closes the read end at once.
 */
function startProc(
  args: readonly string[],
  stdout: 'read' | 'never-read' | 'closed' = 'read',
  env: NodeJS.ProcessEnv = cleanEnv(),
  cwd: string = repoRoot,
): Proc {
  const child = spawn(process.execPath, [...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  let exitInfo: ExitInfo | undefined;
  child.stdin.on('error', () => undefined);
  child.stdout.on('error', () => undefined);
  if (stdout === 'read') {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
  } else if (stdout === 'closed') {
    child.stdout.destroy();
  }
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });
  const exited = new Promise<ExitInfo>((done) => {
    child.once('error', (error) => {
      exitInfo ??= { code: null, signal: null, error };
      done(exitInfo);
    });
    child.once('close', (code, signal) => {
      exitInfo ??= { code, signal };
      done(exitInfo);
    });
  });
  const proc: Proc = {
    child,
    stdout: () => out,
    stderr: () => err,
    exitInfo: () => exitInfo,
    exited,
  };
  procs.push(proc);
  return proc;
}

function startCli(args: readonly string[], stdout: 'read' | 'never-read' | 'closed' = 'read') {
  return startProc([BIN, 'serve', '--port', '0', ...args], stdout);
}

function diagnostics(proc: Proc): string {
  return `stdout:\n${proc.stdout().slice(0, 4000)}\nstderr:\n${proc.stderr()}\nexit: ${JSON.stringify(proc.exitInfo() ?? null)}`;
}

async function waitFor<T>(what: string, proc: Proc, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}\n${diagnostics(proc)}`);
    }
    await sleep(25);
  }
}

function waitForStderr(proc: Proc, pattern: RegExp): Promise<RegExpExecArray> {
  return waitFor(String(pattern), proc, () => pattern.exec(proc.stderr()) ?? undefined);
}

/** Waits for the input-ended line and the counts line after it; returns the counts by name. */
async function countsAtInputEnd(proc: Proc): Promise<Record<string, number>> {
  await waitForStderr(proc, INPUT_ENDED_LINE);
  const match = await waitForStderr(proc, COUNTS_LINE);
  const [invalid, oversized, foreign, ignored, droppedEvents, dropped] = match.slice(1).map(Number);
  return {
    invalid: invalid ?? -1,
    oversized: oversized ?? -1,
    foreign: foreign ?? -1,
    ignored: ignored ?? -1,
    droppedEvents: droppedEvents ?? -1,
    dropped: dropped ?? -1,
  };
}

/** Opens GET /events and resolves once a `window` event has arrived. */
function firstWindow(port: number): Promise<void> {
  return new Promise((done, fail) => {
    let body = '';
    const request = httpRequest(
      { host: '127.0.0.1', port, path: '/events', method: 'GET', agent: false },
      (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
          if (/^event: window$/m.test(body)) {
            clearTimeout(timer);
            done();
          }
        });
      },
    );
    connections.push(request);
    const timer = setTimeout(() => {
      request.destroy();
      fail(new Error(`no window event within ${String(WAIT_MS)} ms; SSE body:\n${body}`));
    }, WAIT_MS);
    request.on('error', (err) => {
      clearTimeout(timer);
      fail(err);
    });
    request.end();
  });
}

function write(proc: Proc, text: string): Promise<void> {
  return new Promise((done, fail) => {
    proc.child.stdin.write(text, (err) => {
      if (err) fail(err);
      else done();
    });
  });
}

async function stop(proc: Proc): Promise<void> {
  if (proc.exitInfo() !== undefined) return;
  proc.child.stdout.destroy();
  proc.child.kill('SIGTERM');
  const timedOut = await Promise.race([
    proc.exited.then(() => false),
    sleep(STOP_TIMEOUT_MS).then(() => true),
  ]);
  if (timedOut) {
    proc.child.kill('SIGKILL');
    await proc.exited;
  }
}

afterAll(async () => {
  for (const request of connections) request.destroy();
  for (const proc of procs) await stop(proc);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}, 60_000);

const BASE_MS = 1_700_000_000_000;

/** One agent sample line, the shape the agent writes. */
function sampleLine(timestamp: number): string {
  return `${JSON.stringify({
    timestamp,
    eventLoop: { min: 1, max: 20, mean: 10, p50: 9, p99: 18 },
    memory: { heapUsed: 1000, heapTotal: 4000, rss: 9000, external: 0, arrayBuffers: 0 },
    gc: { count: 1, totalPause: 3, maxPause: 3 },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
  })}\n`;
}

/** 1,000 alternating plain-text and JSON log lines, with agent samples between them. */
function mixedInput(): { input: string; logLines: string[] } {
  const logLines: string[] = [];
  let input = '';
  for (let index = 0; index < 1000; index += 1) {
    const line =
      index % 2 === 0
        ? `GET /users/${String(index)} 200 3ms`
        : JSON.stringify({ level: 30, time: BASE_MS + index, msg: `log ${String(index)}` });
    logLines.push(line);
    input += `${line}\n`;
    if (index % 100 === 0) input += sampleLine(BASE_MS + index * 10);
  }
  return { input, logLines };
}

describe('phargus serve: passthrough of the app output', () => {
  it(
    "AC: with the README pipeline, each line the app writes to stdout appears on serve's stdout with the same text, and no agent line does",
    async () => {
      await ensureFreshDist();
      const appLines = [
        'server listening on http://127.0.0.1:3000',
        JSON.stringify({ level: 30, msg: 'request completed', pid: 42 }),
        'GET /users 200 12ms',
        JSON.stringify({ type: 'log', msg: 'typed json log' }),
        '[1,2,3]',
        '42',
        JSON.stringify({ level: 40, msg: 'slow query' }),
        'warning: cache miss for key "users"',
      ];
      const appSource = [
        `const lines = ${JSON.stringify(appLines)};`,
        'let n = 0;',
        'const timer = setInterval(() => {',
        '  console.log(lines[n++]);',
        '  if (n === lines.length) clearInterval(timer);',
        '}, 100);',
        'setInterval(() => undefined, 1000);',
      ].join('\n');
      const appDir = mkdtempSync(join(tmpdir(), 'phargus-passthrough-app-'));
      tempDirs.push(appDir);

      const cli = startCli([]);
      const app = startProc(
        ['--import', pathToFileURL(AGENT_ENTRY).href, '-e', appSource],
        'never-read',
        cleanEnv(),
        appDir,
      );
      void pipeline(app.child.stdout, cli.child.stdin).catch(() => undefined);

      const port = Number((await waitForStderr(cli, URL_LINE))[1]);
      await firstWindow(port);
      const expected = `${appLines.join('\n')}\n`;
      await waitFor('every app line on stdout', cli, () =>
        cli.stdout().length >= expected.length ? true : undefined,
      );
      // Let a few more agent samples pass through before comparing.
      await sleep(1500);

      expect(cli.stdout(), diagnostics(cli)).toBe(expected);
      await stop(app);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'AC: 1,000 alternating plain-text and JSON log lines come out in input order; an oversized line is not echoed and is counted',
    async () => {
      await ensureFreshDist();
      const { input, logLines } = mixedInput();
      const long = `too long ${'x'.repeat(5000)}`;

      const cli = startCli(['--max-line-bytes', '4096']);
      await waitForStderr(cli, URL_LINE);
      await write(cli, `${input}${long}\n`);
      cli.child.stdin.end();
      const counts = await countsAtInputEnd(cli);
      await waitFor('the passed-through lines', cli, () =>
        cli.stdout().split('\n').length > logLines.length ? true : undefined,
      );

      expect(cli.stdout(), diagnostics(cli)).toBe(`${logLines.join('\n')}\n`);
      expect(counts, diagnostics(cli)).toMatchObject({
        invalid: 500,
        oversized: 1,
        foreign: 500,
        ignored: 0,
        dropped: 0,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'AC: --no-passthrough prints nothing to stdout, and neither does a file input by default',
    async () => {
      await ensureFreshDist();
      const { input } = mixedInput();
      const dir = mkdtempSync(join(tmpdir(), 'phargus-passthrough-file-'));
      tempDirs.push(dir);
      const capture = join(dir, 'capture.ndjson');
      writeFileSync(capture, input);

      const off = startCli(['--no-passthrough']);
      await waitForStderr(off, URL_LINE);
      await write(off, input);
      off.child.stdin.end();
      const offCounts = await countsAtInputEnd(off);

      const file = startCli([capture]);
      const fileCounts = await countsAtInputEnd(file);
      await sleep(200);

      expect(off.stdout(), diagnostics(off)).toBe('');
      expect(offCounts.foreign, diagnostics(off)).toBe(500);
      expect(file.stdout(), diagnostics(file)).toBe('');
      expect(fileCounts.foreign, diagnostics(file)).toBe(500);
    },
    TEST_TIMEOUT_MS,
  );

  // On Windows Node writes stdout pipes synchronously, so a reader that never reads blocks the
  // process (docs/LIMITS.md, "A stuck stdout reader blocks phargus serve on Windows").
  it.skipIf(process.platform === 'win32')(
    'AC: with stdout piped to a reader that never reads, lines past 1 MiB pending are dropped and counted, and the dashboard keeps receiving windows',
    async () => {
      await ensureFreshDist();
      const total = 4000;
      let input = '';
      for (let index = 0; index < total; index += 1) {
        input += `${String(index).padStart(6, '0')} ${'y'.repeat(993)}\n`;
        if (index % 400 === 0) input += sampleLine(BASE_MS + index * 10);
      }

      const cli = startCli([], 'never-read');
      const port = Number((await waitForStderr(cli, URL_LINE))[1]);
      await write(cli, input);
      cli.child.stdin.end();
      const counts = await countsAtInputEnd(cli);

      expect(counts.invalid, diagnostics(cli)).toBe(total);
      // At most about 1 MiB waits in the process plus the pipe's own buffers; the rest is dropped.
      expect(counts.dropped, diagnostics(cli)).toBeGreaterThanOrEqual(total - 1500);
      await firstWindow(port);
      expect(cli.exitInfo(), diagnostics(cli)).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'AC: with stdout closed, passthrough stops with one stderr line and the server keeps running',
    async () => {
      await ensureFreshDist();
      const cli = startCli([], 'closed');
      const port = Number((await waitForStderr(cli, URL_LINE))[1]);
      for (let round = 0; round < 5; round += 1) {
        await write(cli, `log line ${String(round)}\n${sampleLine(BASE_MS + round * 400)}`);
        await sleep(50);
      }
      cli.child.stdin.end();
      await countsAtInputEnd(cli);

      const stopped = cli.stderr().match(/^phargus: passthrough stopped.*$/gm) ?? [];
      expect(stopped, diagnostics(cli)).toHaveLength(1);
      expect(stopped[0], diagnostics(cli)).toContain('EPIPE');
      await firstWindow(port);
      expect(cli.exitInfo(), diagnostics(cli)).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});
