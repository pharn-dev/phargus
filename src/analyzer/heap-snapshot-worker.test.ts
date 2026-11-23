// The heap-snapshot worker run in this process (so coverage sees it): a MessageChannel port stands
// in for `parentPort`, and each test sends one task the way the pool does.
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessagePort } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TaskReply } from './worker-protocol.js';

const ports = vi.hoisted(() => ({
  host: undefined as MessagePort | undefined,
  worker: undefined as MessagePort | undefined,
}));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  const channel = new actual.MessageChannel();
  ports.host = channel.port2;
  ports.worker = channel.port1;
  return { ...actual, parentPort: channel.port1 };
});

// Loads the worker, which listens on the mocked parentPort.
await import('./workers/heap-snapshot.worker.js');

const HEADER =
  '"snapshot":{"meta":{"node_fields":["type","name","self_size"],"node_types":[["object"]]}}';
const BODY = '"nodes":[0,0,10,0,1,20],"strings":["Alpha","Beta"]';
const SUMMARY = {
  nodeCount: 2,
  totalSelfSize: 30,
  top: [
    { name: 'Beta', count: 1, selfSize: 20 },
    { name: 'Alpha', count: 1, selfSize: 10 },
  ],
};

let dir: string;
let nextId = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phargus-snapshot-worker-'));
});

afterAll(async () => {
  ports.host?.close();
  ports.worker?.close();
  await rm(dir, { recursive: true, force: true });
});

async function summarize(text: string): Promise<TaskReply> {
  const host = ports.host;
  if (host === undefined) throw new Error('the worker_threads mock did not run');
  nextId += 1;
  const path = join(dir, `${String(nextId)}.heapsnapshot`);
  await writeFile(path, text);
  const reply = once(host, 'message') as Promise<[TaskReply]>;
  host.postMessage({ id: nextId, payload: { kind: 'summary', path, top: 10 } });
  return (await reply)[0];
}

describe('heap-snapshot worker nesting limit (CORE-252)', () => {
  it('accepts JSON nested 64 levels deep under an unknown root key', async () => {
    // The root object is level 1, so 63 arrays under "x" reach level 64.
    const nested = `${'['.repeat(63)}${']'.repeat(63)}`;
    const reply = await summarize(`{${HEADER},"x":${nested},${BODY}}`);
    expect(reply).toMatchObject({ ok: true, value: SUMMARY });
  });

  it('rejects JSON nested 65 levels deep with "nesting too deep"', async () => {
    const nested = `${'['.repeat(64)}${']'.repeat(64)}`;
    const reply = await summarize(`{${HEADER},"x":${nested},${BODY}}`);
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.message).toMatch(
      /^cannot parse heap snapshot .*: nesting too deep at byte /,
    );
  });

  it('rejects deep objects as well as deep arrays', async () => {
    const reply = await summarize(`{"x":${'{"a":'.repeat(100)}`);
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.message).toMatch(/nesting too deep/);
  });
});

describe('heap-snapshot worker root keys (CORE-252)', () => {
  it('ignores unknown root keys, repeated or not, and still summarizes', async () => {
    const extra = Array.from({ length: 1000 }, (_, i) => `"k${String(i)}":0`).join(',');
    const reply = await summarize(`{"k0":1,${extra},${HEADER},"k0":[],${BODY}}`);
    expect(reply).toMatchObject({ ok: true, value: SUMMARY });
  });

  it.each(['snapshot', 'nodes', 'strings'])('still rejects a duplicate %s key', async (key) => {
    const reply = await summarize(`{${HEADER},${BODY},"${key}":[]}`);
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.message).toMatch(new RegExp(`^invalid heap snapshot .*: duplicate ${key}$`));
  });
});
