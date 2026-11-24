import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// With the agent's output on stdout and stdout piped to a reader that stops reading, does the app
// keep running? It must, on every platform: the agent's lines wait in its bounded lanes, the oldest
// are dropped and counted, and the event loop keeps turning. On Linux and macOS the agent writes
// through `process.stdout`, which queues in Node. On Windows Node writes a stdout pipe
// synchronously, so the agent writes that pipe itself with asynchronous `fs.write`
// (agent-output.ts, `writesStdoutItself`); before that, a full pipe blocked the whole process there.
// The test prints what it observed, so the platform-smoke job's log is the evidence for
// docs/LIMITS.md.

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const srcDir = join(repoRoot, 'src');
const AGENT_ENTRY = join(repoRoot, 'dist', 'esm', 'agent', 'auto.js');

const BUILD_TIMEOUT_MS = 170_000;
const LOCK_WAIT_MS = 170_000;
const LOCK_STALE_MS = 300_000;
const LOCK_POLL_MS = 250;
const STARTUP_TIMEOUT_MS = 15_000;
/**
 * How long the app runs with nobody reading its stdout. Windows timers fire about every 15 ms, so
 * the 2 ms sampler fills the pipe only after about 2 s there (Node 22.18, windows-latest).
 */
const OBSERVE_MS = 5_000;
/** A gap between two app reports at least this long counts as the app being blocked. */
const BLOCKED_GAP_MS = 1_000;
const REPORT_EVERY_MS = 100;
/** How long the reader reads again after the stall, to collect the agent's later sample lines. */
const RESUME_MS = 1_500;

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
  try {
    return newestSourceMtimeMs(srcDir) <= statSync(AGENT_ENTRY).mtimeMs;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

function lockIsStale(): boolean {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

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

/**
 * The app: a 10 ms timer counts event-loop turns, and every 100 ms one line on stderr reports the
 * count, the time since start and how many bytes wait in Node's stdout buffer. The app itself
 * never writes to stdout: everything there is the agent's.
 */
const APP_SOURCE = `
const start = Date.now();
let turns = 0;
setInterval(() => { turns += 1; }, 10);
setInterval(() => {
  process.stderr.write('report ' + turns + ' ' + (Date.now() - start) + ' ' + process.stdout.writableLength + '\\n');
}, ${String(REPORT_EVERY_MS)});
`;

type Report = { turns: number; elapsedMs: number; bufferedBytes: number; receivedAt: number };

let workDir: string | undefined;

afterAll(() => {
  if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
});

describe('agent output on stdout, reader stalled', () => {
  beforeAll(async () => {
    await ensureFreshDist();
  }, 180_000);

  it('the app keeps running and the agent drops lines when nobody reads its stdout, on every platform', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'phargus-stdout-stall-'));
    const appFile = join(workDir, 'app.mjs');
    writeFileSync(appFile, APP_SOURCE);

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('PHARGUS_')) delete env[key];
    }
    // A sample line every 2 ms (about 450 bytes each) fills a pipe buffer in well under a second.
    env['PHARGUS_INTERVAL_MS'] = '2';
    // Small lanes, so the stall drops sample lines even at Windows' coarse timer resolution.
    env['PHARGUS_QUEUE_BOUND'] = '8';

    const child = spawn(process.execPath, ['--import', pathToFileURL(AGENT_ENTRY).href, appFile], {
      cwd: workDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The reader that stops reading: stdout is never consumed.
    child.stdout.pause();
    child.stdout.on('error', () => undefined);

    const reports: Report[] = [];
    let stderrText = '';
    let partial = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrText += chunk;
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        const match = /^report (\d+) (\d+) (\d+)$/.exec(line.trim());
        if (match === null) continue;
        reports.push({
          turns: Number(match[1]),
          elapsedMs: Number(match[2]),
          bufferedBytes: Number(match[3]),
          receivedAt: Date.now(),
        });
      }
    });
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const exitedPromise = new Promise<void>((done) => {
      child.once('exit', (code, signal) => {
        exited = { code, signal };
        done();
      });
    });

    try {
      const startupDeadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (reports.length === 0 && exited === undefined && Date.now() < startupDeadline) {
        await sleep(20);
      }
      expect(reports.length, `the app never reported; stderr:\n${stderrText}`).toBeGreaterThan(0);

      const observeStart = Date.now();
      await sleep(OBSERVE_MS);
      const observeEnd = Date.now();

      const arrivals = [observeStart, ...reports.map((r) => r.receivedAt), observeEnd]
        .filter((t) => t >= observeStart && t <= observeEnd)
        .sort((a, b) => a - b);
      let maxGapMs = 0;
      for (let i = 1; i < arrivals.length; i += 1) {
        maxGapMs = Math.max(maxGapMs, (arrivals[i] ?? 0) - (arrivals[i - 1] ?? 0));
      }
      const last = reports[reports.length - 1];
      const maxBufferedBytes = Math.max(...reports.map((r) => r.bufferedBytes));
      const blocked = maxGapMs >= BLOCKED_GAP_MS;

      // Read again: the agent's sample lines written after the stall carry the drops it counted.
      let stdoutText = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutText += chunk;
      });
      child.stdout.resume();
      await sleep(RESUME_MS);
      let droppedSamples = 0;
      let sampleLines = 0;
      // Only newline-terminated lines: the agent is still writing, so the text can end mid-record.
      const complete = stdoutText.slice(0, stdoutText.lastIndexOf('\n') + 1);
      for (const line of complete.split('\n')) {
        if (!line.startsWith('{')) continue;
        const record = JSON.parse(line) as { dropped?: { samples?: unknown } };
        const samples = record.dropped?.samples;
        if (typeof samples !== 'number') continue;
        sampleLines += 1;
        droppedSamples = Math.max(droppedSamples, samples);
      }

      const observed = {
        platform: process.platform,
        node: process.version,
        blocked,
        maxGapMs,
        reports: reports.length,
        lastTurns: last?.turns,
        lastElapsedMs: last?.elapsedMs,
        maxBufferedBytes,
        sampleLines,
        droppedSamples,
        exited: exited ?? null,
      };
      // The evidence for docs/LIMITS.md: printed on every platform, read from the CI job log.
      console.log(`[stdout-stall] observed ${JSON.stringify(observed)}`);

      expect(exited, `the app exited; stderr:\n${stderrText}`).toBeUndefined();
      expect(stderrText, 'the agent turned itself off').not.toContain('[phargus] agent disabled');
      // The event loop kept turning while nobody read stdout.
      expect(blocked, JSON.stringify(observed)).toBe(false);
      // The agent kept running and dropped lines instead of waiting for the reader.
      expect(droppedSamples, JSON.stringify(observed)).toBeGreaterThan(0);
      if (process.platform === 'win32') {
        // The agent writes the pipe itself, not through the app's `process.stdout`.
        expect(maxBufferedBytes, JSON.stringify(observed)).toBe(0);
      } else {
        // Node queued the agent's lines in `process.stdout` (the pipe was full).
        expect(maxBufferedBytes, JSON.stringify(observed)).toBeGreaterThan(0);
      }
    } finally {
      child.kill();
      child.stdout.destroy();
      await Promise.race([exitedPromise, sleep(5_000)]);
    }
  }, 30_000);
});
