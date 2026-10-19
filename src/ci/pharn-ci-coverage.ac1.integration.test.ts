import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// AC-1: `npm run test:coverage` exits 0 and writes a git-ignored `coverage/lcov.info` with an `SF:`
// record for every non-test `.ts` file under `src/`, including a file no test imports.
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const srcDir = join(repoRoot, 'src');
const LCOV_FILE = join(repoRoot, 'coverage', 'lcov.info');

/** On Windows, `npm` is a `.cmd` shim; `spawnSync('npm', …)` without this fails with ENOENT. */
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** The source file no test imports: it must still get an `SF:` record. */
const UNIMPORTED_SOURCE = ['src', 'cli', 'bin.ts'].join('/');

/**
 * `npm run test:coverage` runs every test file, this one included. The child run gets this variable
 * set to `1`, and the describe below is skipped when it is, so the child never re-spawns itself.
 */
const CHILD_GUARD = 'PHARGUS_AC1_COVERAGE_CHILD';
const inChildRun = process.env[CHILD_GUARD] === '1';

const SPAWN_TIMEOUT_MS = 450_000;
const TEST_TIMEOUT_MS = 480_000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const OUTPUT_TAIL_CHARS = 4_000;

/** The child's environment: no gate-results path (it would overwrite the parent's), the guard set. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['PHARN_TEST_RESULTS'];
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITEST') || key.startsWith('TINYPOOL')) delete env[key];
  }
  env[CHILD_GUARD] = '1';
  return env;
}

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

/** Every `.ts` file under `src/` that is not a test, as a repo-relative POSIX path. */
function nonTestSources(): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .map((rel) => toPosix(join('src', rel)))
    .filter((rel) => rel.endsWith('.ts') && !rel.endsWith('.test.ts'))
    .filter((rel) => statSync(join(repoRoot, rel)).isFile())
    .sort();
}

/** Every `src/**\/*.test.ts` file, absolute. */
function testFiles(): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.test.ts'))
    .map((rel) => join(srcDir, rel));
}

const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** The test files holding an import specifier that resolves to the unimported source's module. */
function testsImportingUnimportedSource(): string[] {
  const target = join(repoRoot, UNIMPORTED_SOURCE).replace(/\.ts$/, '');
  const hits: string[] = [];
  for (const file of testFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier === undefined || !specifier.startsWith('.')) continue;
        const resolved = resolve(dirname(file), specifier).replace(/\.(js|ts|mjs|cjs)$/, '');
        if (resolved === target || specifier.endsWith('cli/bin.js')) {
          hits.push(toPosix(relative(repoRoot, file)));
        }
      }
    }
  }
  return [...new Set(hits)].sort();
}

/** The `SF:` paths of an lcov report, made repo-relative POSIX paths. */
function lcovSourcePaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('SF:')) continue;
    const raw = line.slice('SF:'.length).trim();
    const abs = isAbsolute(raw) ? raw : join(repoRoot, raw);
    paths.push(toPosix(relative(repoRoot, abs)));
  }
  return paths;
}

function tail(text: string | null | undefined): string {
  if (!text) return '';
  return text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text;
}

describe.skipIf(inChildRun)('npm run test:coverage (pharn-ci coverage input)', () => {
  it(
    'AC-1: exits 0 and writes a git-ignored coverage/lcov.info with an SF record for every non-test src .ts file',
    () => {
      // The premise: no test imports the file the report must still name.
      expect(testsImportingUnimportedSource()).toEqual([]);
      const expected = nonTestSources();
      expect(expected).toContain(UNIMPORTED_SOURCE);

      // A stale report from an earlier run must not satisfy this test.
      rmSync(LCOV_FILE, { force: true });

      const result = spawnSync(NPM_COMMAND, ['run', 'test:coverage'], {
        cwd: repoRoot,
        env: childEnv(),
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
      });
      expect(result.error, String(result.error)).toBeUndefined();
      expect(
        result.status,
        `npm run test:coverage failed\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}`,
      ).toBe(0);

      expect(existsSync(LCOV_FILE)).toBe(true);
      const recorded = new Set(lcovSourcePaths(readFileSync(LCOV_FILE, 'utf8')));
      expect(recorded.has(UNIMPORTED_SOURCE)).toBe(true);
      const missing = expected.filter((rel) => !recorded.has(rel));
      expect(missing).toEqual([]);

      const ignored = spawnSync('git', ['check-ignore', 'coverage/lcov.info'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(ignored.error, String(ignored.error)).toBeUndefined();
      expect(ignored.status).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
