import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { encodeNdjsonLine } from '../agent/ndjson-exporter.js';
import { main, type MainIo } from './main.js';

const URL_LINE = /^dashboard at http:\/\/127\.0\.0\.1:(\d+)$/;
const TIMEOUT_MS = 15_000;
const BASE_MS = 1_700_000_000_000;
const MS = 1_000_000;

const dir = mkdtempSync(join(tmpdir(), 'phargus-serve-alert-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A full agent sample whose event-loop p99 is `p99Ns` nanoseconds. */
function sample(timestamp: number, p99Ns: number): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: MS, max: p99Ns, mean: MS, p50: MS, p99: p99Ns },
    memory: { heapUsed: 1000, heapTotal: 4000, rss: 9000, external: 0, arrayBuffers: 0 },
    gc: {
      count: 0,
      totalPause: 0,
      maxPause: 0,
      kinds: { minor: 0, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
    dropped: { samples: 0, spans: 0 },
  };
}

/** A capture with one lag spike: 5 ms, 120 ms, 5 ms, 5 ms, one sample per one-second window. */
function writeCapture(): string {
  const path = join(dir, 'spike.ndjson');
  const p99s = [5 * MS, 120 * MS, 5 * MS, 5 * MS];
  writeFileSync(
    path,
    p99s.map((p99, i) => encodeNdjsonLine(sample(BASE_MS + i * 1000 + 100, p99))).join(''),
  );
  return path;
}

type Served = { port: number; lines: string[]; stop: () => Promise<number> };

/** Runs `main` in-process, resolving once the dashboard URL line is written. */
async function serve(argv: readonly string[]): Promise<Served> {
  const signals = new EventEmitter();
  const lines: string[] = [];
  let onUrl: (port: number) => void = () => undefined;
  const started = new Promise<number>((resolve) => {
    onUrl = resolve;
  });
  const io: MainIo = {
    env: {},
    stdin: () => new PassThrough(),
    output: () => new PassThrough(),
    signals,
    write: (text) => {
      lines.push(text);
      const match = URL_LINE.exec(text);
      if (match?.[1] !== undefined) {
        onUrl(Number(match[1]));
      }
    },
    forceExit: (code) => {
      throw new Error(`forced exit ${String(code)}: ${lines.join('\n')}`);
    },
    stdout: () => undefined,
  };
  const exited = main(argv, io);
  const port = await Promise.race([
    started,
    exited.then((code) => {
      throw new Error(`serve exited early with ${String(code)}: ${lines.join('\n')}`);
    }),
  ]);
  return {
    port,
    lines,
    stop: () => {
      signals.emit('SIGTERM');
      return exited;
    },
  };
}

async function waitFor(what: string, lines: string[], done: () => boolean): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}:\n${lines.join('\n')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The `alert` events GET /events replays, read until `count` have arrived. */
function alertEvents(port: number, count: number): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    let body = '';
    const req: ClientRequest = request(
      { host: '127.0.0.1', port, path: '/events', method: 'GET' },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          const alerts = body
            .split('\n\n')
            .filter((block) => block.startsWith('event: alert\n'))
            .map(
              (block) =>
                JSON.parse(block.slice(block.indexOf('data: ') + 6)) as Record<string, unknown>,
            );
          if (alerts.length >= count) {
            clearTimeout(timer);
            req.destroy();
            resolve(alerts);
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`no ${String(count)} alert events in time:\n${body}`));
    }, TIMEOUT_MS);
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

const INPUT_ENDED = 'input ended; still serving the collected data (Ctrl-C to stop)';

describe('phargus serve --alert: a replayed lag spike', () => {
  it('prints one firing and one resolved line on stderr, and the page receives both alerts', async () => {
    const capture = writeCapture();
    const served = await serve(['serve', '--port', '0', '--alert', 'eventLoop.p99>50ms', capture]);
    try {
      await waitFor('the input end', served.lines, () => served.lines.includes(INPUT_ENDED));
      const alertLines = served.lines.filter((line) => line.startsWith('alert '));
      expect(alertLines).toEqual([
        `alert firing "eventLoop.p99>50ms": eventLoop.p99 is ${String(120 * MS)} in the window starting ${String(BASE_MS + 1000)}`,
        `alert resolved "eventLoop.p99>50ms": eventLoop.p99 is ${String(5 * MS)} in the window starting ${String(BASE_MS + 2000)}`,
      ]);

      const alerts = await alertEvents(served.port, 2);
      expect(alerts.map((alert) => [alert['ruleId'], alert['state'], alert['observed']])).toEqual([
        ['eventLoop.p99>50ms', 'firing', 120 * MS],
        ['eventLoop.p99>50ms', 'resolved', 5 * MS],
      ]);
    } finally {
      expect(await served.stop()).toBe(0);
    }
  }, 30_000);

  it('prints no alert line without --alert', async () => {
    const served = await serve(['serve', '--port', '0', writeCapture()]);
    try {
      await waitFor('the input end', served.lines, () => served.lines.includes(INPUT_ENDED));
      expect(served.lines.filter((line) => line.startsWith('alert '))).toEqual([]);
    } finally {
      expect(await served.stop()).toBe(0);
    }
  }, 30_000);
});
