import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultAgentConfig, loadAgentConfig, PhargusConfigError } from './config.js';

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'phargus-config-ac2-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const MARKER = 'config-loaded.txt';

/** A CommonJS config file that leaves a marker file next to itself when it is executed. */
async function writeMarkerConfig(dir: string, name: string): Promise<void> {
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }), 'utf8');
  await writeFile(
    path.join(dir, name),
    [
      `require('node:fs').writeFileSync(require('node:path').join(__dirname, ${JSON.stringify(MARKER)}), 'loaded');`,
      'module.exports = { intervalMs: 321 };',
      '',
    ].join('\n'),
    'utf8',
  );
}

describe('agent config — only JSON is read (CORE-362)', () => {
  it('a phargus.config.js in the working directory is not executed and gives exactly one warning naming phargus.config.json', async () => {
    const cwd = await makeTempDir();
    await writeMarkerConfig(cwd, 'phargus.config.js');
    const warnings: string[] = [];

    const config = await loadAgentConfig(cwd, {}, { onWarning: (m) => warnings.push(m) });

    expect(existsSync(path.join(cwd, MARKER)), 'phargus.config.js was executed').toBe(false);
    expect(config).toEqual(defaultAgentConfig);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('phargus.config.js');
    expect(warnings[0]).toContain('phargus.config.json');
  });

  it('next to a phargus.config.js, phargus.config.json is read and the .js file is only warned about', async () => {
    const cwd = await makeTempDir();
    await writeMarkerConfig(cwd, 'phargus.config.js');
    await writeFile(path.join(cwd, 'phargus.config.json'), JSON.stringify({ queueBound: 77 }));
    const warnings: string[] = [];

    const config = await loadAgentConfig(cwd, {}, { onWarning: (m) => warnings.push(m) });

    expect(existsSync(path.join(cwd, MARKER))).toBe(false);
    expect(config).toEqual({ ...defaultAgentConfig, queueBound: 77 });
    expect(warnings).toHaveLength(1);
  });

  it('PHARGUS_CONFIG=settings.js rejects with the unsupported-extension error and does not execute the file', async () => {
    const cwd = await makeTempDir();
    await writeMarkerConfig(cwd, 'settings.js');

    const load = loadAgentConfig(cwd, { PHARGUS_CONFIG: 'settings.js' }, { onWarning: () => {} });

    await expect(load).rejects.toBeInstanceOf(PhargusConfigError);
    await expect(load).rejects.toThrow(
      /^phargus config: PHARGUS_CONFIG \(.*settings\.js\): unsupported extension "\.js"; use \.json$/,
    );
    expect(existsSync(path.join(cwd, MARKER))).toBe(false);
  });
});
