import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// AC-3: docs/API.md names every runtime export and declared type of each built subpath and says the
// rest is internal; the README Documentation table links it; CHANGELOG [Unreleased] records the cut.
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const srcDir = join(repoRoot, 'src');

const SUBPATHS = ['agent', 'collector', 'analyzer', 'dashboard', 'plugin-runner', 'otel'] as const;
type Subpath = (typeof SUBPATHS)[number];
const FORMATS = ['import', 'require'] as const;
type Format = (typeof FORMATS)[number];

/** Every name AC-1 removes, runtime and type, the four placeholder types included. */
const REMOVED_NAMES = [
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
  'SpanExport',
  'HttpTracingOptions',
  'SpanDrain',
  'WindowAggregatorOptions',
  'PhargusAgentPlaceholder',
  'CollectorPlaceholder',
  'DashboardPlaceholder',
  'PluginRunnerPlaceholder',
];

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
  const mod = format === 'import' ? await import(specifier) : requireFromRoot(specifier);
  result[sub] = Object.keys(mod).sort();
}
process.stdout.write('\\n' + ${JSON.stringify(RESULT_MARK)} + JSON.stringify(result) + '\\n');
`;

/** Loads every subpath through one format in a child process and returns each module's own keys. */
function runtimeExports(format: Format): Record<Subpath, string[]> {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE_SOURCE], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: probeEnv(format),
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${format} probe exited ${String(result.status)}:\n${result.stderr}`);
  }
  const line = result.stdout.split('\n').find((l) => l.startsWith(RESULT_MARK));
  if (line === undefined) {
    throw new Error(`${format} probe printed no result line:\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(line.slice(RESULT_MARK.length)) as Record<Subpath, string[]>;
}

/** Per subpath, every name its `import` and `require` declaration files export (re-exports followed). */
function declarationExports(): Map<Subpath, Set<string>> {
  const pkg = readPackageJson();
  const filesBySub = new Map<Subpath, string[]>();
  for (const sub of SUBPATHS) {
    filesBySub.set(
      sub,
      FORMATS.map((format) => join(repoRoot, conditionTarget(pkg, sub, format).types)),
    );
  }
  const program = ts.createProgram([...filesBySub.values()].flat(), {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const bySub = new Map<Subpath, Set<string>>();
  for (const [sub, files] of filesBySub) {
    const names = new Set<string>();
    for (const file of files) {
      const sourceFile = program.getSourceFile(file);
      if (sourceFile === undefined) throw new Error(`TypeScript could not read ${file}`);
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (moduleSymbol === undefined) throw new Error(`${file} is not a module`);
      for (const symbol of checker.getExportsOfModule(moduleSymbol)) names.add(symbol.getName());
    }
    bySub.set(sub, names);
  }
  return bySub;
}

/** Per subpath, every runtime export (both formats) and every declared export of the built package. */
async function supportedNames(): Promise<Map<Subpath, string[]>> {
  await ensureFreshDist();
  const declared = declarationExports();
  const runtime = FORMATS.map((format) => runtimeExports(format));
  const bySub = new Map<Subpath, string[]>();
  for (const sub of SUBPATHS) {
    const names = new Set(declared.get(sub));
    for (const keys of runtime) for (const key of keys[sub]) names.add(key);
    bySub.set(sub, [...names].sort());
  }
  return bySub;
}

/** The lines from the heading that names `@pharn-dev/phargus/<sub>` up to the next `## ` heading. */
function apiSection(doc: string, sub: Subpath): string | undefined {
  const lines = doc.split('\n');
  const specifier = `@pharn-dev/phargus/${sub}`;
  const start = lines.findIndex(
    (line) => /^#{1,6}\s/.test(line) && line.includes(specifier) && !line.includes(`${specifier}-`),
  );
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

/** The text from `heading` (a line equal to it) up to the next line `isEnd` accepts. */
function sectionOf(text: string, heading: string, isEnd: (line: string) => boolean): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(isEnd);
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('the public API documentation', () => {
  it(
    'AC-3: docs/API.md has a section per subpath naming every runtime export and declared type, and says the rest is internal',
    async () => {
      const names = await supportedNames();
      const doc = readFileSync(join(repoRoot, 'docs', 'API.md'), 'utf8');
      expect(doc).toMatch(/not listed[^.]*internal/i);
      for (const sub of SUBPATHS) {
        const section = apiSection(doc, sub);
        expect(section, `docs/API.md has no heading for @pharn-dev/phargus/${sub}`).toBeDefined();
        const unnamed = (names.get(sub) ?? []).filter((name) => !section?.includes(`\`${name}\``));
        expect(unnamed, `the @pharn-dev/phargus/${sub} section of docs/API.md misses`).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it('AC-3: the README Documentation table links docs/API.md', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    const documentation = sectionOf(
      readme,
      '## Documentation',
      (line) => line.startsWith('## ') || line.trim() === '---',
    );
    const tableRows = documentation.split('\n').filter((line) => line.trim().startsWith('|'));
    expect(tableRows.some((row) => /\]\((?:\.\/)?docs\/API\.md\)/.test(row))).toBe(true);
  });

  it('AC-3: CHANGELOG [Unreleased] has a Removed subsection naming every removed name and calling it breaking', () => {
    const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
    const unreleased = sectionOf(changelog, '## [Unreleased]', (line) => line.startsWith('## ['));
    const removed = sectionOf(
      unreleased,
      '### Removed',
      (line) => line.startsWith('### ') || line.startsWith('## '),
    );
    expect(removed, 'CHANGELOG [Unreleased] has no ### Removed subsection').not.toBe('');
    expect(removed).toMatch(/\bbreaking\b/i);
    const unnamed = REMOVED_NAMES.filter((name) => !removed.includes(`\`${name}\``));
    expect(unnamed, 'CHANGELOG [Unreleased] ### Removed misses').toEqual([]);
  });
});
