import * as crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: vi.fn(actual.randomBytes),
    randomFillSync: vi.fn(actual.randomFillSync),
  };
});

type TraceIdModule = typeof import('./trace-id.js');
type FillTarget = Parameters<typeof crypto.randomFillSync>[0];

/** The bytes a fill call writes, whether it was handed a view or a bare ArrayBuffer. */
function bytesOf(target: FillTarget): Uint8Array {
  return ArrayBuffer.isView(target)
    ? new Uint8Array(target.buffer, target.byteOffset, target.byteLength)
    : new Uint8Array(target);
}

const randomBytes = vi.mocked(crypto.randomBytes);
const randomFillSync = vi.mocked(crypto.randomFillSync);

/** A fresh copy of the module, so each case starts with an empty pool. */
async function load(): Promise<TraceIdModule> {
  vi.resetModules();
  return import('./trace-id.js');
}

beforeEach(() => {
  randomBytes.mockClear();
  randomFillSync.mockClear();
});

describe('trace and span ids — pooled CSPRNG bytes', () => {
  it('makes well-formed, non-zero, unique ids across many pool refills', async () => {
    const { newSpanId, newTraceId } = await load();
    const traceIds = new Set<string>();
    const spanIds = new Set<string>();
    for (let i = 0; i < 5000; i += 1) {
      traceIds.add(newTraceId());
      spanIds.add(newSpanId());
    }
    expect(traceIds.size).toBe(5000);
    expect(spanIds.size).toBe(5000);
    for (const id of traceIds) {
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(id).not.toBe('0'.repeat(32));
    }
    for (const id of spanIds) {
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      expect(id).not.toBe('0'.repeat(16));
    }
    // 5000 × 24 bytes is 120 000 bytes: about 30 refills of a 4 KiB pool, so they were exercised.
    expect(randomFillSync.mock.calls.length).toBeGreaterThan(20);
  });

  it('draws randomness in batches, not with one native call per id', async () => {
    const { newSpanId, newTraceId } = await load();
    for (let i = 0; i < 1000; i += 1) {
      newTraceId();
      newSpanId();
    }
    // 24 000 bytes from a 4096-byte pool: 6 fills, never one per id.
    expect(randomFillSync.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(randomFillSync.mock.calls.length).toBeLessThanOrEqual(7);
    expect(randomBytes).not.toHaveBeenCalled();
  });

  it('never hands out an all-zero id, even when the random source returns zeros', async () => {
    const { newSpanId, newTraceId } = await load();
    // The first fill is all zeros; every id cut from it is all-zero and must be skipped.
    randomFillSync.mockImplementationOnce((target: FillTarget): FillTarget => {
      bytesOf(target).fill(0);
      return target;
    });
    expect(newTraceId()).not.toBe('0'.repeat(32));
    expect(newSpanId()).not.toBe('0'.repeat(16));
    expect(randomFillSync.mock.calls.length).toBe(2);
  });

  it('writeSpanId writes 8 non-zero bytes in place, skipping an all-zero draw', async () => {
    const { writeSpanId } = await load();
    randomFillSync.mockImplementationOnce((target: FillTarget): FillTarget => {
      bytesOf(target).fill(0);
      return target;
    });
    const target = new Uint8Array(12).fill(0xee);
    writeSpanId(target, 2);
    expect(target.slice(2, 10).some((byte) => byte !== 0)).toBe(true);
    // Bytes outside the 8-byte window are untouched.
    expect([target[0], target[1], target[10], target[11]]).toEqual([0xee, 0xee, 0xee, 0xee]);
    expect(randomFillSync.mock.calls.length).toBe(2);
  });

  it('never reuses pool bytes: consecutive ids are disjoint slices of the random stream', async () => {
    const { newSpanId, newTraceId } = await load();
    let counter = 0;
    // A deterministic, never-repeating stream (1, 2, 3, …) makes reuse visible.
    randomFillSync.mockImplementation((target: FillTarget): FillTarget => {
      const bytes = bytesOf(target);
      for (let i = 0; i < bytes.length; i += 1) {
        counter += 1;
        bytes[i] = counter % 251;
      }
      return target;
    });
    const trace = newTraceId();
    const span = newSpanId();
    const hex = (from: number, count: number): string =>
      Array.from({ length: count }, (_, i) =>
        ((from + i) % 251).toString(16).padStart(2, '0'),
      ).join('');
    expect(trace).toBe(hex(1, 16));
    expect(span).toBe(hex(17, 8));
    randomFillSync.mockReset();
  });
});
