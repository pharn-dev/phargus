import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// AC-1: the built package's six subpaths load through `import` and `require`, none of them exposes a
// removed wiring internal at runtime or in its declarations, and the supported names stay.
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const srcDir = join(repoRoot, 'src');

const SUBPATHS = ['agent', 'collector', 'analyzer', 'dashboard', 'plugin-runner', 'otel'] as const;
type Subpath = (typeof SUBPATHS)[number];
const FORMATS = ['import', 'require'] as const;
type Format = (typeof FORMATS)[number];

const REMOVED_RUNTIME = [
  'encodeNdjsonLine',
  'createSpanExport',
  'enable',
  'disable',
  'drainSpans',
  'DEFAULT_SPAN_BUFFER_SIZE',
  'toSpanRecord',
  'isSpanRecord',
  'createWindowAggregator',
  'createSpanRouter',
  'parseWindowLine',
  'serializeWindow',
];
const REMOVED_TYPES = [
  'SpanExport',
  'HttpTracingOptions',
  'SpanDrain',
  'WindowAggregatorOptions',
  'PhargusAgentPlaceholder',
  'CollectorPlaceholder',
  'DashboardPlaceholder',
  'PluginRunnerPlaceholder',
];
const KEPT_AGENT_RUNTIME = [
  'SPAN_RECORD_TYPE',
  'currentTraceId',
  'runWithTrace',
  'createNdjsonExporter',
  'createSamplerController',
];
const KEPT_COLLECTOR_RUNTIME = ['createCollector', 'createWindowStore', 'createNdjsonDecoder'];
const KEPT_AGENT_TYPES = ['SpanRecord', 'AgentSampleLine', 'AgentLossCounters', 'TraceSpan'];

const BUILD_TIMEOUT_MS = 170_000;
const LOCK_WAIT_MS = 170_000;
const LOCK_STALE_MS = 300_000;
const LOCK_POLL_MS = 250;
const PROBE_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 240_000;

// The same cross-process lock directory the src/cli tests use, so parallel suites build dist/ once.
const lockDir = join(
  tmpdir(),
  `phargus-dist-build-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 16)}.lock`,
);

interface ConditionTarget {
  types: string;
  default: string;
}
interface PackageJson {
  exports: Record<string, Record<Format, ConditionTarget> | string>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
}

function conditionTarget(pkg: PackageJson, sub: Subpath, format: Format): ConditionTarget {
  const entry = pkg.exports[`./${sub}`];
  if (entry === undefined || typeof entry === 'string') {
    throw new Error(`package.json exports has no conditional entry for ./${sub}`);
  }
  return entry[format];
}

/** Every built file a subpath's `import`/`require` condition names (runtime entry and declarations). */
function requiredDistFiles(): string[] {
  const pkg = readPackageJson();
  const files: string[] = [];
  for (const sub of SUBPATHS) {
    for (const format of FORMATS) {
      const target = conditionTarget(pkg, sub, format);
      files.push(join(repoRoot, target.default), join(repoRoot, target.types));
    }
  }
  return files;
}

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

/** The oldest mtime of the required dist files, or undefined when any of them is missing. */
function oldestDistMtimeMs(): number | undefined {
  let oldest = Number.POSITIVE_INFINITY;
  for (const file of requiredDistFiles()) {
    try {
      oldest = Math.min(oldest, statSync(file).mtimeMs);
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return undefined;
      throw err;
    }
  }
  return oldest;
}

function distIsFresh(): boolean {
  const oldestDist = oldestDistMtimeMs();
  return oldestDist !== undefined && newestSourceMtimeMs(srcDir) <= oldestDist;
}

