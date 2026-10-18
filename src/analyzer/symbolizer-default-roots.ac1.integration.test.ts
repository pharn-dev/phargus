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

describe('symbolizer default roots: confined to the working directory when roots is left out', () => {
  it('AC-1: leaves frames outside the working directory unchanged and maps a frame inside it, with no roots option', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'phargus-default-roots-ac1-')));
    const inside = await mkdtemp(join(process.cwd(), '.phargus-default-roots-ac1-'));
    try {
      const goodFrame = await writeBuilt(outside, 'good.js', validMap('good.js', 'good.ts'));
      const badFrame = await writeBuilt(outside, 'bad.js', 'this is { not json');
      const insideFrame = await writeBuilt(inside, 'inside.js', validMap('inside.js', 'inside.ts'));

      const mod = (await import('./index.js')) as unknown as SymbolizeModule;
      const result = await mod.symbolizeStackFrames([goodFrame, badFrame, insideFrame], {
        timeoutMs: 30_000,
      });

      expect(result).toHaveLength(3);

      expect(result[0]).toEqual(goodFrame);
      expect(result[0]).not.toHaveProperty('original');
      expect(result[0]).not.toHaveProperty('error');

      expect(result[1]).toEqual(badFrame);
      expect(result[1]).not.toHaveProperty('original');
      expect(result[1]).not.toHaveProperty('error');

      const mapped = result[2];
      expect(mapped).not.toHaveProperty('error');
      expect(mapped?.original).toBeDefined();
      expect(mapped?.original?.url.endsWith('inside.ts')).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(inside, { recursive: true, force: true });
    }
  }, 60_000);
});
