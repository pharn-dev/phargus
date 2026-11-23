import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNdjsonDecoder } from './ndjson-decoder.js';
import type { NdjsonDecoderOptions, NdjsonSkip } from './ndjson-decoder.js';

/** Every byte of `text` as its own one-byte chunk. */
function oneByteChunks(text: string): Buffer[] {
  const bytes = Buffer.from(text, 'utf8');
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += 1) {
    chunks.push(bytes.subarray(offset, offset + 1));
  }
  return chunks;
}

/** Runs the chunks through a fresh decoder and returns what it emitted and skipped. */
async function decode(
  chunks: Buffer[],
  options: NdjsonDecoderOptions = {},
): Promise<{ records: unknown[]; skipped: NdjsonSkip[]; oversized: number; invalid: number }> {
  const skipped: NdjsonSkip[] = [];
  const decoder = createNdjsonDecoder({
    ...options,
    onSkipped(skip) {
      skipped.push(skip);
    },
  });
  const records: unknown[] = [];
  await pipeline(Readable.from(chunks, { objectMode: false }), decoder, async (source) => {
    for await (const record of source) {
      records.push(record);
    }
  });
  return { records, skipped, oversized: decoder.oversized, invalid: decoder.invalid };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NDJSON decoder: a line that trickles in', () => {
  const record = {
    msg: 'x'.repeat(900),
    nested: { a: [1, 2, 3], b: 'ünïcödé' },
    n: 42,
  };
  const line = `${JSON.stringify(record)}\n`;

  it('holds a trickled line in one buffer that doubles, so it grows O(log n) times and is joined once', () => {
    const decoder = createNdjsonDecoder();
    const records: unknown[] = [];
    decoder.on('data', (value: unknown) => records.push(value));
    const chunks = oneByteChunks(line);
    const partialBytes = chunks.length - 1; // every chunk but the final newline

    const alloc = vi.spyOn(Buffer, 'allocUnsafe');
    const concat = vi.spyOn(Buffer, 'concat');
    for (const chunk of chunks.slice(0, -1)) {
      decoder.write(chunk);
    }
    // Capacities 1, 2, 4, ... until the partial line fits: one growth per doubling.
    expect(alloc).toHaveBeenCalledTimes(Math.ceil(Math.log2(partialBytes)) + 1);
    expect(concat).not.toHaveBeenCalled();

    decoder.write(chunks.at(-1));
    // The newline joins the held bytes and the final (empty) segment once.
    expect(concat).toHaveBeenCalledTimes(1);
    expect(concat.mock.calls[0]?.[0]).toHaveLength(2);
    expect(records).toEqual([record]);
  });

  it('never grows the held buffer past maxLineBytes', () => {
    const maxLineBytes = 1000;
    const decoder = createNdjsonDecoder({ maxLineBytes });
    const records: unknown[] = [];
    decoder.on('data', (value: unknown) => records.push(value));
    const exact = { msg: 'z'.repeat(maxLineBytes - 10) };
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(maxLineBytes);

    const alloc = vi.spyOn(Buffer, 'allocUnsafe');
    for (const chunk of oneByteChunks(JSON.stringify(exact))) {
      decoder.write(chunk);
    }
    const sizes = alloc.mock.calls.map(([size]) => size);
    expect(Math.max(...sizes)).toBe(maxLineBytes);
    decoder.write('\n');
    expect(records).toEqual([exact]);
  });

  it('decodes a record fed one byte at a time to the same object as when fed whole', async () => {
    const whole = await decode([Buffer.from(line, 'utf8')]);
    const trickled = await decode(oneByteChunks(line));

    expect(whole.records).toEqual([record]);
    expect(trickled.records).toEqual(whole.records);
    expect(trickled.skipped).toEqual([]);
  });

  it('counts a line over maxLineBytes fed one byte at a time once as oversized and keeps none of it', async () => {
    const maxLineBytes = 256;
    const long = JSON.stringify({ msg: 'y'.repeat(1000) });
    const after = { ok: true };
    const chunks = oneByteChunks(`${long}\n${JSON.stringify(after)}\n`);

    const result = await decode(chunks, { maxLineBytes });

    expect(result.oversized).toBe(1);
    expect(result.invalid).toBe(0);
    expect(result.skipped).toEqual([{ reason: 'oversized', bytes: Buffer.byteLength(long) }]);
    // Nothing of the long line leaks into the next record.
    expect(result.records).toEqual([after]);
  });
});