function lockIsStale(): boolean {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

async function withBuildLock(fn: () => void): Promise<void> {
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
    fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function buildDist(): void {
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: BUILD_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `node scripts/build.mjs failed (status ${String(result.status)}, signal ${String(result.signal)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

async function ensureFreshDist(): Promise<void> {
  if (distIsFresh()) return;
  await withBuildLock(() => {
    if (!distIsFresh()) buildDist();
  });
}

/** The test's environment without any PHARGUS_* variable, with the agent's output turned off. */
function probeEnv(format: Format): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PHARGUS_')) delete env[key];
  }
  env['PHARGUS_OUTPUT'] = 'none';
  env['PROBE_FORMAT'] = format;
  env['PROBE_SUBPATHS'] = JSON.stringify(SUBPATHS);
  return env;
}

const RESULT_MARK = 'PHARGUS_API_PROBE_RESULT ';

// Runs at the repo root so `@pharn-dev/phargus/<subpath>` resolves by package self-reference.
const PROBE_SOURCE = `
import { createRequire } from 'node:module';
import { join } from 'node:path';
const format = process.env.PROBE_FORMAT;
const subpaths = JSON.parse(process.env.PROBE_SUBPATHS);
const requireFromRoot = createRequire(join(process.cwd(), 'package.json'));
const result = {};
for (const sub of subpaths) {
  const specifier = '@pharn-dev/phargus/' + sub;
  try {
    const mod = format === 'import' ? await import(specifier) : requireFromRoot(specifier);
    result[sub] = { ok: true, keys: Object.keys(mod).sort() };
  } catch (err) {
    result[sub] = { ok: false, error: String((err && err.stack) || err) };
  }
}
process.stdout.write('\\n' + ${JSON.stringify(RESULT_MARK)} + JSON.stringify(result) + '\\n');
`;

type ProbeEntry = { ok: true; keys: string[] } | { ok: false; error: string };

/** Loads every subpath through one format in a child process and returns each module's own keys. */
function probeRuntime(format: Format): Record<Subpath, ProbeEntry> {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE_SOURCE], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: probeEnv(format),
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  expect(
    result.status,
    `${format} probe exited ${String(result.status)} (signal ${String(result.signal)}):\n${result.stderr}`,
  ).toBe(0);
  const line = result.stdout.split('\n').find((l) => l.startsWith(RESULT_MARK));
  if (line === undefined) {
    throw new Error(`${format} probe printed no result line:\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(line.slice(RESULT_MARK.length)) as Record<Subpath, ProbeEntry>;
}

/** The names each subpath's declaration file exports, following `export *` and re-exports. */
function declarationExports(): Map<string, string[]> {
  const pkg = readPackageJson();
  const files: string[] = [];
  for (const sub of SUBPATHS) {
    for (const format of FORMATS)
      files.push(join(repoRoot, conditionTarget(pkg, sub, format).types));
  }
  const program = ts.createProgram(files, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const byFile = new Map<string, string[]>();
  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) throw new Error(`TypeScript could not read ${file}`);
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol === undefined) throw new Error(`${file} is not a module`);
    byFile.set(
      file,
      checker
        .getExportsOfModule(moduleSymbol)
        .map((s) => s.getName())
        .sort(),
    );
  }
  return byFile;
}

describe('the public API surface of the built package', () => {
  it(
    'AC-1: every subpath loads through import and require, exposes no removed runtime name, and keeps the supported ones',
    async () => {
      await ensureFreshDist();
      for (const format of FORMATS) {
        const probe = probeRuntime(format);
        for (const sub of SUBPATHS) {
          const entry = probe[sub];
          expect(entry, `${format} @pharn-dev/phargus/${sub} was not probed`).toBeDefined();
          if (!entry.ok) {
            throw new Error(`${format} @pharn-dev/phargus/${sub} failed to load:\n${entry.error}`);
          }
          const exposed = REMOVED_RUNTIME.filter((name) => entry.keys.includes(name));
          expect(exposed, `${format} @pharn-dev/phargus/${sub} still exposes`).toEqual([]);
        }
        const agent = probe.agent;
        const collector = probe.collector;
        if (!agent.ok || !collector.ok)
          throw new Error(`${format} agent or collector did not load`);
        expect(
          KEPT_AGENT_RUNTIME.filter((name) => !agent.keys.includes(name)),
          `${format} @pharn-dev/phargus/agent lost`,
        ).toEqual([]);
        expect(
          KEPT_COLLECTOR_RUNTIME.filter((name) => !collector.keys.includes(name)),
          `${format} @pharn-dev/phargus/collector lost`,
        ).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "AC-1: no subpath's declarations export a removed type, and the agent's keep the wire-format types",
    async () => {
      await ensureFreshDist();
      const pkg = readPackageJson();
      const exportsByFile = declarationExports();
      for (const sub of SUBPATHS) {
        for (const format of FORMATS) {
          const file = join(repoRoot, conditionTarget(pkg, sub, format).types);
          const names = exportsByFile.get(file);
          if (names === undefined) throw new Error(`no declaration exports read for ${file}`);
          const exposed = [...REMOVED_TYPES, ...REMOVED_RUNTIME].filter((n) => names.includes(n));
          expect(exposed, `${format} types of @pharn-dev/phargus/${sub} still export`).toEqual([]);
          if (sub === 'agent') {
            expect(
              KEPT_AGENT_TYPES.filter((n) => !names.includes(n)),
              `${format} types of @pharn-dev/phargus/agent lost`,
            ).toEqual([]);
          }
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
