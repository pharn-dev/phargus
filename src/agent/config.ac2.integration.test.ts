import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultAgentConfig, loadAgentConfig, PhargusConfigError } from './config.js';

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
  const dir = await mkdtemp(path.join(tmpdir(), 'phargus-config-ac2-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const JS_WARNING = 'phargus.config.js is no longer read; move its settings to phargus.config.json';

describe('agent config — AC-2', () => {
  it('AC-2: neither a CommonJS phargus.config.js (module.exports) nor an ESM phargus.config.js (export default) supplies its interval, queue bound or output: each is ignored and gives one warning naming phargus.config.json', async () => {
    const { loadAgentConfig, defaultAgentConfig } =
      (await import('./config.js')) as unknown as ConfigModuleUnderTest;

    const cjsDir = await makeTempDir();
    const cjsOutput = path.join(cjsDir, 'cjs-out.ndjson');
    await writeFile(
      path.join(cjsDir, 'package.json'),
      JSON.stringify({ type: 'commonjs' }),
      'utf8',
    );
    await writeFile(
      path.join(cjsDir, 'phargus.config.js'),
      `module.exports = { intervalMs: 321, queueBound: 77, output: ${JSON.stringify(cjsOutput)} };\n`,
      'utf8',
    );

    const esmDir = await makeTempDir();
    const esmOutput = path.join(esmDir, 'esm-out.ndjson');
    await writeFile(path.join(esmDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(
      path.join(esmDir, 'phargus.config.js'),
      `export default { intervalMs: 654, queueBound: 88, output: ${JSON.stringify(esmOutput)} };\n`,
      'utf8',
    );

    const cjsWarnings: string[] = [];
    const cjsConfig = await loadAgentConfig(cjsDir, {}, { onWarning: (m) => cjsWarnings.push(m) });
    expect(cjsConfig.intervalMs).not.toBe(321);
    expect(cjsConfig.queueBound).not.toBe(77);
    expect(cjsConfig.output).not.toBe(cjsOutput);
    expect(cjsConfig).toEqual(defaultAgentConfig);
    expect(cjsWarnings).toEqual([JS_WARNING]);

    const esmWarnings: string[] = [];
    const esmConfig = await loadAgentConfig(esmDir, {}, { onWarning: (m) => esmWarnings.push(m) });
    expect(esmConfig.intervalMs).not.toBe(654);
    expect(esmConfig.queueBound).not.toBe(88);
    expect(esmConfig.output).not.toBe(esmOutput);
    expect(esmConfig).toEqual(defaultAgentConfig);
    expect(esmWarnings).toEqual([JS_WARNING]);
  });
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
    expect(warnings).toEqual([JS_WARNING]);
  });

  it('next to a phargus.config.js, phargus.config.json is read and the .js file is only warned about', async () => {
    const cwd = await makeTempDir();
    await writeMarkerConfig(cwd, 'phargus.config.js');
    await writeFile(path.join(cwd, 'phargus.config.json'), JSON.stringify({ queueBound: 77 }));
    const warnings: string[] = [];

    const config = await loadAgentConfig(cwd, {}, { onWarning: (m) => warnings.push(m) });

    expect(existsSync(path.join(cwd, MARKER))).toBe(false);
    expect(config).toEqual({ ...defaultAgentConfig, queueBound: 77 });
    expect(warnings).toEqual([JS_WARNING]);
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
