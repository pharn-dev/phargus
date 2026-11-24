// CORE-253: the symbolize worker's source-map checks, driven in-process through a stand-in
// parentPort so the worker's own lines are measured (code in a real Worker Thread is not).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as V8 from 'node:v8';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TaskReply, TaskRequest } from './worker-pool.js';

const worker = vi.hoisted(() => ({
  handler: undefined as ((request: TaskRequest) => void) | undefined,
  reply: undefined as ((reply: TaskReply) => void) | undefined,
  /** When set, the worker sees only this many bytes of free heap. */
  freeHeap: undefined as number | undefined,
}));

vi.mock('node:worker_threads', () => ({
  parentPort: {
    on: (_event: string, handler: (request: TaskRequest) => void) => {
      worker.handler = handler;
    },
    postMessage: (reply: TaskReply) => worker.reply?.(reply),
  },
}));

vi.mock('node:v8', async (importOriginal) => {
  const v8 = await importOriginal<typeof V8>();
  return {
    ...v8,
    getHeapStatistics: () => {
      const stats = v8.getHeapStatistics();
      if (worker.freeHeap === undefined) return stats;
      return { ...stats, heap_size_limit: stats.used_heap_size + worker.freeHeap };
    },
  };
});

const FORGED = { version: 3, sources: { length: 4294967295 }, names: [], mappings: '' };
const GOOD = { version: 3, sources: ['src/app.ts'], names: [], mappings: 'AAAA' };

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phargus-symbolize-worker-'));
  await import('./workers/symbolize.worker.js');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes `name` with `body` and symbolizes one frame at its first line and column. */
async function symbolize(name: string, body: string): Promise<unknown> {
  const path = join(dir, name);
  await writeFile(path, body);
  const payload = {
    frames: [{ url: pathToFileURL(path).href, line: 1, column: 1 }],
    maxFileBytes: 1024 * 1024,
    roots: [dir],
  };
  const reply = await new Promise<TaskReply>((resolve) => {
    worker.reply = resolve;
    worker.handler?.({ id: 1, payload });
  });
  expect(reply.ok).toBe(true);
  return reply.ok ? (reply.value as unknown[])[0] : undefined;
}

function withMap(map: unknown): string {
  const encoded = Buffer.from(JSON.stringify(map)).toString('base64');
  return `console.log(1);\n//# sourceMappingURL=data:application/json;base64,${encoded}\n`;
}

function malformed(reason: string): unknown {
  return expect.objectContaining({ status: 'malformed', reason });
}

const NO_SHAPE = 'source map has no sources array or mappings string';

describe('symbolize worker source-map checks (CORE-253)', () => {
  it('reports a forged sources length as malformed, as a .map file and inline', async () => {
    await writeFile(join(dir, 'forged.js.map'), JSON.stringify(FORGED));
    await expect(
      symbolize('forged.js', 'x\n//# sourceMappingURL=forged.js.map\n'),
    ).resolves.toEqual(malformed(NO_SHAPE));
    await expect(symbolize('inline.js', withMap(FORGED))).resolves.toEqual(malformed(NO_SHAPE));
    await expect(symbolize('no-mappings.js', withMap({ ...GOOD, mappings: 1 }))).resolves.toEqual(
      malformed(NO_SHAPE),
    );
  });

  it('checks every section of a sectioned map', async () => {
    const section = (map: unknown, line: number) => ({ offset: { line, column: 0 }, map });
    await expect(
      symbolize(
        'one-bad.js',
        withMap({ version: 3, sections: [section(GOOD, 0), section(FORGED, 1)] }),
      ),
    ).resolves.toEqual(malformed(NO_SHAPE));
    await expect(
      symbolize('null-section.js', withMap({ version: 3, sections: [null] })),
    ).resolves.toEqual(malformed(NO_SHAPE));
    await expect(
      symbolize('object-sections.js', withMap({ version: 3, sections: { length: 4294967295 } })),
    ).resolves.toEqual(malformed(NO_SHAPE));
    await expect(
      symbolize('good-sections.js', withMap({ version: 3, sections: [section(GOOD, 0)] })),
    ).resolves.toMatchObject({ status: 'mapped', line: 1, column: 1 });
  });

  it('reports mappings longer than 1/32 of the free heap as malformed', async () => {
    // 500 mapping bytes: the parse fits in half of 8,000 free bytes, decoding not in 1/32 of it.
    const dense = { ...GOOD, mappings: 'AAAA,'.repeat(100) };
    worker.freeHeap = 8000;
    try {
      await expect(symbolize('dense.js', withMap(dense))).resolves.toEqual(
        malformed('source map mappings are too large to decode in the worker heap'),
      );
    } finally {
      worker.freeHeap = undefined;
    }
    await expect(symbolize('fits.js', withMap(dense))).resolves.toMatchObject({ status: 'mapped' });
  });

  it('finds the last sourceMappingURL comment above trailing blank lines', async () => {
    await expect(symbolize('trailing.js', `${withMap(GOOD)}\n\n  \n`)).resolves.toMatchObject({
      status: 'mapped',
    });
    await expect(symbolize('newlines.js', '\n'.repeat(1000))).resolves.toEqual({
      status: 'unchanged',
    });
    await expect(symbolize('empty.js', '')).resolves.toEqual({ status: 'unchanged' });
  });
});
