import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('.', import.meta.url));

// Lets a plain `node` child import this module's TypeScript sources (`./x.js` -> `./x.ts`).
const TS_HOOKS = `
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
});
`;
const TS_HOOKS_URL = `data:text/javascript,${encodeURIComponent(TS_HOOKS)}`;

const WINDOW_COUNT = 20;
const MAX_BYTES = 1024;

// Runs a persisting collector under the permission model and prints one JSON result line.
const SCRIPT = `
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [srcDir, path, maxBytes, windowCount] = process.argv.slice(1);
const warnings = [];
process.on('warning', (warning) => {
  if (warning.name === 'PhargusPersistenceWarning') warnings.push(warning.message);
});
const { createCollector } = await import(pathToFileURL(join(srcDir, 'index.ts')).href);
const collector = createCollector({
  windowMs: 1000,
  capacity: 100,
  persist: { path, maxBytes: Number(maxBytes) },
});
const seen = [];
collector.subscribe({ window: (window) => seen.push(window.start) });
const samples = [];
for (let index = 0; index < Number(windowCount); index += 1) {
  for (const offset of [100, 600]) {
    samples.push({
      timestamp: index * 1000 + offset,
      eventLoop: { min: 1, max: 20, mean: 10, p50: 9, p99: 18 },
      memory: { heapUsed: 100, heapTotal: 200, rss: 1000, external: 0, arrayBuffers: 0 },
      gc: { count: 1, totalPause: 3, maxPause: 3, kinds: { minor: 1, major: 0, incremental: 0, weakcb: 0 } },
      backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
    });
  }
}
let consumed = 'resolved';
try {
  await collector.consume(samples);
} catch (error) {
  consumed = 'rejected: ' + (error && error.code ? error.code : String(error));
}
await collector.close();
// Warnings are emitted on a later tick.
await new Promise((resolve) => setImmediate(resolve));
console.log(JSON.stringify({
  consumed,
  windows: collector.windows.snapshot().map((window) => window.start),
  seen,
  failed: collector.persistence.failed,
  warnings,
}));
`;

type Result = {
  consumed: string;
  windows: number[];
  seen: number[];
  failed: number;
  warnings: string[];
};

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function runUnderPermission(
  writeGrants: string[],
  path: string,
): { result: Result; output: string } {
  const child = spawnSync(
    process.execPath,
    [
      '--permission',
      '--allow-fs-read=*',
      ...writeGrants.map((grant) => `--allow-fs-write=${grant}`),
      '--import',
      TS_HOOKS_URL,
      '--input-type=module',
      '-e',
      SCRIPT,
      srcDir,
      path,
      String(MAX_BYTES),
      String(WINDOW_COUNT),
    ],
    { cwd: srcDir, encoding: 'utf8', timeout: 60_000 },
  );
  const output = `${child.stdout}\n${child.stderr}`.slice(-4000);
  expect(child.status, output).toBe(0);
  return { result: JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '') as Result, output };
}

const STARTS = Array.from({ length: WINDOW_COUNT }, (_, index) => index * 1000);

describe('collector persistence under the permission model (CORE-246)', () => {
  it('with write access to the persistence file only, consume() completes, every window arrives, and the failed compactions are counted with one warning', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'phargus-persist-perm-')));
    const path = join(dir, 'windows.ndjson');
    const { result, output } = runUnderPermission([path], path);

    expect(result.consumed).toBe('resolved');
    expect(result.windows).toEqual(STARTS);
    expect(result.seen).toEqual(STARTS);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.warnings, output).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/window persistence failed/);
    // Nothing was appended past the cap, and no temp file was left behind.
    expect(statSync(path).size).toBeLessThanOrEqual(MAX_BYTES);
    expect(readdirSync(dir)).toEqual(['windows.ndjson']);
  }, 70_000);

  it('with the documented grant (the file and its .compact.tmp), compaction succeeds and nothing fails', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'phargus-persist-perm-ok-')));
    const path = join(dir, 'windows.ndjson');
    const { result, output } = runUnderPermission([path, `${path}.compact.tmp`], path);

    expect(result.consumed).toBe('resolved');
    expect(result.windows).toEqual(STARTS);
    expect(result.failed, output).toBe(0);
    expect(result.warnings).toEqual([]);
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    const persisted = lines.map((line) => (JSON.parse(line) as { start: number }).start);
    // Compacted to a contiguous tail that ends with the newest window.
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted).toEqual(STARTS.slice(WINDOW_COUNT - persisted.length));
    expect(statSync(path).size).toBeLessThanOrEqual(MAX_BYTES);
    expect(readdirSync(dir)).toEqual(['windows.ndjson']);
  }, 70_000);
});
