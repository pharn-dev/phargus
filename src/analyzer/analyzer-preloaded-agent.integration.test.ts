// CORE-256: with the agent preloaded, live analyzer pool workers start no second agent.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('.', import.meta.url));
const agentEntry = pathToFileURL(join(srcDir, '..', 'agent', 'auto.ts')).href;

// Lets a plain `node` process import this repo's TypeScript sources (`./x.js` -> `./x.ts`).
const TS_HOOKS_URL = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return next(specifier.slice(0, -3) + '.ts', context);
      }
      throw error;
    }
  },
});`)}`;

const INTERVAL_MS = 50;

const SMALL_SNAPSHOT = JSON.stringify({
  snapshot: { meta: { node_fields: ['type', 'name', 'self_size'], node_types: [['object']] } },
  nodes: [0, 0, 10, 0, 1, 20],
  strings: ['Alpha', 'Beta'],
});

/** The parent's env minus every PHARGUS_* name and NODE_OPTIONS, plus `extra`. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.startsWith('PHARGUS_') || name === 'NODE_OPTIONS') continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phargus-analyzer-preload-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('analyzer pools under a preloaded agent (CORE-256)', () => {
  it('a live symbolization pool and a live heap-snapshot pool add no sample line', async () => {
    const snapshot = join(dir, 'small.heapsnapshot');
    await writeFile(snapshot, SMALL_SNAPSHOT);
    const app = join(dir, 'host.mjs');
    await writeFile(
      app,
      `const { createHeapSnapshotPool, createSymbolizationPool, summarizeHeapSnapshot, symbolizeStackFrames } =
  await import(${JSON.stringify(pathToFileURL(join(srcDir, 'index.ts')).href)});
const heapPool = createHeapSnapshotPool();
const symbolizePool = createSymbolizationPool();
// One task each, so both pools have a live worker.
const summary = await summarizeHeapSnapshot(${JSON.stringify(snapshot)}, { pool: heapPool });
const frames = await symbolizeStackFrames([{ url: 'node:internal/x', line: 1, column: 1 }], {
  pool: symbolizePool,
});
const started = Date.now();
// Let every live thread sample for about twenty intervals.
await new Promise((r) => setTimeout(r, ${String(INTERVAL_MS * 20)}));
const elapsed = Date.now() - started;
await Promise.all([heapPool.close(), symbolizePool.close()]);
process.stderr.write(JSON.stringify({ nodeCount: summary.nodeCount, frames: frames.length, started, elapsed }) + '\\n');
`,
    );
    const child = spawnSync(
      process.execPath,
      ['--import', TS_HOOKS_URL, '--import', agentEntry, app],
      {
        cwd: dir,
        env: childEnv({ PHARGUS_INTERVAL_MS: String(INTERVAL_MS) }),
        encoding: 'utf8',
        timeout: 50_000,
      },
    );
    expect(child.error, String(child.error)).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const report = JSON.parse(child.stderr.trim().split('\n').pop() ?? '') as {
      nodeCount: number;
      frames: number;
      started: number;
      elapsed: number;
    };
    expect(report.nodeCount).toBe(2);
    expect(report.frames).toBe(1);

    const timestamps = child.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { timestamp: number }).timestamp);
    const whilePoolsLive = timestamps.filter(
      (t) => t >= report.started && t <= report.started + report.elapsed,
    );
    // One sampler: about one line per interval while the pools are live, never twice as many.
    expect(whilePoolsLive.length).toBeGreaterThanOrEqual(5);
    expect(whilePoolsLive.length).toBeLessThanOrEqual(Math.floor(report.elapsed / INTERVAL_MS) + 1);
    // In order, never two lines within half an interval.
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i]! - timestamps[i - 1]!).toBeGreaterThanOrEqual(INTERVAL_MS / 2);
    }
  }, 60_000);
});
