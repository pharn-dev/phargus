import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main, type MainIo } from './main.js';

const URL_LINE = /^dashboard at http:\/\/127\.0\.0\.1:(\d+)$/;
const COUNTS_LINE = /^counts: .*$/;
const BASE_MS = 1_700_000_000_000;

function sampleLine(timestamp: number, dropped?: { samples: number; spans: number }): string {
  return `${JSON.stringify({
    timestamp,
    pid: 4242,
    eventLoop: { min: 1, max: 2, mean: 1, p50: 1, p99: 2 },
    memory: { heapUsed: 10, heapTotal: 20, rss: 30, external: 0, arrayBuffers: 0 },
    gc: {
      count: 0,
      totalPause: 0,
      maxPause: 0,
      kinds: { minor: 0, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
    ...(dropped === undefined ? {} : { dropped }),
  })}\n`;
}

/** Runs `phargus serve` in-process on `input`, and returns the first `counts:` line after the input ends. */
async function countsLineFor(input: string): Promise<string> {
  const signals = new EventEmitter();
  const lines: string[] = [];
  let onCounts: (line: string) => void = () => undefined;
  const counted = new Promise<string>((resolve) => {
    onCounts = resolve;
  });
  let onUrl: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    onUrl = resolve;
  });
  const stdin = new PassThrough();
  const io: MainIo = {
    env: {},
    stdin: () => stdin,
    output: () => new PassThrough(),
    signals,
    write: (text) => {
      lines.push(text);
      if (URL_LINE.test(text)) {
        onUrl();
      }
      if (COUNTS_LINE.test(text)) {
        onCounts(text);
      }
    },
    forceExit: (code) => {
      throw new Error(`forced exit ${String(code)}: ${lines.join('\n')}`);
    },
    stdout: () => undefined,
  };

  const exited = main(['serve', '--port', '0', '--window-ms', '1000'], io);
  const early = exited.then((code): never => {
    throw new Error(`serve exited early with ${String(code)}: ${lines.join('\n')}`);
  });
  await Promise.race([started, early]);
  stdin.end(input);
  try {
    return await Promise.race([counted, early]);
  } finally {
    signals.emit('SIGTERM');
    expect(await exited).toBe(0);
  }
}

describe('phargus serve: the agent drop counters on the counts: line', () => {
  it('reports the latest window’s agent.droppedSamples and agent.droppedSpans', async () => {
    const line = await countsLineFor(
      sampleLine(BASE_MS + 100, { samples: 0, spans: 3 }) +
        sampleLine(BASE_MS + 1_100, { samples: 2, spans: 40 }),
    );
    expect(line).toContain(' agent.droppedSamples=2 agent.droppedSpans=40');
  }, 30_000);

  it('reports zeros when the samples carry no counters', async () => {
    const line = await countsLineFor(sampleLine(BASE_MS + 100));
    expect(line).toContain(' agent.droppedSamples=0 agent.droppedSpans=0');
  }, 30_000);
});
