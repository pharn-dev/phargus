import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { cliEnv, repoRoot } from '../../test/support.js';

// AC-3: docs/API.md names every runtime export and declared type of each built subpath and says the
// rest is internal; the README Documentation table links it; CHANGELOG [Unreleased] records the cut.

const SUBPATHS = ['agent', 'collector', 'analyzer', 'dashboard', 'plugin-runner', 'otel'] as const;
type Subpath = (typeof SUBPATHS)[number];
const FORMATS = ['import', 'require'] as const;
type Format = (typeof FORMATS)[number];

/** Every name AC-1 removes, runtime and type, the four placeholder types included. */
const REMOVED_NAMES = [
  'encodeNdjsonLine',
  'createSpanExport',
  'enable',
  'disable',
  'drainSpans',
  'DEFAULT_SPAN_BUFFER_SIZE',
  'toSpanRecord',
  'isSpanRecord',
  'createWindowAggregator',
  'createSpanRouter',
  'parseWindowLine',
  'serializeWindow',
  'SpanExport',
  'HttpTracingOptions',
  'SpanDrain',
  'WindowAggregatorOptions',
  'PhargusAgentPlaceholder',
  'CollectorPlaceholder',
  'DashboardPlaceholder',
  'PluginRunnerPlaceholder',
];

/** The agent exports CORE-363 removes, runtime and type. */
const REMOVED_AGENT_NAMES = [
  'createSamplerController',
  'createNdjsonExporter',
  'createEventLoopSampler',
  'createGcSampler',
  'createBackpressureProbe',
  'loadAgentConfig',
  'defaultAgentConfig',
  'PhargusConfigError',
  'assertPermission',
  'checkPermission',
  'isPermissionModelEnabled',
  'sampleMemory',
  'DEFAULT_ALLOCATION_SAMPLING_INTERVAL',
  'DEFAULT_ALLOCATION_SAMPLING_DURATION_MS',
  'DEFAULT_ALLOCATION_SITE_LIMIT',
  'SamplerController',
  'NdjsonExporter',
  'NdjsonExporterOptions',
  'EventLoopSampler',
  'EventLoopSamplerOptions',
  'GcSampler',
  'BackpressureProbe',
  'BackpressureProbeOptions',
  'LoadAgentConfigOptions',
  'AgentConfig',
  'PermissionCheck',
  'PermissionScope',
];

const PROBE_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 240_000;

interface ConditionTarget {
  types: string;
  default: string;
}
interface PackageJson {
  exports: Record<string, Record<Format, ConditionTarget> | string>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
}

function conditionTarget(pkg: PackageJson, sub: Subpath, format: Format): ConditionTarget {
  const entry = pkg.exports[`./${sub}`];
  if (entry === undefined || typeof entry === 'string') {
    throw new Error(`package.json exports has no conditional entry for ./${sub}`);
  }
  return entry[format];
}

/** The test's environment without any PHARGUS_* variable, with the agent's output turned off. */
function probeEnv(format: Format): NodeJS.ProcessEnv {
  return cliEnv({
    PHARGUS_OUTPUT: 'none',
    PROBE_FORMAT: format,
    PROBE_SUBPATHS: JSON.stringify(SUBPATHS),
  });
}

const RESULT_MARK = 'PHARGUS_API_PROBE_RESULT ';

// Runs at the repo root so `@pharn-dev/phargus/<subpath>` resolves by package self-reference.
const PROBE_SOURCE = `
import { createRequire } from 'node:module';
import { join } from 'node:path';
const format = process.env.PROBE_FORMAT;
const subpaths = JSON.parse(process.env.PROBE_SUBPATHS);
const requireFromRoot = createRequire(join(process.cwd(), 'package.json'));
const result = {};
for (const sub of subpaths) {
  const specifier = '@pharn-dev/phargus/' + sub;
  const mod = format === 'import' ? await import(specifier) : requireFromRoot(specifier);
  result[sub] = Object.keys(mod).sort();
}
process.stdout.write('\\n' + ${JSON.stringify(RESULT_MARK)} + JSON.stringify(result) + '\\n');
`;

/** Loads every subpath through one format in a child process and returns each module's own keys. */
function runtimeExports(format: Format): Record<Subpath, string[]> {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE_SOURCE], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: probeEnv(format),
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${format} probe exited ${String(result.status)}:\n${result.stderr}`);
  }
  const line = result.stdout.split('\n').find((l) => l.startsWith(RESULT_MARK));
  if (line === undefined) {
    throw new Error(`${format} probe printed no result line:\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(line.slice(RESULT_MARK.length)) as Record<Subpath, string[]>;
}

