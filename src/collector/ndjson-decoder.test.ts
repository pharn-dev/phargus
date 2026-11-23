import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
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

describe('NDJSON decoder: agentOnly', () => {
  const sample = {
    timestamp: 1_700_000_000_000,
    eventLoop: { min: 1, max: 20, mean: 10, p50: 9, p99: 18 },
    memory: { heapUsed: 1000, heapTotal: 4000, rss: 9000, external: 0, arrayBuffers: 0 },
    gc: { count: 1, totalPause: 3, maxPause: 3 },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
  };
  const pino = JSON.stringify({ level: 30, time: 1, pid: 42, msg: 'request completed' });

  it('reports a JSON object the collector calls foreign with its raw line and counts it, without emitting it', async () => {
    const raw = `  ${pino}  `;
    const result = await decode([Buffer.from(`${raw}\n${JSON.stringify(sample)}\n`)], {
      agentOnly: true,
    });

    expect(result.records).toEqual([sample]);
    expect(result.skipped).toEqual([{ reason: 'foreign', line: raw }]);
    expect(result.invalid).toBe(0);
  });

  it('counts foreign objects with agentOnly; without it the counter stays 0 and the object is emitted', async () => {
    const withOption = createNdjsonDecoder({ agentOnly: true });
    const without = createNdjsonDecoder();
    const emitted: unknown[] = [];
    without.on('data', (value: unknown) => emitted.push(value));
    withOption.resume();
    withOption.end(`${pino}\n${pino}\n`);
    without.end(`${pino}\n`);
    await Promise.all([finished(withOption), finished(without)]);

    expect(withOption.foreign).toBe(2);
    expect(without.foreign).toBe(0);
    expect(emitted).toEqual([JSON.parse(pino)]);
  });

  it('still emits a malformed agent record, which the collector counts, and never reports it as foreign', async () => {
    const malformed = { ...sample, timestamp: 'soon' };
    const result = await decode([Buffer.from(`${JSON.stringify(malformed)}\n`)], {
      agentOnly: true,
    });

    expect(result.records).toEqual([malformed]);
    expect(result.skipped).toEqual([]);
  });

  it('reports 1,000 alternating text and JSON log lines in input order, interleaved with agent samples', async () => {
    const lines: string[] = [];
    let input = '';
    for (let index = 0; index < 1000; index += 1) {
      const line =
        index % 2 === 0
          ? `plain log line ${String(index)}`
          : JSON.stringify({ level: 30, msg: `json log line ${String(index)}` });
      lines.push(line);
      input += `${line}\n`;
      if (index % 100 === 0) {
        input += `${JSON.stringify(sample)}\n`;
      }
    }

    const result = await decode([Buffer.from(input)], { agentOnly: true });

    expect(result.skipped.map((skip) => (skip.reason === 'oversized' ? '' : skip.line))).toEqual(
      lines,
    );
    expect(result.skipped.map((skip) => skip.reason)).toEqual(
      lines.map((_, index) => (index % 2 === 0 ? 'invalid' : 'foreign')),
    );
    expect(result.records).toHaveLength(10);
  });
});
