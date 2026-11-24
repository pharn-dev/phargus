import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultAgentConfig, loadAgentConfig } from './config.js';

const VALID_NAMES =
  'PHARGUS_INTERVAL_MS, PHARGUS_OUTPUT, PHARGUS_OUTPUT_MAX_BYTES, PHARGUS_QUEUE_BOUND, PHARGUS_ENABLED, PHARGUS_SPAN_BUFFER, PHARGUS_CONFIG';

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'phargus-config-unknown-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('agent config — unknown PHARGUS_* variables (F-09)', () => {
  it('warns once per unknown variable, naming it, and ignores it', async () => {
    const cwd = await makeTempDir();
    const warnings: string[] = [];
    const config = await loadAgentConfig(
      cwd,
      { PHARGUS_FOO: '1', PHARGUS_INTERVAL_MS: '250' },
      { onWarning: (message) => warnings.push(message) },
    );
    expect(config).toEqual({ ...defaultAgentConfig, intervalMs: 250 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('PHARGUS_FOO');
    expect(warnings[0]).not.toContain('did you mean');
  });

  it('lists the valid variable names, not a guess, for a likely typo', async () => {
    const cwd = await makeTempDir();
    const warnings: string[] = [];
    await loadAgentConfig(
      cwd,
      { PHARGUS_OUTPT: 'none', PHARGUS_INTERVAL: '5' },
      { onWarning: (message) => warnings.push(message) },
    );
    expect(warnings).toEqual([
      'ignoring unknown environment variable PHARGUS_OUTPT; valid names: ' + VALID_NAMES,
      'ignoring unknown environment variable PHARGUS_INTERVAL; valid names: ' + VALID_NAMES,
    ]);
    expect(warnings.join()).not.toContain('did you mean');
    expect(VALID_NAMES).toContain('PHARGUS_OUTPUT');
    expect(VALID_NAMES).toContain('PHARGUS_INTERVAL_MS');
  });

  it('PHARGUS_INTERVL_MS=5 gives one warning that lists the valid variable names', async () => {
    const cwd = await makeTempDir();
    const warnings: string[] = [];
    const config = await loadAgentConfig(
      cwd,
      { PHARGUS_INTERVL_MS: '5' },
      { onWarning: (message) => warnings.push(message) },
    );
    expect(config).toEqual(defaultAgentConfig);
    expect(warnings).toEqual([
      `ignoring unknown environment variable PHARGUS_INTERVL_MS; valid names: ${VALID_NAMES}`,
    ]);
  });

  it("ignores the CLI's PHARGUS_TOKEN and PHARGUS_DEBUG silently", async () => {
    const cwd = await makeTempDir();
    const warnings: string[] = [];
    const config = await loadAgentConfig(
      cwd,
      { PHARGUS_TOKEN: 'secret', PHARGUS_DEBUG: '1', PHARGUS_FOO: '1' },
      { onWarning: (message) => warnings.push(message) },
    );
    expect(config).toEqual(defaultAgentConfig);
    expect(warnings).toEqual([
      `ignoring unknown environment variable PHARGUS_FOO; valid names: ${VALID_NAMES}`,
    ]);
  });

  it('treats PHARGUS_CONFIG as a known variable: no warning, no config key', async () => {
    const cwd = await makeTempDir();
    await writeFile(path.join(cwd, 'pinned.json'), JSON.stringify({ intervalMs: 250 }));
    const warnings: string[] = [];
    const config = await loadAgentConfig(
      cwd,
      { PHARGUS_CONFIG: 'pinned.json' },
      { onWarning: (message) => warnings.push(message) },
    );
    expect(config).toEqual({ ...defaultAgentConfig, intervalMs: 250 });
    expect(warnings).toEqual([]);
  });

  it('lists PHARGUS_CONFIG among the valid names for a likely typo of it', async () => {
    const cwd = await makeTempDir();
    const warnings: string[] = [];
    await loadAgentConfig(
      cwd,
      { PHARGUS_CONFG: 'pinned.json' },
      { onWarning: (message) => warnings.push(message) },
    );
    expect(warnings).toEqual([
      'ignoring unknown environment variable PHARGUS_CONFG; valid names: ' + VALID_NAMES,
    ]);
    expect(warnings.join()).not.toContain('did you mean');
    expect(VALID_NAMES).toContain('PHARGUS_CONFIG');
  });

  it('still fails on an invalid value for a known variable', async () => {
    const cwd = await makeTempDir();
    await expect(
      loadAgentConfig(cwd, { PHARGUS_QUEUE_BOUND: 'lots' }, { onWarning: () => undefined }),
    ).rejects.toThrow(/PHARGUS_QUEUE_BOUND/);
  });
});
