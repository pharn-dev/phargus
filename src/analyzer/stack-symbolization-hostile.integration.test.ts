// CORE-253: a hostile source map is reported as malformed, never an abort or a worker crash.
// The forged-length maps run in a child Node process: on the unfixed worker they made V8 abort the
// whole process ("Reached heap limit"), which would take the test runner down with it.
import { spawnSync } from 'node:child_process';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSymbolizationPool,
  MalformedSourceMapError,
  symbolizeStackFrames,
  type WorkerPool,
} from './index.js';

const srcDir = fileURLToPath(new URL('.', import.meta.url));
const MIB = 1024 * 1024;

// The 70-byte map from the report: Node's SourceMap loops to `sources.length` and pushes each item.
const FORGED_MAP = '{"version":3,"sources":{"length":4294967295},"names":[],"mappings":""}';
const GOOD_MAP = { version: 3, sources: ['src/app.ts'], names: [], mappings: 'AAAA' };

// Lets a plain `node` child import this module's TypeScript sources (`./x.js` -> `./x.ts`).
const TS_HOOKS = `
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return next(specifier.slice(0, -3) + '.ts', context);
      }
      throw error;
    }
  },
});
`;
const TS_HOOKS_URL = `data:text/javascript,${encodeURIComponent(TS_HOOKS)}`;

function builtFile(mapUrl: string): string {
  return `console.log(1);\n//# sourceMappingURL=${mapUrl}\n`;
}

function frame(path: string): { url: string; line: number; column: number } {
  return { url: pathToFileURL(path).href, line: 1, column: 1 };
}

let dir: string;
let pool: WorkerPool;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phargus-hostile-map-'));
  pool = createSymbolizationPool();
});

afterAll(async () => {
  await pool.close();
  await rm(dir, { recursive: true, force: true });
});

describe('hostile source maps (CORE-253)', () => {
  it('reports a forged sources length as malformed and the host stays alive', async () => {
    expect(FORGED_MAP).toHaveLength(70);
    const inline = `data:application/json;base64,${Buffer.from(FORGED_MAP).toString('base64')}`;
    const sectioned = JSON.stringify({
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: GOOD_MAP },
        { offset: { line: 1, column: 0 }, map: JSON.parse(FORGED_MAP) as unknown },
      ],
    });
    await writeFile(join(dir, 'forged.js.map'), FORGED_MAP);
    await writeFile(join(dir, 'forged.js'), builtFile('forged.js.map'));
    await writeFile(join(dir, 'inline.js'), builtFile(inline));
    await writeFile(join(dir, 'sectioned.js.map'), sectioned);
    await writeFile(join(dir, 'sectioned.js'), builtFile('sectioned.js.map'));
    await writeFile(join(dir, 'app.js.map'), JSON.stringify(GOOD_MAP));
    await writeFile(join(dir, 'app.js'), builtFile('app.js.map'));

    const script = `
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [srcDir, dir] = process.argv.slice(2);
const load = (name) => import(pathToFileURL(join(srcDir, name)).href);
const { symbolizeStackFrames } = await load('stack-symbolization.ts');
const { MalformedSourceMapError } = await load('source-map-error.ts');
const names = ['forged.js', 'inline.js', 'sectioned.js', 'app.js'];
const frames = names.map((name) => ({ url: pathToFileURL(join(dir, name)).href, line: 1, column: 1 }));
const result = await symbolizeStackFrames(frames, { roots: [dir] });
console.log(JSON.stringify(result.map((item, index) => ({
  name: names[index],
  malformed: item.error instanceof MalformedSourceMapError,
  mapped: item.original !== undefined,
}))));
`;
    const scriptPath = join(dir, 'forged-host.mjs');
    await writeFile(scriptPath, script);
    const child = spawnSync(process.execPath, ['--import', TS_HOOKS_URL, scriptPath, srcDir, dir], {
      cwd: srcDir,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const output = `${child.stdout}\n${child.stderr}`.slice(-4000);
    expect(child.signal, output).toBeNull();
    expect(child.status, output).toBe(0);
    const lines = child.stdout.trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1] ?? '')).toEqual([
      { name: 'forged.js', malformed: true, mapped: false },
      { name: 'inline.js', malformed: true, mapped: false },
      { name: 'sectioned.js', malformed: true, mapped: false },
      { name: 'app.js', malformed: false, mapped: true },
    ]);
  }, 70_000);

  it('reports a mapping-dense 30 MiB map as malformed and still maps the other frames', async () => {
    const dense = JSON.stringify({
      version: 3,
      sources: ['src/dense.ts'],
      names: [],
      mappings: 'AAAA,'.repeat((30 * MIB) / 5),
    });
    await writeFile(join(dir, 'dense.js.map'), dense);
    await writeFile(join(dir, 'dense.js'), builtFile('dense.js.map'));
    await writeFile(join(dir, 'ok.js.map'), JSON.stringify(GOOD_MAP));
    await writeFile(join(dir, 'ok.js'), builtFile('ok.js.map'));

    const [denseFrame, okFrame] = await symbolizeStackFrames(
      [frame(join(dir, 'dense.js')), frame(join(dir, 'ok.js'))],
      { pool, roots: [dir], timeoutMs: 60_000 },
    );
    expect(denseFrame?.error).toBeInstanceOf(MalformedSourceMapError);
    expect(denseFrame?.original).toBeUndefined();
    expect(okFrame?.error).toBeUndefined();
    expect(okFrame?.original?.url).toBe(pathToFileURL(join(dir, 'src', 'app.ts')).href);
  }, 70_000);

  it('leaves a 64 MiB newline-only file unsymbolized without crashing the worker', async () => {
    const path = join(dir, 'newlines.js');
    const handle = await open(path, 'w');
    try {
      const chunk = Buffer.alloc(MIB, 0x0a);
      for (let index = 0; index < 64; index += 1) await handle.write(chunk);
    } finally {
      await handle.close();
    }
    const [result] = await symbolizeStackFrames([frame(path)], {
      pool,
      roots: [dir],
      timeoutMs: 60_000,
    });
    expect(result).toEqual(frame(path));
  }, 70_000);
});
