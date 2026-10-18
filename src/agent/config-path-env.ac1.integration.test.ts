import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type AgentConfigUnderTest = Readonly<Record<string, unknown>> &
  Readonly<{
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
};

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'phargus-config-path-env-ac1-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('agent config path env — AC-1', () => {
  it('AC-1: PHARGUS_CONFIG pins a .json file whose values win over the cwd file, with a relative output resolved against the cwd, no PHARGUS_CONFIG key and no warning', async () => {
    const { loadAgentConfig } = (await import('./index.js')) as unknown as ConfigModuleUnderTest;

    const cwd = await makeTempDir();
    await writeFile(
      path.join(cwd, 'phargus.config.json'),
      JSON.stringify({ intervalMs: 250 }),
      'utf8',
    );
    await mkdir(path.join(cwd, 'pinned'));
    await writeFile(
      path.join(cwd, 'pinned', 'custom.json'),
      JSON.stringify({ intervalMs: 750, output: 'out/agent.ndjson' }),
      'utf8',
    );

    const warnings: string[] = [];
    const config = await loadAgentConfig(
      cwd,
      { PHARGUS_CONFIG: 'pinned/custom.json' },
      { onWarning: (message) => warnings.push(message) },
    );

    expect(config.intervalMs).toBe(750);
    expect(config.output).toBe(path.join(cwd, 'out/agent.ndjson'));
    expect(config.output).not.toBe(path.join(cwd, 'pinned', 'out/agent.ndjson'));
    expect(Object.keys(config).filter((key) => key.includes('PHARGUS_CONFIG'))).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
