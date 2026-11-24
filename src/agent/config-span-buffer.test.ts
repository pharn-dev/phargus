import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultAgentConfig } from './config-schema.js';
import { loadAgentConfig } from './config.js';

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'phargus-config-span-buffer-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const quiet = { onWarning: (): undefined => undefined };

describe('agent config — spanBuffer / PHARGUS_SPAN_BUFFER (CORE-275)', () => {
  it('defaults to 1024', async () => {
    const config = await loadAgentConfig(await makeTempDir(), {}, quiet);
    expect(defaultAgentConfig.spanBuffer).toBe(1024);
    expect(config.spanBuffer).toBe(1024);
  });

  it('reads PHARGUS_SPAN_BUFFER from 0 to 65536', async () => {
    const cwd = await makeTempDir();
    for (const value of [0, 1, 64, 65_536]) {
      const config = await loadAgentConfig(cwd, { PHARGUS_SPAN_BUFFER: String(value) }, quiet);
      expect(config.spanBuffer).toBe(value);
    }
  });

  it('rejects an invalid PHARGUS_SPAN_BUFFER with a message naming the variable', async () => {
    const cwd = await makeTempDir();
    for (const value of ['65537', '-1', '1.5', 'lots', '']) {
      await expect(
        loadAgentConfig(cwd, { PHARGUS_SPAN_BUFFER: value }, quiet),
        `PHARGUS_SPAN_BUFFER=${value}`,
      ).rejects.toThrow(/^phargus config: PHARGUS_SPAN_BUFFER: spanBuffer: /);
    }
  });

  it('reads spanBuffer from phargus.config.json, and the variable wins over the file', async () => {
    const cwd = await makeTempDir();
    await writeFile(path.join(cwd, 'phargus.config.json'), JSON.stringify({ spanBuffer: 0 }));
    expect((await loadAgentConfig(cwd, {}, quiet)).spanBuffer).toBe(0);
    expect((await loadAgentConfig(cwd, { PHARGUS_SPAN_BUFFER: '64' }, quiet)).spanBuffer).toBe(64);
  });

  it('rejects an invalid spanBuffer in the config file, naming the file and the key', async () => {
    const cwd = await makeTempDir();
    for (const value of [65_537, -1, 2.5, '64', null]) {
      await writeFile(path.join(cwd, 'phargus.config.json'), JSON.stringify({ spanBuffer: value }));
      await expect(loadAgentConfig(cwd, {}, quiet), JSON.stringify(value)).rejects.toThrow(
        /^phargus config: phargus\.config\.json: spanBuffer: expected an integer from 0 to 65536/,
      );
    }
  });
});
