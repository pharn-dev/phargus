// CORE-256: the sandbox child starts no second agent, writes nothing to the host's stdout and
// does not get the host's environment.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuleRunResult } from './index.js';
import { createSandboxProcess } from './sandbox-process.js';

const srcDir = fileURLToPath(new URL('.', import.meta.url));
const agentEntry = pathToFileURL(join(srcDir, '..', 'agent', 'auto.ts')).href;

// Lets a plain `node` process import this repo's TypeScript sources (`./x.js` -> `./x.ts`).
const TS_HOOKS_URL = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return next(specifier.slice(0, -3) + '.ts', context);
      }
      throw error;
    }
  },
});`)}`;

const INTERVAL_MS = 50;

/** The parent's env minus every PHARGUS_* name and NODE_OPTIONS, plus `extra`. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.startsWith('PHARGUS_') || name === 'NODE_OPTIONS') continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phargus-sandbox-env-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('sandbox child environment (CORE-256)', { timeout: 60_000 }, () => {
  it('with the agent preloaded through NODE_OPTIONS, running a rule adds no sample line to the host stdout', async () => {
    const app = join(dir, 'host.mjs');
    await writeFile(
      app,
      `const { createPluginRunner } = await import(${JSON.stringify(
        pathToFileURL(join(srcDir, 'plugin-runner.ts')).href,
      )});
const runner = createPluginRunner();
const result = await runner.run('return [{ windowStart: 1, message: "ran" }];', []);
// Let a started child agent sample for about ten intervals.
await new Promise((r) => setTimeout(r, ${String(INTERVAL_MS * 10)}));
await runner.close();
process.stderr.write(JSON.stringify({ pid: process.pid, result }) + '\\n');
`,
    );
    const child = spawnSync(process.execPath, [app], {
      cwd: dir,
      env: childEnv({
        NODE_OPTIONS: `--import ${TS_HOOKS_URL} --import ${agentEntry}`,
        PHARGUS_INTERVAL_MS: String(INTERVAL_MS),
      }),
      encoding: 'utf8',
      timeout: 50_000,
    });
    expect(child.error, String(child.error)).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const report = JSON.parse(child.stderr.trim().split('\n').pop() ?? '') as {
      pid: number;
      result: RuleRunResult;
    };
    // isolated-vm still loads in the scrubbed child, and the rule runs.
    expect(report.result).toEqual({ ok: true, findings: [{ windowStart: 1, message: 'ran' }] });
    const pids = child.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { pid: unknown }).pid);
    // The host's own agent sampled, and every sample line on its stdout is the host's.
    expect(pids.length).toBeGreaterThanOrEqual(3);
    expect(pids.filter((pid) => pid !== report.pid)).toEqual([]);
  });

  it('the sandbox child does not get the host environment', async () => {
    const script = join(dir, 'env-child.mjs');
    await writeFile(
      script,
      `process.on('message', (m) => {
  const message = JSON.stringify(process.env);
  process.send({ type: 'result', id: m.id, result: { ok: true, findings: [{ windowStart: 0, message }] } });
});
process.on('disconnect', () => process.exit(0));
`,
    );
    process.env['PHARGUS_TEST_HOST_MARKER'] = 'host-secret';
    const sandbox = createSandboxProcess(script, { maxFindings: 10, maxResultBytes: 100_000 });
    try {
      const result = await sandbox.request(
        {
          source: '',
          windowsJson: '[]',
          timeoutMs: 1000,
          memoryLimitMb: 64,
          isolatedVmModule: 'isolated-vm',
          maxFindings: 10,
          maxResultBytes: 100_000,
        },
        20_000,
      );
      if (!result.ok) throw new Error(result.error.message);
      const env = JSON.parse(result.findings[0]?.message ?? '{}') as Record<string, string>;
      expect(env['PHARGUS_TEST_HOST_MARKER']).toBeUndefined();
      expect(env['NODE_OPTIONS']).toBeUndefined();
      expect(env['PHARGUS_ENABLED']).toBe('false');
      expect(env['PATH']).toBe(process.env['PATH']);
    } finally {
      delete process.env['PHARGUS_TEST_HOST_MARKER'];
      await sandbox.kill();
    }
  });
});
