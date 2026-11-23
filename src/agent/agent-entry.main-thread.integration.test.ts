import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const agentDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(agentDir, '..', '..');
const tscPath = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

const INTERVAL_MS = 50;
const WORKERS = 3;

function agentSources(): string[] {
  return readdirSync(agentDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map((f) => join(agentDir, f));
}

function compile(sources: string[], outDir: string, moduleArgs: string[], type: string): void {
  const result = spawnSync(
    process.execPath,
    [
      tscPath,
      // TS 6 refuses command-line files while a tsconfig.json is present (TS5112).
      '--ignoreConfig',
      '--outDir',
      outDir,
      '--rootDir',
      agentDir,
      ...moduleArgs,
      '--target',
      'ES2022',
      '--skipLibCheck',
      '--types',
      'node',
      '--declaration',
      'false',
      '--sourceMap',
      'false',
      ...sources,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  );
  for (const source of sources) {
    const emitted = join(outDir, basename(source).replace(/\.ts$/, '.js'));
    expect(
      existsSync(emitted),
      `compiling ${source} (${type}) failed:\n${result.stdout}\n${result.stderr}`,
    ).toBe(true);
  }
  writeFileSync(join(outDir, '..', 'package.json'), JSON.stringify({ type }));
}

/** A private copy of the package: both builds of src/agent and the real `exports`, named "phargus". */
function buildTempPackage(): string {
  const pkgDir = mkdtempSync(join(tmpdir(), 'phargus-entry-main-thread-'));
  const sources = agentSources();
  const esmDir = join(pkgDir, 'dist', 'esm', 'agent');
  const cjsDir = join(pkgDir, 'dist', 'cjs', 'agent');
  mkdirSync(esmDir, { recursive: true });
  mkdirSync(cjsDir, { recursive: true });
  compile(sources, esmDir, ['--module', 'NodeNext', '--moduleResolution', 'NodeNext'], 'module');
  compile(
    sources,
    cjsDir,
    ['--module', 'CommonJS', '--moduleResolution', 'Node10', '--ignoreDeprecations', '6.0'],
    'commonjs',
  );
  const realPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    exports: unknown;
  };
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: 'phargus',
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: realPkg.exports,
    }),
  );
  return pkgDir;
}

let pkgDir: string | undefined;
function tempPackage(): string {
  pkgDir ??= buildTempPackage();
  return pkgDir;
}

afterAll(() => {
  if (pkgDir !== undefined) {
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

/** The child's env: the parent's minus every PHARGUS_* name (an unknown one warns on stderr). */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.startsWith('PHARGUS_') || name === 'NODE_OPTIONS') {
      continue;
    }
    env[name] = value;
  }
  return { ...env, ...extra };
}

/** What a thread reports about the agent's prototype patches in its own isolate. */
const PATCH_PROBE = [
  "import http from 'node:http';",
  "import { Writable } from 'node:stream';",
  'function patches() {',
  '  return {',
  "    emitOwn: Object.hasOwn(http.Server.prototype, 'emit'),",
  "    writeWrapped: Symbol.for('phargus.backpressure.write') in Writable.prototype.write,",
  '  };',
  '}',
].join('\n');

const WORKER = [
  "import { parentPort, workerData } from 'node:worker_threads';",
  PATCH_PROBE,
  '// Report after a few intervals, by when a started agent would have patched and sampled.',
  'setTimeout(() => parentPort.postMessage(patches()), workerData * 3);',
  '// Stay alive until the main thread terminates this worker.',
  'setInterval(() => {}, 1000);',
  '',
].join('\n');

const APP = [
  "import { Worker } from 'node:worker_threads';",
  PATCH_PROBE,
  'const intervalMs = Number(process.argv[2]);',
  `const workers = Array.from({ length: ${String(WORKERS)} }, () =>`,
  "  new Worker(new URL('./main-thread-worker.mjs', import.meta.url), { workerData: intervalMs }),",
  ');',
  'const reports = await Promise.all(',
  '  workers.map((w) => new Promise((ok, fail) => { w.once("message", ok); w.once("error", fail); })),',
  ');',
  '// Let every live thread sample for about ten intervals.',
  'await new Promise((r) => setTimeout(r, intervalMs * 10));',
  'const main = patches();',
  'await Promise.all(workers.map((w) => w.terminate()));',
  'process.stdout.write(JSON.stringify({ pid: process.pid, main, workers: reports }));',
  '',
].join('\n');

type Patches = { emitOwn: boolean; writeWrapped: boolean };
type AppReport = { pid: number; main: Patches; workers: Patches[] };

function runChild(
  dir: string,
  preload: '--require' | '--import',
  outFile: string,
): SpawnSyncReturns<string> {
  writeFileSync(join(dir, 'main-thread-worker.mjs'), WORKER);
  const app = join(dir, 'main-thread-app.mjs');
  writeFileSync(app, APP);
  return spawnSync(process.execPath, [preload, 'phargus/agent', app, String(INTERVAL_MS)], {
    cwd: dir,
    env: childEnv({ PHARGUS_OUTPUT: outFile, PHARGUS_INTERVAL_MS: String(INTERVAL_MS) }),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function expectOneAgent(preload: '--require' | '--import'): void {
  const dir = tempPackage();
  const outFile = join(dir, `main-thread${preload}.ndjson`);
  rmSync(outFile, { force: true });
  const child = runChild(dir, preload, outFile);
  expect(child.error, `child failed to run: ${String(child.error)}`).toBeUndefined();
  expect(child.status, `child exited non-zero:\n${child.stderr}`).toBe(0);
  expect(child.stderr).toBe('');

  const report = JSON.parse(child.stdout) as AppReport;
  // The main thread is patched, so the probe can tell a patched isolate from a clean one.
  expect(report.main).toEqual({ emitOwn: true, writeWrapped: true });
  expect(report.workers).toEqual(
    Array.from({ length: WORKERS }, () => ({ emitOwn: false, writeWrapped: false })),
  );

  const lines = readFileSync(outFile, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { timestamp: number; pid: unknown });
  expect(lines.length, 'the main thread sampled for about ten intervals').toBeGreaterThanOrEqual(5);
  for (const line of lines) {
    expect(Number.isInteger(line.pid), `integer pid in ${JSON.stringify(line)}`).toBe(true);
    expect(line.pid).toBe(report.pid);
  }
  // One sampler writes one line per interval: in order, never two within half an interval.
  for (let i = 1; i < lines.length; i += 1) {
    const gap = lines[i]!.timestamp - lines[i - 1]!.timestamp;
    expect(
      gap,
      `gap between sample lines ${String(i - 1)} and ${String(i)}`,
    ).toBeGreaterThanOrEqual(INTERVAL_MS / 2);
  }
}

describe('phargus/agent preload with worker threads', () => {
  it('node --import phargus/agent (ESM build) with 3 worker threads writes one sample line per interval, each with the process pid, and leaves the workers unpatched', () => {
    expectOneAgent('--import');
  }, 300_000);

  it('node --require phargus/agent (CJS build) with 3 worker threads writes one sample line per interval, each with the process pid, and leaves the workers unpatched', () => {
    expectOneAgent('--require');
  }, 300_000);
});
