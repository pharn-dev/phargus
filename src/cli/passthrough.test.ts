import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseServeArgs } from './args.js';
import { MAX_PENDING_BYTES, createPassthrough } from './passthrough.js';
import { defaultServeIo } from './serve.js';

/** A stdout whose writes never complete, so every written byte stays pending. */
function stuckOutput(): { stream: Writable; written: string[] } {
  const written: string[] = [];
  const stream = new Writable({
    highWaterMark: 1,
    // The callback is never called, so the stream never finishes a write.
    write(chunk: Buffer): void {
      written.push(chunk.toString('utf8'));
    },
  });
  return { stream, written };
}

describe('passthrough of the app output', () => {
  it('writes text and foreign lines with a newline, in order, and never an oversized line', () => {
    const written: string[] = [];
    let opened = 0;
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        written.push(chunk.toString('utf8'));
        callback();
      },
    });
    const passthrough = createPassthrough(
      () => {
        opened += 1;
        return stream;
      },
      () => undefined,
    );
    expect(opened).toBe(0);

    passthrough.onSkipped({ reason: 'invalid', line: 'GET /a 200' });
    passthrough.onSkipped({ reason: 'oversized', bytes: 5000 });
    passthrough.onSkipped({ reason: 'foreign', line: '{"level":30,"msg":"b"}' });

    expect(written).toEqual(['GET /a 200\n', '{"level":30,"msg":"b"}\n']);
    expect(opened).toBe(1);
    expect(passthrough.dropped).toBe(0);
  });

  it('drops and counts lines once more than 1 MiB is waiting', () => {
    const { stream, written } = stuckOutput();
    const passthrough = createPassthrough(
      () => stream,
      () => undefined,
    );
    const line = 'z'.repeat(1023);
    const fits = Math.floor(MAX_PENDING_BYTES / 1024) + 1;

    for (let index = 0; index < fits + 10; index += 1) {
      passthrough.onSkipped({ reason: 'invalid', line });
    }

    expect(stream.writableLength).toBeLessThanOrEqual(MAX_PENDING_BYTES + 1024);
    expect(passthrough.dropped).toBe(10);
    expect(written.length).toBeGreaterThan(0);
  });

  it('stops after a stdout error with one reported line and writes nothing more', () => {
    const written: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        written.push(chunk.toString('utf8'));
        callback();
      },
    });
    const reported: string[] = [];
    const passthrough = createPassthrough(
      () => stream,
      (text) => reported.push(text),
    );
    passthrough.onSkipped({ reason: 'invalid', line: 'before' });

    const epipe: NodeJS.ErrnoException = new Error('write EPIPE');
    epipe.code = 'EPIPE';
    stream.emit('error', epipe);
    stream.emit('error', new Error('again'));
    passthrough.onSkipped({ reason: 'foreign', line: '{"after":true}' });

    expect(reported).toEqual(['passthrough stopped: stdout failed (EPIPE)']);
    expect(written).toEqual(['before\n']);
    expect(passthrough.dropped).toBe(0);
  });

  it('names the error message when the error has no code', () => {
    const reported: string[] = [];
    const stream = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    const passthrough = createPassthrough(
      () => stream,
      (text) => reported.push(text),
    );
    passthrough.onSkipped({ reason: 'invalid', line: 'x' });
    stream.emit('error', new Error('broken'));

    expect(reported).toEqual(['passthrough stopped: stdout failed (broken)']);
  });
});

describe('phargus serve: the passthrough option', () => {
  it('is on for stdin, off for a file, and off with --no-passthrough', () => {
    const passthroughOf = (argv: string[]): boolean => {
      const parsed = parseServeArgs(argv, {});
      return parsed.kind === 'serve' && parsed.options.passthrough;
    };

    expect(passthroughOf(['serve'])).toBe(true);
    expect(passthroughOf(['serve', '-'])).toBe(true);
    expect(passthroughOf(['serve', 'capture.ndjson'])).toBe(false);
    expect(passthroughOf(['serve', '--no-passthrough'])).toBe(false);
  });

  it('passes the app output through to process.stdout by default', () => {
    expect(defaultServeIo().output()).toBe(process.stdout);
  });
});
