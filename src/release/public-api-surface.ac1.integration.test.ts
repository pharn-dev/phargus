import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { cliEnv, repoRoot } from '../../test/support.js';

// AC-1: the built package's six subpaths load through `import` and `require`, none of them exposes a
// removed wiring internal at runtime or in its declarations, and the supported names stay. The agent's
// runtime exports are exactly AGENT_RUNTIME (CORE-363).

const SUBPATHS = ['agent', 'collector', 'analyzer', 'dashboard', 'plugin-runner', 'otel'] as const;
type Subpath = (typeof SUBPATHS)[number];
const FORMATS = ['import', 'require'] as const;
type Format = (typeof FORMATS)[number];

const REMOVED_RUNTIME = [
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
  // CORE-363: the agent's wiring, configuration and permission internals.
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
  // CORE-367: the sink configuration path.
  'createSinks',
];
const REMOVED_TYPES = [
  'SpanExport',
  'HttpTracingOptions',
  'SpanDrain',
  'WindowAggregatorOptions',
  'PhargusAgentPlaceholder',
  'CollectorPlaceholder',
  'DashboardPlaceholder',
  'PluginRunnerPlaceholder',
  // CORE-363: the types of the removed agent functions.
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
  // CORE-367: the sink configuration types.
  'SinkConfig',
  'SinkInput',
];
// The agent's runtime exports, exactly (sorted, code-unit order).
const AGENT_RUNTIME = [
  'ANONYMOUS_FUNCTION',
  'DEPENDENT_CODE_KIND',
  'PhargusPermissionError',
  'SPAN_RECORD_TYPE',
  'createDeoptParser',
  'currentTraceId',
  'runWithTrace',
  'sampleAllocations',
  'sampleHeapSpaces',
  'takeHeapSnapshot',
];
const KEPT_COLLECTOR_RUNTIME = ['createCollector', 'createWindowStore', 'createNdjsonDecoder'];
const KEPT_AGENT_TYPES = [
  'SpanRecord',
  'AgentSampleLine',
  'AgentLossCounters',
  'TraceSpan',
  'AgentSample',
  'EventLoopSample',
  'GcSample',
  'MemorySample',
  'BackpressureSample',
  'BackpressureHotspot',
  'HeapSpaceSample',
  'HeapSpaceEntry',
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
  try {
    const mod = format === 'import' ? await import(specifier) : requireFromRoot(specifier);
    result[sub] = { ok: true, keys: Object.keys(mod).sort() };
  } catch (err) {
    result[sub] = { ok: false, error: String((err && err.stack) || err) };
  }
}
process.stdout.write('\\n' + ${JSON.stringify(RESULT_MARK)} + JSON.stringify(result) + '\\n');
`;

type ProbeEntry = { ok: true; keys: string[] } | { ok: false; error: string };

/** Loads every subpath through one format in a child process and returns each module's own keys. */
function probeRuntime(format: Format): Record<Subpath, ProbeEntry> {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE_SOURCE], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: probeEnv(format),
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  expect(
    result.status,
    `${format} probe exited ${String(result.status)} (signal ${String(result.signal)}):\n${result.stderr}`,
  ).toBe(0);
  const line = result.stdout.split('\n').find((l) => l.startsWith(RESULT_MARK));
  if (line === undefined) {
    throw new Error(`${format} probe printed no result line:\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(line.slice(RESULT_MARK.length)) as Record<Subpath, ProbeEntry>;
}

/** The names each subpath's declaration file exports, following `export *` and re-exports. */
function declarationExports(): Map<string, string[]> {
  const pkg = readPackageJson();
  const files: string[] = [];
  for (const sub of SUBPATHS) {
    for (const format of FORMATS)
      files.push(join(repoRoot, conditionTarget(pkg, sub, format).types));
  }
  const program = ts.createProgram(files, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const byFile = new Map<string, string[]>();
  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) throw new Error(`TypeScript could not read ${file}`);
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol === undefined) throw new Error(`${file} is not a module`);
    byFile.set(
      file,
      checker
        .getExportsOfModule(moduleSymbol)
        .map((s) => s.getName())
        .sort(),
    );
  }
  return byFile;
}

describe('the public API surface of the built package', () => {
  it(
    'AC-1: every subpath loads through import and require, exposes no removed runtime name, and keeps the supported ones',
    async () => {
      for (const format of FORMATS) {
        const probe = probeRuntime(format);
        for (const sub of SUBPATHS) {
          const entry = probe[sub];
          expect(entry, `${format} @pharn-dev/phargus/${sub} was not probed`).toBeDefined();
          if (!entry.ok) {
            throw new Error(`${format} @pharn-dev/phargus/${sub} failed to load:\n${entry.error}`);
          }
          const exposed = REMOVED_RUNTIME.filter((name) => entry.keys.includes(name));
          expect(exposed, `${format} @pharn-dev/phargus/${sub} still exposes`).toEqual([]);
        }
        const agent = probe.agent;
        const collector = probe.collector;
        if (!agent.ok || !collector.ok)
          throw new Error(`${format} agent or collector did not load`);
        expect(agent.keys, `${format} @pharn-dev/phargus/agent runtime exports`).toEqual(
          AGENT_RUNTIME,
        );
        expect(
          KEPT_COLLECTOR_RUNTIME.filter((name) => !collector.keys.includes(name)),
          `${format} @pharn-dev/phargus/collector lost`,
        ).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "AC-1: no subpath's declarations export a removed type, and the agent's keep the wire-format types",
    async () => {
      const pkg = readPackageJson();
      const exportsByFile = declarationExports();
      for (const sub of SUBPATHS) {
        for (const format of FORMATS) {
          const file = join(repoRoot, conditionTarget(pkg, sub, format).types);
          const names = exportsByFile.get(file);
          if (names === undefined) throw new Error(`no declaration exports read for ${file}`);
          const exposed = [...REMOVED_TYPES, ...REMOVED_RUNTIME].filter((n) => names.includes(n));
          expect(exposed, `${format} types of @pharn-dev/phargus/${sub} still export`).toEqual([]);
          if (sub === 'agent') {
            expect(
              KEPT_AGENT_TYPES.filter((n) => !names.includes(n)),
              `${format} types of @pharn-dev/phargus/agent lost`,
            ).toEqual([]);
          }
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
