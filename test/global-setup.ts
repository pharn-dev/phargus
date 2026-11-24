// Vitest globalSetup: builds dist/ once, before any test file runs, when it is missing or older than
// a non-test source under src/. Integration tests spawn the built CLI, the examples and the package
// entry points, and none of them builds on its own, so no build lock is needed.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
// scripts/build.mjs deletes dist/ first and writes this file only after both tsc runs succeed, so its
// mtime is when the last complete build finished.
const BUILD_STAMP = join(repoRoot, 'dist', 'cjs', 'package.json');

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
  let built: number;
  try {
    built = statSync(BUILD_STAMP).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  return newestSourceMtimeMs(join(repoRoot, 'src')) <= built;
}

export default function setup(): void {
  if (distIsFresh()) return;
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `node scripts/build.mjs failed (status ${String(result.status)}, signal ${String(result.signal)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}
