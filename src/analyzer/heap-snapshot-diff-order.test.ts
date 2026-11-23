import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TaskReply } from './worker-protocol.js';

// Runs the heap-snapshot worker's message handler in this thread (a fake parentPort), so the diff
// ordering is checked on small hand-written snapshots without spawning a worker.
const port = vi.hoisted(() => {
  let handler: ((message: unknown) => void) | undefined;
  let resolveReply: ((reply: TaskReply) => void) | undefined;
  return {
    on(_event: string, listener: (message: unknown) => void): void {
      handler = listener;
    },
    postMessage(reply: TaskReply): void {
      resolveReply?.(reply);
    },
    send(payload: unknown): Promise<TaskReply> {
      return new Promise((resolve) => {
        resolveReply = resolve;
        handler?.({ id: 1, payload });
      });
    },
  };
});

vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:worker_threads')>()),
  parentPort: port,
}));

function snapshot(nodes: number[], strings: string[]): string {
  return JSON.stringify({
    snapshot: { meta: { node_fields: ['type', 'name', 'self_size'], node_types: [['object']] } },
    nodes,
    strings,
  });
}

let dir: string;
let beforePath: string;
let afterPath: string;

beforeAll(async () => {
  await import('./workers/heap-snapshot.worker.js');
  dir = await mkdtemp(join(tmpdir(), 'phargus-diff-order-'));
  beforePath = join(dir, 'before.heapsnapshot');
  afterPath = join(dir, 'after.heapsnapshot');
  // Before: Alpha 1 x 10, Beta 1 x 20, Gamma 3 x 100. After: Alpha 2 x 10, Beta 1 x 20, Delta 1 x 50.
  await writeFile(
    beforePath,
    snapshot([0, 0, 10, 0, 1, 20, 0, 2, 100, 0, 2, 100, 0, 2, 100], ['Alpha', 'Beta', 'Gamma']),
  );
  await writeFile(
    afterPath,
    snapshot([0, 0, 10, 0, 0, 10, 0, 1, 20, 0, 2, 50], ['Alpha', 'Beta', 'Delta']),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('heap-snapshot worker diff ordering', () => {
  it('leaves out unchanged types and ranks growth and shrink by absolute self-size change', async () => {
    const reply = await port.send({ kind: 'diff', beforePath, afterPath, top: 10 });
    expect(reply).toMatchObject({ ok: true });
    expect(reply.ok && (reply.value as { entries: unknown }).entries).toEqual([
      { name: 'Gamma', countDelta: -3, selfSizeDelta: -300 },
      { name: 'Delta', countDelta: 1, selfSizeDelta: 50 },
      { name: 'Alpha', countDelta: 1, selfSizeDelta: 10 },
    ]);
  });

  it('still cuts the rows to top', async () => {
    const reply = await port.send({ kind: 'diff', beforePath, afterPath, top: 1 });
    expect(reply.ok && (reply.value as { entries: unknown }).entries).toEqual([
      { name: 'Gamma', countDelta: -3, selfSizeDelta: -300 },
    ]);
  });
});
