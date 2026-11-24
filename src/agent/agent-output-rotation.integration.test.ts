import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const agentDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(agentDir, '..', '..');
const tscPath = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

const INTERVAL_MS = 20;
const MAX_BYTES = 1024;
const DISABLED_PREFIX = '[phargus] agent disabled:';

function agentSources(): string[] {
  return readdirSync(agentDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map((f) => join(agentDir, f));
}

/** Compiles src/agent to CommonJS — what `--require phargus/agent` loads. */
function compileCjs(sources: string[], outDir: string): void {
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
      '--module',
      'CommonJS',
      '--moduleResolution',
      'Node10',
      '--ignoreDeprecations',
      '6.0',
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
      `compiling ${source} (commonjs) failed:\n${result.stdout}\n${result.stderr}`,
    ).toBe(true);
  }
  writeFileSync(join(outDir, '..', 'package.json'), JSON.stringify({ type: 'commonjs' }));
}

/** A private copy of the package named "phargus" (real `exports`), under a realpath'd temp root. */
function buildTempPackage(): string {
  const pkgDir = realpathSync(mkdtempSync(join(tmpdir(), 'phargus-rotation-')));
  const cjsDir = join(pkgDir, 'dist', 'cjs', 'agent');
  mkdirSync(cjsDir, { recursive: true });
  compileCjs(agentSources(), cjsDir);
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
  writeFileSync(join(pkgDir, 'app.cjs'), "setTimeout(() => console.log('app ran'), 600);\n");
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

/** The child's env: the parent's minus every PHARGUS_* name and NODE_OPTIONS. */
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

function runChild(
  flags: string[],
  output: string,
  maxBytes: string,
): SpawnSyncReturns<string> & { disabled: string[] } {
  const root = tempPackage();
  const child = spawnSync(
    process.execPath,
    [...flags, '--require', 'phargus/agent', join(root, 'app.cjs')],
    {
      cwd: root,
      env: childEnv({
        PHARGUS_OUTPUT: output,
        PHARGUS_INTERVAL_MS: String(INTERVAL_MS),
        PHARGUS_OUTPUT_MAX_BYTES: maxBytes,
      }),
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  expect(child.error, `child failed to run: ${String(child.error)}`).toBeUndefined();
  expect(child.signal, `child was killed:\n${child.stderr}`).toBeNull();
  expect(child.status, `child exit code; stderr:\n${child.stderr}`).toBe(0);
  expect(child.stdout).toContain('app ran');
  const disabled = child.stderr.split('\n').filter((l) => l.startsWith(DISABLED_PREFIX));
  return { ...child, disabled };
}

function outDir(name: string): string {
  const dir = join(tempPackage(), name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  return dir;
}

function jsonLines(file: string): unknown[] {
  const text = readFileSync(file, 'utf8');
  expect(text.endsWith('\n'), `${file} ends with a whole line`).toBe(true);
  return text
    .slice(0, -1)
    .split('\n')
    .map((l) => JSON.parse(l) as unknown);
}

describe('phargus/agent output file size bound in a real process', () => {
  it('under --permission with read and write grants, the agent rotates <file> to <file>.1 and stays enabled; the new file has mode 0600', () => {
    const root = tempPackage();
    const dir = outDir('granted');
    const file = join(dir, 'out.ndjson');
    const child = runChild(
      ['--permission', `--allow-fs-read=${root}`, `--allow-fs-write=${dir}`],
      file,
      String(MAX_BYTES),
    );

    expect(child.disabled, `stderr:\n${child.stderr}`).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['out.ndjson', 'out.ndjson.1']);
    expect(jsonLines(`${file}.1`).length).toBeGreaterThan(0);
    expect(jsonLines(file).length).toBeGreaterThan(0);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  }, 300_000);

  it('under --permission without a write grant for <file>.1, the agent is disabled with one line naming it', () => {
    const root = tempPackage();
    const dir = outDir('file-only');
    const file = join(dir, 'out.ndjson');
    const child = runChild(
      ['--permission', `--allow-fs-read=${root}`, `--allow-fs-write=${file}`],
      file,
      String(MAX_BYTES),
    );

    expect(child.disabled, `stderr:\n${child.stderr}`).toHaveLength(1);
    expect(child.disabled[0]).toContain('fs.write');
    expect(child.disabled[0]).toContain(`${file}.1`);
    expect(existsSync(file)).toBe(false);
  }, 300_000);

  it('a failed rename disables the agent with one "[phargus] agent disabled:" line', () => {
    const dir = outDir('rename-fails');
    const file = join(dir, 'out.ndjson');
    mkdirSync(join(`${file}.1`, 'keep'), { recursive: true });
    const child = runChild([], file, String(MAX_BYTES));

    expect(child.disabled, `stderr:\n${child.stderr}`).toHaveLength(1);
    expect(child.disabled[0]).toContain(`cannot rotate ${file} to ${file}.1`);
  }, 300_000);

  it('an invalid PHARGUS_OUTPUT_MAX_BYTES disables the agent with one line naming the variable', () => {
    const dir = outDir('invalid');
    const file = join(dir, 'out.ndjson');
    const child = runChild([], file, 'lots');

    expect(child.disabled, `stderr:\n${child.stderr}`).toHaveLength(1);
    expect(child.disabled[0]).toContain('PHARGUS_OUTPUT_MAX_BYTES');
    expect(existsSync(file)).toBe(false);
  }, 300_000);
});
