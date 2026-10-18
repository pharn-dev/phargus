import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type StackFrame = { url: string; line: number; column: number };

type SymbolizedFrame = StackFrame & {
  original?: { url: string; line: number; column: number };
  error?: Error;
};

type SymbolizeModule = {
  symbolizeStackFrames: (
    frames: readonly StackFrame[],
    options?: { timeoutMs?: number; roots?: readonly string[] | null },
  ) => Promise<SymbolizedFrame[]>;
  MalformedSourceMapError: abstract new (...args: never[]) => Error;
};

// Two mapped lines, each with a segment at column 0, so a frame at line 1, column 1
// resolves whether the symbolizer reads positions as 0- or 1-based.
function validMap(file: string, source: string): string {
  return JSON.stringify({
    version: 3,
    file,
    sources: [source],
    sourcesContent: ['export const value = 1;\nexport const other = 2;\n'],
    names: [],
    mappings: 'AAAA;AACA',
  });
}

async function writeBuilt(dir: string, name: string, map: string): Promise<StackFrame> {
  const file = join(dir, name);
  await writeFile(file, `const value = 1;\nconst other = 2;\n//# sourceMappingURL=${name}.map\n`);
  await writeFile(`${file}.map`, map);
  return { url: pathToFileURL(file).href, line: 1, column: 1 };
}

describe('symbolizer default roots: roots: null opts into unconfined reads', () => {
  it('AC-3: maps a frame outside the working directory and reports a malformed map there, with roots: null', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'phargus-default-roots-ac3-')));
    try {
      const goodFrame = await writeBuilt(outside, 'good.js', validMap('good.js', 'good.ts'));
      const badFrame = await writeBuilt(outside, 'bad.js', 'this is { not json');

      const mod = (await import('./index.js')) as unknown as SymbolizeModule;
      const result = await mod.symbolizeStackFrames([goodFrame, badFrame], {
        timeoutMs: 30_000,
        roots: null,
      });

      expect(result).toHaveLength(2);

      const good = result[0];
      expect(good).not.toHaveProperty('error');
      expect(good?.original).toBeDefined();
      expect(good?.original?.url.endsWith('good.ts')).toBe(true);

      const bad = result[1];
      expect(bad?.error).toBeInstanceOf(mod.MalformedSourceMapError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }, 60_000);
});
