import type * as Fs from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAgentOutput } from './agent-output.js';

const RENAME_DELAY_MS = 120;
const TICK_MS = 10;

const probe = vi.hoisted(() => ({
  syncCalls: [] as string[],
  renames: [] as { start: number; end: number }[],
}));

// Every synchronous fs call made through node:fs is recorded.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  const mocked: Record<string, unknown> = { ...actual };
  for (const [name, value] of Object.entries(actual)) {
    if (name.endsWith('Sync') && typeof value === 'function') {
      const fn = value as (...args: unknown[]) => unknown;
      mocked[name] = (...args: unknown[]): unknown => {
        probe.syncCalls.push(name);
        return fn(...args);
      };
    }
  }
  return { ...mocked, default: mocked };
});

// A slow rename, so a rotation stays in progress for a measurable time.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const rename: typeof actual.rename = async (from, to) => {
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, RENAME_DELAY_MS));
    await actual.rename(from, to);
    probe.renames.push({ start, end: Date.now() });
  };
  const mocked = { ...actual, rename };
  return { ...mocked, default: mocked };
});

let dir: string | undefined;

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('agent output rotation stays asynchronous', () => {
  it('AC-2: no synchronous fs call is made on the output path, and a timer tick runs on time while a rotation is in progress', async () => {
    dir = await mkdtemp(join(tmpdir(), 'phargus-output-async-'));
    const file = join(dir, 'out.ndjson');
    const all = Array.from(
      { length: 400 },
      (_, seq) => `${JSON.stringify({ seq, pad: 'x'.repeat(500) })}\n`,
    );

    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(Date.now()), TICK_MS);
    probe.syncCalls.length = 0;
    probe.renames.length = 0;
    try {
      await pipeline(Readable.from(all), openAgentOutput(file, 64 * 1024));
    } finally {
      clearInterval(timer);
    }

    expect(probe.syncCalls).toEqual([]);
    expect(probe.renames.length).toBeGreaterThanOrEqual(2);
    expect((await readdir(dir)).sort()).toEqual(['out.ndjson', 'out.ndjson.1']);
    for (const { start, end } of probe.renames) {
      const during = ticks.filter((t) => t >= start && t <= end);
      expect(during.length, 'timer ticks while the rename is pending').toBeGreaterThanOrEqual(2);
    }
  });
});
