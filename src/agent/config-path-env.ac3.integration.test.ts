import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type ConfigModuleUnderTest = {
  loadAgentConfig(
    cwd: string,
    env: Readonly<Record<string, string | undefined>>,
    options?: { onWarning?: (message: string) => void },
  ): Promise<unknown>;
  PhargusConfigError: new (...args: never[]) => Error;
};

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'phargus-config-path-env-ac3-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// A cwd whose own phargus.config.json is valid, so a fallback to the cwd lookup would resolve.
async function makeCwdWithValidConfig(): Promise<string> {
  const cwd = await makeTempDir();
  await writeFile(
    path.join(cwd, 'phargus.config.json'),
    JSON.stringify({ intervalMs: 333, queueBound: 55 }),
    'utf8',
  );
  return cwd;
}

async function expectPinRejects(cwd: string, pinned: string): Promise<void> {
  const mod = (await import('./index.js')) as unknown as ConfigModuleUnderTest;

  let caught: unknown;
  let resolvedWith: unknown;
  let resolved = false;
  try {
    resolvedWith = await mod.loadAgentConfig(
      cwd,
      { PHARGUS_CONFIG: pinned },
      { onWarning: () => undefined },
    );
    resolved = true;
  } catch (error: unknown) {
    caught = error;
  }

  expect(resolved, `resolved with ${JSON.stringify(resolvedWith)}`).toBe(false);
  expect(caught).toBeInstanceOf(mod.PhargusConfigError);
  expect((caught as Error).message).toContain('PHARGUS_CONFIG');
}

describe('agent config path env — AC-3', () => {
  it('AC-3: an empty PHARGUS_CONFIG rejects with a PhargusConfigError naming PHARGUS_CONFIG', async () => {
    const cwd = await makeCwdWithValidConfig();
    await expectPinRejects(cwd, '');
  });

  it('AC-3: a PHARGUS_CONFIG path that does not exist rejects with a PhargusConfigError naming PHARGUS_CONFIG', async () => {
    const cwd = await makeCwdWithValidConfig();
    await expectPinRejects(cwd, 'missing.json');
  });

  it('AC-3: a PHARGUS_CONFIG path that is a directory (dir.json) rejects with a PhargusConfigError naming PHARGUS_CONFIG', async () => {
    const cwd = await makeCwdWithValidConfig();
    await mkdir(path.join(cwd, 'dir.json'));
    await expectPinRejects(cwd, 'dir.json');
  });

  it('AC-3: a PHARGUS_CONFIG path with an unsupported extension (settings.yaml) rejects with a PhargusConfigError naming PHARGUS_CONFIG', async () => {
    const cwd = await makeCwdWithValidConfig();
    await writeFile(path.join(cwd, 'settings.yaml'), 'intervalMs: 444\n', 'utf8');
    await expectPinRejects(cwd, 'settings.yaml');
  });
});
