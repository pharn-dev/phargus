import { describe, expect, it } from 'vitest';

type TimeoutModule = {
  heapSnapshotTimeoutMs: (bytes: number) => number;
};

describe('heapSnapshotTimeoutMs', () => {
  it('AC-1: derives the task timeout from the byte count at 20 MB/s with a 30 000 ms floor, as integers', async () => {
    const mod = (await import('./index.js')) as unknown as TimeoutModule;

    const cases: Array<[bytes: number, expected: number]> = [
      [0, 30_000],
      [268_435_456, 30_000],
      [600_000_000, 30_000],
      [600_000_001, 30_001],
      [1_073_741_824, 53_688],
      [4_294_967_296, 214_749],
    ];

    for (const [bytes, expected] of cases) {
      const actual = mod.heapSnapshotTimeoutMs(bytes);
      expect(actual, `heapSnapshotTimeoutMs(${bytes})`).toBe(expected);
      expect(Number.isSafeInteger(actual), `heapSnapshotTimeoutMs(${bytes}) is an integer`).toBe(
        true,
      );
    }
  });
});
