import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, cliEnv, repoRoot, tempDir } from '../../test/support.js';

// AC-2: `npm run check:exports` (= `node scripts/check-exports.mjs`) is green on the built package and
// red, naming each drifted name with its subpath and format, on a copy whose runtime exports drifted.

/** The extra runtime export appended to the copy's ESM dashboard entry. */
const EXTRA_NAME = 'phargusDriftExtra';
/** The runtime export the copy's CommonJS otel entry stops exporting. */
const DROPPED_NAME = 'toOtlpTraces';

const CHECK_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 300_000;

/** `npm run check:exports` is `node scripts/check-exports.mjs`, run with cwd at a package root. */
function runCheckExports(root: string) {
  const result = spawnSync(process.execPath, ['scripts/check-exports.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: cliEnv(),
    timeout: CHECK_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

interface DriftLine {
  format: string;
  specifier: string;
  added: string[];
  missing: string[];
}

function parseNames(list: string): string[] {
  const trimmed = list.trim();
  return trimmed === 'none' ? [] : trimmed.split(/,\s*/);
}

/** The `FAIL <format> <specifier>: … added: <names>; missing: <names>` lines of a run's stderr. */
function driftLines(stderr: string): DriftLine[] {
  const lines: DriftLine[] = [];
  for (const line of stderr.split('\n')) {
    const match = /^FAIL\s+(\S+)\s+(\S+?):.*?\badded: (.*?); missing: (.*?)\s*$/.exec(line);
    if (match === null) continue;
    const [, format = '', specifier = '', added = '', missing = ''] = match;
    lines.push({ format, specifier, added: parseNames(added), missing: parseNames(missing) });
  }
  return lines;
}

afterAll(cleanup);

/**
 * A copy of the built package (package.json, the check script, dist/) in which the ESM dashboard entry
 * gains EXTRA_NAME and the CommonJS otel entry stops exporting DROPPED_NAME.
 */
function driftedCopy(): string {
  const root = tempDir('phargus-check-exports-');
  copyFileSync(join(repoRoot, 'package.json'), join(root, 'package.json'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(
    join(repoRoot, 'scripts', 'check-exports.mjs'),
    join(root, 'scripts', 'check-exports.mjs'),
  );
  cpSync(join(repoRoot, 'dist'), join(root, 'dist'), { recursive: true });

  appendFileSync(
    join(root, 'dist', 'esm', 'dashboard', 'index.js'),
    `\nexport const ${EXTRA_NAME} = 1;\n`,
  );

  const otelDir = join(root, 'dist', 'cjs', 'otel');
  renameSync(join(otelDir, 'index.js'), join(otelDir, 'index.original.js'));
  writeFileSync(
    join(otelDir, 'index.js'),
    [
      "'use strict';",
      "const original = require('./index.original.js');",
      `const { ${DROPPED_NAME}: _dropped, ...rest } = original;`,
      "Object.defineProperty(exports, '__esModule', { value: true });",
      'Object.assign(exports, rest);',
      '',
    ].join('\n'),
  );
  return root;
}

describe('npm run check:exports', () => {
  it(
    'AC-2: passes on the built package and names added and missing runtime exports per subpath and format on a drifted copy',
    async () => {
      const clean = runCheckExports(repoRoot);
      expect(clean.status, `unmodified run failed:\n${clean.stderr}`).toBe(0);
      expect(driftLines(clean.stderr)).toEqual([]);

      const drifted = runCheckExports(driftedCopy());
      expect(drifted.status).not.toBeNull();
      expect(drifted.status).not.toBe(0);
      const lines = driftLines(drifted.stderr);

      const addedLine = lines.find(
        (l) => l.format === 'import' && l.specifier === '@pharn-dev/phargus/dashboard',
      );
      expect(
        addedLine,
        `no drift line for import @pharn-dev/phargus/dashboard in:\n${drifted.stderr}`,
      ).toBeDefined();
      expect(addedLine?.added).toContain(EXTRA_NAME);
      expect(addedLine?.missing).toEqual([]);

      const missingLine = lines.find(
        (l) => l.format === 'require' && l.specifier === '@pharn-dev/phargus/otel',
      );
      expect(
        missingLine,
        `no drift line for require @pharn-dev/phargus/otel in:\n${drifted.stderr}`,
      ).toBeDefined();
      expect(missingLine?.missing).toContain(DROPPED_NAME);
      expect(missingLine?.added).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
