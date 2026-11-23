// CORE-257: rule files have a size cap, and a run's watchdog does not time the child's start-up.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPluginRunner, loadRulesDirectory, RuleErrorCode } from './index.js';
import { createSandboxProcess } from './sandbox-process.js';

const MIB = 1024 * 1024;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phargus-sandbox-edges-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('rule file size cap', () => {
  it('reports a 2 MiB rule file as RULE_FILE_UNREADABLE without reading it, and loads a 1 MiB one', async () => {
    const rulesDir = join(dir, 'rules');
    await mkdir(rulesDir);
    const fits = `return [];${' '.repeat(MIB - 'return [];'.length)}`;
    await writeFile(join(rulesDir, 'fits.js'), fits);
    await writeFile(join(rulesDir, 'huge.js'), `return [];${' '.repeat(2 * MIB)}`);

    const loaded = await loadRulesDirectory(rulesDir);
    if (!loaded.ok) throw new Error(loaded.error.message);
    // Ids and lengths only: a failing diff of multi-MiB strings would stall the reporter.
    expect(loaded.rules.map((rule) => rule.id)).toEqual(['fits']);
    expect(loaded.rules[0]?.source === fits).toBe(true);
    expect(loaded.failures).toHaveLength(1);
    const failure = loaded.failures[0];
    expect(failure?.id).toBe('huge');
    expect(failure?.error.code).toBe(RuleErrorCode.RULE_FILE_UNREADABLE);
    // The size branch, not a failed read: its text was never read.
    expect(failure?.error.message).toContain('over the limit of 1048576');
  });
});

describe('sandbox start-up is not timed as the run', { timeout: 30_000 }, () => {
  it('runs `return []` on a cold runner with timeoutMs 50, and still ends an endless loop at timeoutMs', async () => {
    const runner = createPluginRunner({ timeoutMs: 50 });
    try {
      expect(await runner.run('return [];', [])).toEqual({ ok: true, findings: [] });

      const started = performance.now();
      const looped = await runner.run('while (true) {}', []);
      const elapsedMs = performance.now() - started;
      expect(looped.ok).toBe(false);
      if (!looped.ok) expect(looped.error.code).toBe(RuleErrorCode.TIMEOUT);
      // Ended by the isolate's own 50 ms timeout, well before the 1 050 ms watchdog.
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      await runner.close();
    }
  });

  it('a child that never reports ready is killed at the start-up cap with a typed failure', async () => {
    const script = join(dir, 'never-ready-child.mjs');
    await writeFile(script, `process.on('disconnect', () => process.exit(0));\n`);
    const sandbox = createSandboxProcess(script, { maxFindings: 10, maxResultBytes: 1000 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = sandbox.request(
        {
          source: 'return [];',
          windowsJson: '[]',
          timeoutMs: 50,
          memoryLimitMb: 64,
          isolatedVmModule: 'isolated-vm',
          maxFindings: 10,
          maxResultBytes: 1000,
        },
        1050,
      );
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      // The run's own watchdog is not armed yet: its 1 050 ms pass without a result.
      await vi.advanceTimersByTimeAsync(1050);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(RuleErrorCode.SANDBOX_CRASHED);
        expect(result.error.message).toContain('did not start within 10000 ms');
      }
    } finally {
      vi.useRealTimers();
      await sandbox.kill();
    }
  });
});
