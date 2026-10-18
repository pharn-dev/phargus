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
};

describe('symbolizer default roots: a source map outside the working directory is not read', () => {
  it('AC-2: leaves a frame unchanged when its built file is inside the working directory but its sourceMappingURL names a map outside, with no roots option', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'phargus-default-roots-ac2-')));
    const inside = await mkdtemp(join(process.cwd(), '.phargus-default-roots-ac2-'));
    try {
      const mapFile = join(outside, 'outside.js.map');
      // Two mapped lines, each with a segment at column 0, so the frame would resolve
      // whether positions are read as 0- or 1-based, if the map were read at all.
      await writeFile(
        mapFile,
        JSON.stringify({
          version: 3,
          file: 'inside.js',
          sources: ['outside.ts'],
          sourcesContent: ['export const value = 1;\nexport const other = 2;\n'],
          names: [],
          mappings: 'AAAA;AACA',
        }),
      );

      const built = join(inside, 'inside.js');
      await writeFile(
        built,
        `const value = 1;\nconst other = 2;\n//# sourceMappingURL=${pathToFileURL(mapFile).href}\n`,
      );
      const frame: StackFrame = { url: pathToFileURL(built).href, line: 1, column: 1 };

      const mod = (await import('./index.js')) as unknown as SymbolizeModule;
      const result = await mod.symbolizeStackFrames([frame], { timeoutMs: 30_000 });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(frame);
      expect(result[0]).not.toHaveProperty('original');
      expect(result[0]).not.toHaveProperty('error');
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(inside, { recursive: true, force: true });
    }
  }, 60_000);
});
