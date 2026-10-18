import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// AC-2: `npm run check:exports` (= `node scripts/check-exports.mjs`) is green on the built package and
// red, naming each drifted name with its subpath and format, on a copy whose runtime exports drifted.
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const srcDir = join(repoRoot, 'src');

const SUBPATHS = ['agent', 'collector', 'analyzer', 'dashboard', 'plugin-runner', 'otel'] as const;
const FORMATS = ['import', 'require'] as const;
type Format = (typeof FORMATS)[number];

/** The extra runtime export appended to the copy's ESM dashboard entry. */
const EXTRA_NAME = 'phargusDriftExtra';
/** The runtime export the copy's CommonJS otel entry stops exporting. */
const DROPPED_NAME = 'toOtlpTraces';

const BUILD_TIMEOUT_MS = 170_000;
const LOCK_WAIT_MS = 170_000;
const LOCK_STALE_MS = 300_000;
const LOCK_POLL_MS = 250;
const CHECK_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 300_000;

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

/** Every built file a subpath's `import`/`require` condition names (runtime entry and declarations). */
function requiredDistFiles(): string[] {
  const pkg = readPackageJson();
  const files: string[] = [];
  for (const sub of SUBPATHS) {
    const entry = pkg.exports[`./${sub}`];
    if (entry === undefined || typeof entry === 'string') {
      throw new Error(`package.json exports has no conditional entry for ./${sub}`);
    }
    for (const format of FORMATS) {
      files.push(join(repoRoot, entry[format].default), join(repoRoot, entry[format].types));
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

/** The test's environment without any PHARGUS_* variable. */
function checkEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PHARGUS_')) delete env[key];
  }
  return env;
}

/** `npm run check:exports` is `node scripts/check-exports.mjs`, run with cwd at a package root. */
function runCheckExports(root: string) {
  const result = spawnSync(process.execPath, ['scripts/check-exports.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: checkEnv(),
    timeout: CHECK_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

interface DriftLine {
  format: string;
  specifier: string;
  added: string[];
  missing: string[];
}

function parseNames(list: string): string[] {
  const trimmed = list.trim();
  return trimmed === 'none' ? [] : trimmed.split(/,\s*/);
}

/** The `FAIL <format> <specifier>: … added: <names>; missing: <names>` lines of a run's stderr. */
function driftLines(stderr: string): DriftLine[] {
  const lines: DriftLine[] = [];
  for (const line of stderr.split('\n')) {
    const match = /^FAIL\s+(\S+)\s+(\S+?):.*?\badded: (.*?); missing: (.*?)\s*$/.exec(line);
    if (match === null) continue;
    const [, format = '', specifier = '', added = '', missing = ''] = match;
    lines.push({ format, specifier, added: parseNames(added), missing: parseNames(missing) });
  }
  return lines;
}

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A copy of the built package (package.json, the check script, dist/) in which the ESM dashboard entry
 * gains EXTRA_NAME and the CommonJS otel entry stops exporting DROPPED_NAME.
 */
function driftedCopy(): string {
  const root = mkdtempSync(join(tmpdir(), 'phargus-check-exports-'));
  scratchDirs.push(root);
  copyFileSync(join(repoRoot, 'package.json'), join(root, 'package.json'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(
    join(repoRoot, 'scripts', 'check-exports.mjs'),
    join(root, 'scripts', 'check-exports.mjs'),
  );
  cpSync(join(repoRoot, 'dist'), join(root, 'dist'), { recursive: true });

  appendFileSync(
    join(root, 'dist', 'esm', 'dashboard', 'index.js'),
    `\nexport const ${EXTRA_NAME} = 1;\n`,
  );

  const otelDir = join(root, 'dist', 'cjs', 'otel');
  renameSync(join(otelDir, 'index.js'), join(otelDir, 'index.original.js'));
  writeFileSync(
    join(otelDir, 'index.js'),
    [
      "'use strict';",
      "const original = require('./index.original.js');",
      `const { ${DROPPED_NAME}: _dropped, ...rest } = original;`,
      "Object.defineProperty(exports, '__esModule', { value: true });",
      'Object.assign(exports, rest);',
      '',
    ].join('\n'),
  );
  return root;
}

describe('npm run check:exports', () => {
  it(
    'AC-2: passes on the built package and names added and missing runtime exports per subpath and format on a drifted copy',
    async () => {
      await ensureFreshDist();

      const clean = runCheckExports(repoRoot);
      expect(clean.status, `unmodified run failed:\n${clean.stderr}`).toBe(0);
      expect(driftLines(clean.stderr)).toEqual([]);

      const drifted = runCheckExports(driftedCopy());
      expect(drifted.status).not.toBeNull();
      expect(drifted.status).not.toBe(0);
      const lines = driftLines(drifted.stderr);

      const addedLine = lines.find(
        (l) => l.format === 'import' && l.specifier === '@pharn-dev/phargus/dashboard',
      );
      expect(
        addedLine,
        `no drift line for import @pharn-dev/phargus/dashboard in:\n${drifted.stderr}`,
      ).toBeDefined();
      expect(addedLine?.added).toContain(EXTRA_NAME);
      expect(addedLine?.missing).toEqual([]);

      const missingLine = lines.find(
        (l) => l.format === 'require' && l.specifier === '@pharn-dev/phargus/otel',
      );
      expect(
        missingLine,
        `no drift line for require @pharn-dev/phargus/otel in:\n${drifted.stderr}`,
      ).toBeDefined();
      expect(missingLine?.missing).toContain(DROPPED_NAME);
      expect(missingLine?.added).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
