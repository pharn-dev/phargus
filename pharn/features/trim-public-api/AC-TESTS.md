---
spec_id: trim-public-api
spec_content_hash: a046bbb4474181efca54426a886dd3ea228ecd9b7e090a4c27a88c4954782732
---

## Files

- `src/release/public-api-surface.ac1.integration.test.ts` — the tests for AC-1
- `src/release/public-api-surface.ac2.integration.test.ts` — the tests for AC-2
- `src/release/public-api-surface.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/release/public-api-surface.ac1.integration.test.ts` | the built package (fresh `npm run build` = `node scripts/build.mjs`, rebuilt when dist/ is older than the newest non-test src .ts, under the cross-process build lock the src/cli tests use) loaded by package self-reference: `import('@pharn-dev/phargus/<subpath>')` and `createRequire(...)('@pharn-dev/phargus/<subpath>')` for agent, collector, analyzer, dashboard, plugin-runner, otel, reading `Object.keys(module)`; and each subpath's `exports[sub].import.types` / `exports[sub].require.types` file (dist/esm|cjs/agent/auto.d.ts, dist/esm|cjs/<sub>/index.d.ts) read with the `typescript` devDependency's checker (`ts.createProgram([file], { module: NodeNext, moduleResolution: NodeNext })`, `checker.getExportsOfModule(checker.getSymbolAtLocation(sourceFile))`, which follows `export *` and re-exports) for the declaration export names
- AC-2 | integration | `src/release/public-api-surface.ac2.integration.test.ts` | command `npm run check:exports` = `node scripts/check-exports.mjs` with cwd at a package root, exit status plus stderr; run once at the repo root on the fresh build, then at a temp copy (package.json, scripts/check-exports.mjs and dist/ copied into a mkdtemp dir, so the copy's script self-resolves the copy) in which one subpath's ESM entry (e.g. dist/esm/dashboard/index.js) gains an appended `export const <extra> = 1;` and another subpath's CJS entry (e.g. dist/cjs/otel/index.js) is replaced by a wrapper that re-exports the original minus one name; drift is reported on stderr as `FAIL <format padded to 7> <specifier>: runtime exports differ from the expected list; added: <names|none>; missing: <names|none>` with format `import` or `require` and specifier `@pharn-dev/phargus/<subpath>`, exit status 1
- AC-3 | integration | `src/release/public-api-surface.ac3.integration.test.ts` | files `docs/API.md`, `README.md`, `CHANGELOG.md` read as text, against the built package's runtime keys and declaration exports (derived as in AC-1): in docs/API.md each subpath's section runs from a heading line containing `@pharn-dev/phargus/<subpath>` to the next `## ` heading and names each export as `` `name` ``, and the page has a sentence matching /not listed[^.]*internal/i; the README `## Documentation` table links `docs/API.md`; CHANGELOG `## [Unreleased]` (to the next `## [`) has a `### Removed` subsection (to the next `### ` or `## `) containing each of the twenty removed names in backticks and the word `breaking`
