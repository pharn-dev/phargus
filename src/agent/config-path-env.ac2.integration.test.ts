import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type AgentConfigUnderTest = Readonly<{
  intervalMs: number;
  output: string;
  queueBound: number;
  enabled: boolean;
}>;

type ConfigModuleUnderTest = {
  loadAgentConfig(
    cwd: string,
    env: Readonly<Record<string, string | undefined>>,
    options?: { onWarning?: (message: string) => void },
  ): Promise<AgentConfigUnderTest>;
  defaultAgentConfig: AgentConfigUnderTest;
};

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'phargus-config-path-env-ac2-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('agent config path env — AC-2', () => {
  it('AC-2: PHARGUS_CONFIG pins a .json file and resolves even though the cwd holds both phargus.config.json and phargus.config.js, which is then not even warned about', async () => {
    const { loadAgentConfig, defaultAgentConfig } =
      (await import('./config.js')) as unknown as ConfigModuleUnderTest;

    const cwd = await makeTempDir();
    await writeFile(
      path.join(cwd, 'phargus.config.json'),
      JSON.stringify({ intervalMs: 111 }),
      'utf8',
    );
    await writeFile(
      path.join(cwd, 'phargus.config.js'),
      'module.exports = { intervalMs: 222 };\n',
      'utf8',
    );
    await mkdir(path.join(cwd, 'pinned'));
    await writeFile(
      path.join(cwd, 'pinned', 'custom.json'),
      JSON.stringify({ queueBound: 4321 }),
      'utf8',
    );

    const warnings: string[] = [];
    const config = await loadAgentConfig(
      cwd,
      { PHARGUS_CONFIG: 'pinned/custom.json' },
      { onWarning: (message) => warnings.push(message) },
    );

    expect(config.queueBound).toBe(4321);
    expect({ ...config }).toEqual({ ...defaultAgentConfig, queueBound: 4321 });
    expect(warnings).toEqual([]);
  });
});
