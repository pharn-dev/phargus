import { once } from 'node:events';
import { createServer, get, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackpressureProbe, type BackpressureProbe } from './backpressure-probe.js';

// CORE-227: a stall ends with whichever of 'drain', 'finish' or 'close' comes first, and its
// duration is recorded once, whichever it was.

const HOLD_MS = 100;
const MIN_STALL_NS = 50_000_000;
const FULL_AFTER_MS = 100;
const EIGHT_MIB = 8 * 1024 * 1024;
const ENDING_EVENTS = ['drain', 'finish', 'close'] as const;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function enabledProbe(): BackpressureProbe {
  const probe = createBackpressureProbe();
  probe.enable();
  cleanups.push(() => probe.disable());
  return probe;
}

function listenerCounts(stream: NodeJS.EventEmitter): number[] {
  return ENDING_EVENTS.map((event) => stream.listenerCount(event));
}

/** A 1-byte highWaterMark Writable that withholds its write callbacks until resume(). */
function createStallableWritable(): { stream: Writable; resume: () => void } {
  let stalled = true;
  const held: (() => void)[] = [];
  const stream = new Writable({
    highWaterMark: 1,
    write(_chunk: Buffer, _encoding, callback) {
      if (stalled) {
        held.push(() => callback());
      } else {
        callback();
      }
    },
  });
  return {
    stream,
    resume: () => {
      stalled = false;
      for (const release of held.splice(0)) {
        release();
      }
    },
  };
}

/**
 * Write 1 MiB chunks until the client's socket is full: a write whose 'drain' does not come within
 * `FULL_AFTER_MS`. Runs before the probe is enabled, so none of it is counted. Loopback buffers
 * differ a lot between platforms (Windows took a whole 8 MiB write in a few ms), so the measured
 * stall below starts from a full socket on every platform.
 */
async function fillSocket(res: ServerResponse): Promise<void> {
  const chunk = Buffer.alloc(1024 * 1024, 97);
  for (let i = 0; i < 1024; i += 1) {
    if (res.write(chunk)) {
      continue;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FULL_AFTER_MS);
    const drained = await once(res, 'drain', { signal: abort.signal }).then(
      () => true,
      () => false,
    );
    clearTimeout(timer);
    if (!drained) {
      return;
    }
  }
  throw new Error('the client socket never filled');
}

/**
 * An http server and a client that receives the response headers but does not read the body.
 * The handler fills the socket, then enables the probe and runs `stall`, which returns once its
 * stalled write is made; the client then holds for `HOLD_MS` before `release` runs.
 */
async function stallResponse(
  stall: (res: ServerResponse) => () => Promise<void>,
  release: (response: IncomingMessage) => Promise<void>,
): Promise<BackpressureProbe> {
  let probe: BackpressureProbe | undefined;
  let finish: (() => Promise<void>) | undefined;
  let resolveStalled: () => void = () => {};
  let rejectStalled: (error: unknown) => void = () => {};
  const stalled = new Promise<void>((resolve, reject) => {
    resolveStalled = resolve;
    rejectStalled = reject;
  });
  const server = createServer((_req, res) => {
    fillSocket(res)
      .then(() => {
        probe = enabledProbe();
        finish = stall(res);
      })
      .then(resolveStalled, rejectStalled);
  });
  cleanups.push(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get({ host: '127.0.0.1', port, path: '/', agent: false }, resolve).on('error', reject);
  });
  cleanups.push(() => response.destroy());
  await stalled;
  await delay(HOLD_MS);
  await release(response);
  await finish!();
  return probe!;
}

