import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AGENT_DIR = fileURLToPath(new URL('./', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const SHARED_INT_MODULE = 'src/agent/int.ts';
const WINDOW_MODULE = 'src/collector/window.ts';
const TRANSPORT_MODULE = 'src/otel/otlp-transport.ts';
const HTTP_RESPONSE_SPECIFIER = '../collector/http-response.js';

const INT_HELPER_NAMES = ['toNonNegativeInt', 'roundToNonNegativeInt', 'truncToNonNegativeInt'];
const TRANSPORT_FORBIDDEN_DEFINITIONS = [
  'discardResponseBody',
  'createRequestSignal',
  'MAX_RESPONSE_BODY_BYTES',
];
const TRANSPORT_REQUIRED_IMPORTS = [
  'discardResponseBody',
  'createRequestSignal',
  'MAX_RESPONSE_BODY_BYTES',
  'isRedirect',
];

function toRepoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/');
}

/** Every non-test TypeScript source file under src/agent, recursively, as repo-relative paths. */
function agentSourceFiles(): string[] {
  const entries = readdirSync(AGENT_DIR, { recursive: true, encoding: 'utf8' });
  return entries
    .filter((entry) => /\.(?:ts|mts|cts)$/.test(entry) && !/\.test\.(?:ts|mts|cts)$/.test(entry))
    .map((entry) => toRepoPath(join(AGENT_DIR, entry)))
    .sort();
}

function readSource(repoPath: string): string {
  return readFileSync(join(REPO_ROOT, repoPath), 'utf8');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `source` declares `name` as a function, or binds it with const/let/var. */
function definesName(source: string, name: string): boolean {
  const id = escapeRegExp(name);
  const asFunction = new RegExp(`\\bfunction\\s*\\*?\\s+${id}\\s*[<(]`);
  const asBinding = new RegExp(`\\b(?:const|let|var)\\s+${id}\\b`);
  return asFunction.test(source) || asBinding.test(source);
}

/** The imported (not local) names of every value import of `specifier` in `source`. */
function namesImportedFrom(source: string, specifier: string): Set<string> {
  const names = new Set<string>();
  const importClause = new RegExp(
    `\\bimport\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*['"]${escapeRegExp(specifier)}['"]`,
    'g',
  );
  for (const match of source.matchAll(importClause)) {
    if (match[1] !== undefined) continue;
    for (const part of (match[2] ?? '').split(',')) {
      const trimmed = part.trim();
      if (trimmed === '' || trimmed.startsWith('type ')) continue;
      const imported = trimmed.split(/\s+as\s+/)[0]?.trim();
      if (imported !== undefined && imported !== '') names.add(imported);
    }
  }
  return names;
}

describe('shared int and HTTP helpers — AC-3', () => {
  it('AC-3: only the shared int module defines the int helpers, the OTel transport imports the HTTP helpers from the collector, and the agent entrypoint does not export the int helpers', async () => {
    const scanned = [...agentSourceFiles(), WINDOW_MODULE, TRANSPORT_MODULE];
    expect(scanned, 'the scan covers the agent samplers').toEqual(
      expect.arrayContaining([
        'src/agent/event-loop-sampler.ts',
        'src/agent/gc-sampler.ts',
        'src/agent/backpressure-probe.ts',
        'src/agent/heap-space-sampler.ts',
      ]),
    );

    const offenders: string[] = [];
    for (const file of scanned) {
      if (file === SHARED_INT_MODULE) continue;
      const source = readSource(file);
      for (const name of INT_HELPER_NAMES) {
        if (definesName(source, name)) offenders.push(`${file} defines ${name}`);
      }
    }
    expect.soft(offenders, 'no file other than src/agent/int.ts defines an int helper').toEqual([]);

    const transport = readSource(TRANSPORT_MODULE);
    const transportDefinitions = TRANSPORT_FORBIDDEN_DEFINITIONS.filter((name) =>
      definesName(transport, name),
    );
    expect
      .soft(transportDefinitions, `${TRANSPORT_MODULE} defines none of the collector HTTP helpers`)
      .toEqual([]);

    const imported = namesImportedFrom(transport, HTTP_RESPONSE_SPECIFIER);
    const missingImports = TRANSPORT_REQUIRED_IMPORTS.filter((name) => !imported.has(name));
    expect
      .soft(missingImports, `${TRANSPORT_MODULE} imports these from '${HTTP_RESPONSE_SPECIFIER}'`)
      .toEqual([]);

    const entrypoint: Record<string, unknown> = await import('./index.js');
    expect
      .soft('roundToNonNegativeInt' in entrypoint, 'agent entrypoint exports roundToNonNegativeInt')
      .toBe(false);
    expect
      .soft('truncToNonNegativeInt' in entrypoint, 'agent entrypoint exports truncToNonNegativeInt')
      .toBe(false);
  });
});
