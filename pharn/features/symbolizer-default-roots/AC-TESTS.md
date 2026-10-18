---
spec_id: symbolizer-default-roots
spec_content_hash: 476bfd89889fa33979f3d7ad9a069ce50a56937e737a40537e07107eb75a9fb3
---

## Files

- `src/analyzer/symbolizer-default-roots.ac1.integration.test.ts` — the tests for AC-1
- `src/analyzer/symbolizer-default-roots.ac2.integration.test.ts` — the tests for AC-2
- `src/analyzer/symbolizer-default-roots.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/analyzer/symbolizer-default-roots.ac1.integration.test.ts` | src/analyzer/index.ts#symbolizeStackFrames(frames: readonly StackFrame[], options?: { pool?: WorkerPool; timeoutMs?: number; roots?: readonly string[] | null; maxFileBytes?: number }): Promise<SymbolizedFrame[]> — StackFrame = { url: string; line: number; column: number }; SymbolizedFrame = StackFrame & { original?: { url: string; line: number; column: number }; error?: MalformedSourceMapError }; driven in-process (vitest, imported from ./index.js) with the repository root as process.cwd(): an outside directory from mkdtemp(join(os.tmpdir(), …)) holding good.js + valid adjacent good.js.map and bad.js + non-JSON bad.js.map, and an inside directory from mkdtemp(join(process.cwd(), '.…')) holding inside.js + valid adjacent inside.js.map; one file:// frame per built file, called with { timeoutMs } and no roots key; expects the two outside results toEqual their input frames (no original, no error property) and the inside result's original defined with a url ending in its map's source; both directories removed in finally
- AC-2 | integration | `src/analyzer/symbolizer-default-roots.ac2.integration.test.ts` | src/analyzer/index.ts#symbolizeStackFrames(frames: readonly StackFrame[], options?: { timeoutMs?: number; roots?: readonly string[] | null }): Promise<SymbolizedFrame[]> — driven in-process (vitest, imported from ./index.js): an outside directory from mkdtemp(join(os.tmpdir(), …)) holding a valid source map, and an inside directory under process.cwd() holding a built file whose //# sourceMappingURL= is the pathToFileURL href of that outside map; one file:// frame for the built file, called with no roots key; expects the result toEqual the input frame (no original, no error property); both directories removed in finally
- AC-3 | integration | `src/analyzer/symbolizer-default-roots.ac3.integration.test.ts` | src/analyzer/index.ts#symbolizeStackFrames(frames: readonly StackFrame[], options?: { timeoutMs?: number; roots?: readonly string[] | null }): Promise<SymbolizedFrame[]> and MalformedSourceMapError — driven in-process (vitest, imported from ./index.js): the same two outside-the-working-directory built files as AC-1 (good.js with a valid map, bad.js with a non-JSON map) under mkdtemp(join(os.tmpdir(), …)); one frame each, called with { roots: null }; expects the good frame's original defined (url ending in its map's source) and the bad frame's error toBeInstanceOf the exported MalformedSourceMapError; directory removed in finally
