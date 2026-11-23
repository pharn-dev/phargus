import { Server } from 'node:http';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createAgentExport, startAgentOnce } from './auto-start.js';
import { sampleHeapSpaces, sampleMemory } from './index.js';
import type { AgentSampleLine } from './span-record.js';

// Run auto-start as if it had been preloaded into a worker thread.
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return { ...actual, isMainThread: false };
});

describe('auto-start outside the main thread', () => {
  it('startAgentOnce() in a worker thread starts nothing: no start-once flag, no http patch', () => {
    const agentKey = Symbol.for('phargus.agent');
    const emitBefore = Object.getOwnPropertyDescriptor(Server.prototype, 'emit');
    expect((globalThis as Record<symbol, unknown>)[agentKey]).toBeUndefined();

    startAgentOnce();

    expect((globalThis as Record<symbol, unknown>)[agentKey]).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(Server.prototype, 'emit')).toEqual(emitBefore);
  });

  it("each sample line carries the writer's integer process.pid", async () => {
    let text = '';
    const destination = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        callback();
      },
    });
    const output = createAgentExport(destination, { queueBound: 4 }, () => ({
      spans: [],
      dropped: 0,
    }));
    output.exportSample({
      timestamp: 1,
      eventLoop: { min: 1, max: 5, mean: 2, p50: 2, p99: 4 },
      memory: sampleMemory(),
      heapSpaces: sampleHeapSpaces(),
      gc: {
        count: 0,
        totalPause: 0,
        maxPause: 0,
        kinds: { minor: 0, major: 0, incremental: 0, weakcb: 0 },
      },
      backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
    });
    await output.stop();
    const line = JSON.parse(text.trim()) as AgentSampleLine;
    expect(Number.isInteger(line.pid)).toBe(true);
    expect(line.pid).toBe(process.pid);
  });
});