describe('backpressure probe — what ends a stall (CORE-227)', () => {
  it('res.write(8 MiB); res.end() against a held reader reports the stall duration on the window and the hotspot', async () => {
    let before: number[] = [];
    let after: number[] = [];
    const probe = await stallResponse(
      (res) => {
        before = listenerCounts(res);
        expect(res.write(Buffer.alloc(EIGHT_MIB, 97))).toBe(false);
        res.end();
        const finished = once(res, 'finish');
        return async () => {
          await finished;
          after = listenerCounts(res);
        };
      },
      async (response) => {
        response.resume();
        await once(response, 'end');
      },
    );

    const reading = probe.sample();
    expect(reading.events).toBe(1);
    expect(Number.isInteger(reading.totalStall)).toBe(true);
    expect(reading.totalStall).toBeGreaterThanOrEqual(MIN_STALL_NS);
    expect(reading.maxStall).toBe(reading.totalStall);
    expect(reading.hotspots).toHaveLength(1);
    const hotspot = reading.hotspots[0]!;
    expect(hotspot.site).toContain('backpressure-probe.settle.test.ts');
    expect(hotspot.events).toBe(1);
    expect(hotspot.totalStall).toBe(reading.totalStall);
    expect(after).toEqual(before);
  }, 20_000);

  it('a stalled response destroyed by the client reports the time until close', async () => {
    let before: number[] = [];
    let after: number[] = [];
    const probe = await stallResponse(
      (res) => {
        before = listenerCounts(res);
        expect(res.write(Buffer.alloc(EIGHT_MIB, 97))).toBe(false);
        const closed = once(res, 'close');
        return async () => {
          await closed;
          after = listenerCounts(res);
        };
      },
      (response) => {
        response.destroy();
        return Promise.resolve();
      },
    );

    const reading = probe.sample();
    expect(reading.events).toBe(1);
    expect(reading.totalStall).toBeGreaterThanOrEqual(MIN_STALL_NS);
    expect(reading.hotspots).toHaveLength(1);
    expect(reading.hotspots[0]!.totalStall).toBe(reading.totalStall);
    expect(after).toEqual(before);
  }, 20_000);

  it('a stall that ends with drain is counted once, also when finish and close follow', async () => {
    const probe = enabledProbe();
    const { stream, resume } = createStallableWritable();
    const before = listenerCounts(stream);
    expect(stream.write('x')).toBe(false);
    await delay(10);
    const drained = once(stream, 'drain');
    resume();
    await drained;
    expect(listenerCounts(stream)).toEqual(before);

    const first = probe.sample();
    expect(first.events).toBe(1);
    expect(first.totalStall).toBeGreaterThan(0);

    const finished = once(stream, 'finish');
    const closed = once(stream, 'close');
    stream.end();
    await Promise.all([finished, closed]);
    const second = probe.sample();
    expect(second.events).toBe(0);
    expect(second.totalStall).toBe(0);
    expect(second.hotspots).toEqual([]);
  });

  it('a stall that ends with finish (no drain after end()) settles once and removes its listeners', async () => {
    const probe = enabledProbe();
    const { stream, resume } = createStallableWritable();
    const before = listenerCounts(stream);
    expect(stream.write('x')).toBe(false);
    stream.end();
    await delay(10);
    const finished = once(stream, 'finish');
    resume();
    await finished;
    expect(listenerCounts(stream)).toEqual(before);
    const reading = probe.sample();
    expect(reading.events).toBe(1);
    expect(reading.totalStall).toBeGreaterThan(0);
  });

  it('a probe disabled during an open stall records nothing and leaves no listener', async () => {
    for (const ending of ENDING_EVENTS) {
      const probe = createBackpressureProbe();
      probe.enable();
      const { stream, resume } = createStallableWritable();
      const before = listenerCounts(stream);
      expect(stream.write('x')).toBe(false);
      probe.disable();
      if (ending === 'finish') {
        stream.end();
      }
      const ended = once(stream, ending);
      if (ending === 'close') {
        stream.destroy();
      } else {
        resume();
      }
      await ended;
      expect(listenerCounts(stream), ending).toEqual(before);
      const reading = probe.sample();
      expect(reading.totalStall, ending).toBe(0);
      expect(reading.maxStall, ending).toBe(0);
      stream.destroy();
    }
  });
});