/** Per subpath, every name its `import` and `require` declaration files export (re-exports followed). */
function declarationExports(): Map<Subpath, Set<string>> {
  const pkg = readPackageJson();
  const filesBySub = new Map<Subpath, string[]>();
  for (const sub of SUBPATHS) {
    filesBySub.set(
      sub,
      FORMATS.map((format) => join(repoRoot, conditionTarget(pkg, sub, format).types)),
    );
  }
  const program = ts.createProgram([...filesBySub.values()].flat(), {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const bySub = new Map<Subpath, Set<string>>();
  for (const [sub, files] of filesBySub) {
    const names = new Set<string>();
    for (const file of files) {
      const sourceFile = program.getSourceFile(file);
      if (sourceFile === undefined) throw new Error(`TypeScript could not read ${file}`);
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (moduleSymbol === undefined) throw new Error(`${file} is not a module`);
      for (const symbol of checker.getExportsOfModule(moduleSymbol)) names.add(symbol.getName());
    }
    bySub.set(sub, names);
  }
  return bySub;
}

/** Per subpath, every runtime export (both formats) and every declared export of the built package. */
async function supportedNames(): Promise<Map<Subpath, string[]>> {
  const declared = declarationExports();
  const runtime = FORMATS.map((format) => runtimeExports(format));
  const bySub = new Map<Subpath, string[]>();
  for (const sub of SUBPATHS) {
    const names = new Set(declared.get(sub));
    for (const keys of runtime) for (const key of keys[sub]) names.add(key);
    bySub.set(sub, [...names].sort());
  }
  return bySub;
}

/** The lines from the heading that names `@pharn-dev/phargus/<sub>` up to the next `## ` heading. */
function apiSection(doc: string, sub: Subpath): string | undefined {
  const lines = doc.split('\n');
  const specifier = `@pharn-dev/phargus/${sub}`;
  const start = lines.findIndex(
    (line) => /^#{1,6}\s/.test(line) && line.includes(specifier) && !line.includes(`${specifier}-`),
  );
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

/** The text from `heading` (a line equal to it) up to the next line `isEnd` accepts. */
function sectionOf(text: string, heading: string, isEnd: (line: string) => boolean): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(isEnd);
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('the public API documentation', () => {
  it(
    'AC-3: docs/API.md has a section per subpath naming every runtime export and declared type, and says the rest is internal',
    async () => {
      const names = await supportedNames();
      const doc = readFileSync(join(repoRoot, 'docs', 'API.md'), 'utf8');
      expect(doc).toMatch(/not listed[^.]*internal/i);
      for (const sub of SUBPATHS) {
        const section = apiSection(doc, sub);
        expect(section, `docs/API.md has no heading for @pharn-dev/phargus/${sub}`).toBeDefined();
        const unnamed = (names.get(sub) ?? []).filter((name) => !section?.includes(`\`${name}\``));
        expect(unnamed, `the @pharn-dev/phargus/${sub} section of docs/API.md misses`).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it('CORE-363: the agent section of docs/API.md names no removed agent export', () => {
    const doc = readFileSync(join(repoRoot, 'docs', 'API.md'), 'utf8');
    const section = apiSection(doc, 'agent') ?? '';
    const named = REMOVED_AGENT_NAMES.filter((name) => section.includes(`\`${name}\``));
    expect(named, 'the @pharn-dev/phargus/agent section of docs/API.md still names').toEqual([]);
    expect(section).toContain('32768');
    expect(section).toContain('1000 ms');
    expect(section).toContain('20 sites');
  });

  it('AC-3: the README Documentation table links docs/API.md', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    const documentation = sectionOf(
      readme,
      '## Documentation',
      (line) => line.startsWith('## ') || line.trim() === '---',
    );
    const tableRows = documentation.split('\n').filter((line) => line.trim().startsWith('|'));
    expect(tableRows.some((row) => /\]\((?:\.\/)?docs\/API\.md\)/.test(row))).toBe(true);
  });

  it('AC-3: CHANGELOG has a Removed subsection naming every removed name and calling it breaking', () => {
    const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
    // The removal shipped in 0.2.0; later releases have Removed subsections of their own.
    const heading = changelog.split('\n').find((l) => l.startsWith('## [0.2.0]')) ?? '## [0.2.0]';
    const released = sectionOf(changelog, heading, (line) => line.startsWith('## ['));
    const removed = sectionOf(
      released,
      '### Removed',
      (line) => line.startsWith('### ') || line.startsWith('## '),
    );
    expect(removed, 'CHANGELOG has no ### Removed subsection').not.toBe('');
    expect(removed).toMatch(/\bbreaking\b/i);
    const unnamed = REMOVED_NAMES.filter((name) => !removed.includes(`\`${name}\``));
    expect(unnamed, 'CHANGELOG ### Removed misses').toEqual([]);
  });
});
