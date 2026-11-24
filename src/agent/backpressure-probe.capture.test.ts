import { once } from 'node:events';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBackpressureProbe,
  type BackpressureHotspot,
  type BackpressureProbe,
} from './backpressure-probe.js';

// CORE-359: every stall is named by its own call site, but a window pays for at most 32 stack
// captures; later stalls in the window are named by the stream's constructor.

const CAPTURES_PER_WINDOW = 32;
const MAX_SITES = 256;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
  vi.restoreAllMocks();
});

function enabledProbe(): BackpressureProbe {
  const probe = createBackpressureProbe({ maxHotspots: 1000 });
  probe.enable();
  cleanups.push(() => probe.disable());
  return probe;
}

class LogSink extends Writable {}

/** A 1-byte highWaterMark stream that never completes a write, so every write stalls. */
function heldStream<T extends Writable>(Kind: new (options: object) => T): T {
  const stream = new Kind({ highWaterMark: 1, write: () => undefined });
  cleanups.push(() => stream.destroy());
  return stream;
}

function hotspot(hotspots: BackpressureHotspot[], site: string): BackpressureHotspot | undefined {
  return hotspots.find((entry) => entry.site === site);
}

function stallNewSinks(count: number): void {
  for (let i = 0; i < count; i += 1) {
    expect(heldStream(LogSink).write('x')).toBe(false);
  }
}

describe('backpressure probe — stack captures per window (CORE-359)', () => {
  it('1,000 first stalls on new streams make at most 32 captures; the rest are named by the constructor', () => {
    const probe = enabledProbe();
    const capture = vi.spyOn(Error, 'captureStackTrace');

    stallNewSinks(1000);

    expect(capture.mock.calls.length).toBeLessThanOrEqual(CAPTURES_PER_WINDOW);
    const sample = probe.sample();
    expect(sample.events).toBe(1000);
    expect(hotspot(sample.hotspots, 'LogSink')?.events).toBe(1000 - CAPTURES_PER_WINDOW);
    const captured = sample.hotspots.filter((entry) => entry.site !== 'LogSink');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.site).toMatch(/backpressure-probe\.capture\.test\.ts:\d+$/);
    expect(captured[0]?.events).toBe(CAPTURES_PER_WINDOW);
  });

  it('two call sites that stall the same long-lived stream in one window are two hotspots', async () => {
    const probe = enabledProbe();
    const stream = new Writable({
      highWaterMark: 1,
      write: (_chunk, _encoding, callback) => setImmediate(callback),
    });
    cleanups.push(() => stream.destroy());

    const fromRouteA = (): boolean => stream.write('a');
    const fromRouteB = (): boolean => stream.write('b');
    expect(fromRouteA()).toBe(false);
    await once(stream, 'drain');
    expect(fromRouteB()).toBe(false);
    await once(stream, 'drain');

    const sample = probe.sample();
    expect(sample.events).toBe(2);
    expect(sample.hotspots).toHaveLength(2);
    const [first, second] = sample.hotspots;
    expect(first?.site).not.toBe(second?.site);
    for (const entry of sample.hotspots) {
      expect(entry.site).toMatch(/backpressure-probe\.capture\.test\.ts:\d+$/);
      expect(entry.events).toBe(1);
    }
  });

  it('a new window allows captures again', () => {
    const probe = enabledProbe();
    stallNewSinks(CAPTURES_PER_WINDOW + 1);
    expect(hotspot(probe.sample().hotspots, 'LogSink')?.events).toBe(1);

    const capture = vi.spyOn(Error, 'captureStackTrace');
    stallNewSinks(1);

    expect(capture).toHaveBeenCalledTimes(1);
    const sample = probe.sample();
    expect(sample.events).toBe(1);
    expect(sample.hotspots).toHaveLength(1);
    expect(sample.hotspots[0]?.site).toMatch(/backpressure-probe\.capture\.test\.ts:\d+$/);
  });

  it('keeps at most 256 sites per window and counts the rest under <other>', () => {
    const probe = enabledProbe();
    stallNewSinks(CAPTURES_PER_WINDOW);
    const kinds = 300;
    for (let i = 0; i < kinds; i += 1) {
      const name = `Sink${String(i)}`;
      const Kind = { [name]: class extends Writable {} }[name] as typeof Writable;
      expect(heldStream(Kind).write('x')).toBe(false);
    }

    const sample = probe.sample();
    const total = CAPTURES_PER_WINDOW + kinds;
    expect(sample.events).toBe(total);
    const named = sample.hotspots.filter((entry) => entry.site !== '<other>');
    expect(named).toHaveLength(MAX_SITES);
    // One captured site plus 255 constructor names fit; the other 45 names go to <other>.
    expect(hotspot(sample.hotspots, '<other>')?.events).toBe(kinds - (MAX_SITES - 1));
    expect(sample.hotspots.reduce((sum, entry) => sum + entry.events, 0)).toBe(total);
  });

  it('a stream whose constructor name throws past the cap never throws into the write', async () => {
    enabledProbe();
    stallNewSinks(CAPTURES_PER_WINDOW);
    class Hostile extends Writable {}
    Object.defineProperty(Hostile, 'name', {
      get(): string {
        throw new Error('no name');
      },
    });
    const warned = once(process, 'warning');

    expect(heldStream(Hostile).write('x')).toBe(false);

    const [warning] = (await warned) as [Error];
    expect(warning.name).toBe('PhargusBackpressureWarning');
    expect(warning.message).toContain('observer failed: no name');
  });
});
