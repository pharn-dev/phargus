import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { countNdjson } from './ndjson-count.mjs';

const sample = (events) => JSON.stringify({ timestamp: 1, backpressure: { events, hotspots: [] } });
const span = JSON.stringify({ traceId: 'a', name: 'GET /é' });

describe('countNdjson', () => {
  it('counts bytes and lines and sums the backpressure events of sample lines', async () => {
    const text = `${sample(3)}\n${span}\n${sample(4)}\n`;
    // Split mid-line and mid-character, as a pipe may deliver it.
    const bytes = Buffer.from(text);
    const cut = bytes.indexOf(Buffer.from('é')) + 1;
    const counts = await countNdjson(Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]));
    expect(counts).toEqual({ bytes: bytes.length, lines: 3, bpEvents: 7 });
  });

  it('counts a final line without a newline, and nothing for an empty stream', async () => {
    expect(await countNdjson(Readable.from([Buffer.from(sample(2))]))).toMatchObject({
      lines: 1,
      bpEvents: 2,
    });
    expect(await countNdjson(Readable.from([]))).toEqual({ bytes: 0, lines: 0, bpEvents: 0 });
  });

  it('rejects a malformed sample line', async () => {
    const bad = Readable.from([Buffer.from('{"backpressure": nope}\n')]);
    await expect(countNdjson(bad)).rejects.toThrow(SyntaxError);
  });
});
