import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// The plugin runner finds its sandbox child next to its own module. An install path with "(", ")"
// and a space (a "proj (copy)" or "Dropbox (Company)" folder) must not change where it looks.

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const distBuilt = ['esm', 'cjs'].every((format) =>
  existsSync(join(repoRoot, 'dist', format, 'plugin-runner', 'index.js')),
);

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'phargus-install-path-')));
const pkgDir = join(tempRoot, 'proj (copy)');
mkdirSync(pkgDir);
// The sandbox child imports `isolated-vm` by name, so give the copied tree a node_modules to find it in.
mkdirSync(join(tempRoot, 'node_modules'));
symlinkSync(
  join(repoRoot, 'node_modules', 'isolated-vm'),
  join(tempRoot, 'node_modules', 'isolated-vm'),
  'junction',
);

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const RUN_SCRIPT = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const [entry, format] = process.argv.slice(2);
const mod = format === 'cjs' ? createRequire(import.meta.url)(entry) : await import(pathToFileURL(entry).href);
const runner = mod.createPluginRunner();
try {
  console.log(JSON.stringify(await runner.run('return []', [])));
} finally {
  await runner.close();
}
`;
const runScript = join(tempRoot, 'run.mjs');
writeFileSync(runScript, RUN_SCRIPT);

/** Copies one build into the package directory and returns its plugin-runner entry. */
function copyBuild(format: 'esm' | 'cjs', target: string): string {
  cpSync(join(repoRoot, 'dist', format), join(pkgDir, target), { recursive: true });
  return join(pkgDir, target, 'plugin-runner', 'index.js');
}

/** Runs `createPluginRunner().run('return []', [])` from a built entry in a plain node process. */
function runBuilt(entry: string, format: 'esm' | 'cjs'): unknown {
  const result = spawnSync(process.execPath, [runScript, entry, format], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.status, `run.mjs failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout.trim()) as unknown;
}

describe('plugin runner under an install path with parentheses and a space', () => {
  it('from source (sandbox child under type stripping), a rule runs', async () => {
    const srcDir = join(pkgDir, 'src');
    for (const module of ['plugin-runner', 'shared']) {
      cpSync(join(repoRoot, 'src', module), join(srcDir, module), {
        recursive: true,
        filter: (path) => !path.endsWith('.test.ts'),
      });
    }
    writeFileSync(join(srcDir, 'package.json'), JSON.stringify({ type: 'module' }));
    const mod = (await import(
      pathToFileURL(join(srcDir, 'plugin-runner', 'index.ts')).href
    )) as typeof import('./index.js');
    const runner = mod.createPluginRunner();
    try {
      expect(await runner.run('return []', [])).toEqual({ ok: true, findings: [] });
    } finally {
      await runner.close();
    }
  }, 30_000);

  describe.skipIf(!distBuilt)('from dist/ (skipped until `npm run build` has built it)', () => {
    it('from the ESM build, a rule runs', () => {
      expect(runBuilt(copyBuild('esm', 'esm'), 'esm')).toEqual({ ok: true, findings: [] });
    }, 30_000);

    it('from the CJS build, a rule runs', () => {
      expect(runBuilt(copyBuild('cjs', 'cjs'), 'cjs')).toEqual({ ok: true, findings: [] });
    }, 30_000);

    it('with the child script missing, the error names the path looked for inside the package', () => {
      const entry = copyBuild('esm', 'esm-missing-child');
      const workersDir = join(dirname(entry), 'workers');
      rmSync(join(workersDir, 'sandbox-child.js'));
      const result = runBuilt(entry, 'esm') as { ok: boolean; error?: { message: string } };
      expect(result.ok).toBe(false);
      const lookedFor = /looked for (.+?sandbox-child\.js) and /.exec(
        result.error?.message ?? '',
      )?.[1];
      expect(lookedFor, `message: ${result.error?.message}`).toBeDefined();
      // Compare real paths: a temp dir may be reached through a symlink or a Windows short name.
      expect(realpathSync.native(dirname(lookedFor ?? ''))).toBe(realpathSync.native(workersDir));
    }, 30_000);
  });
});
