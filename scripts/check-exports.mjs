// Smoke test for the built package: every subpath in package.json "exports" must load from both
// ESM (import) and CommonJS (require), and its runtime export names must equal the expected list
// below, in either direction. Run after `npm run build`. Adding or removing a public export means
// updating EXPECTED_EXPORTS here and docs/API.md in the same change.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);
let failed = false;

// The supported runtime exports per subpath, sorted (default sort, code-unit order). Types are not
// runtime exports and are listed only in docs/API.md.
const EXPECTED_EXPORTS = {
  './agent': [
    'ANONYMOUS_FUNCTION',
    'DEFAULT_ALLOCATION_SAMPLING_DURATION_MS',
    'DEFAULT_ALLOCATION_SAMPLING_INTERVAL',
    'DEFAULT_ALLOCATION_SITE_LIMIT',
    'DEPENDENT_CODE_KIND',
    'PhargusConfigError',
    'PhargusPermissionError',
    'SPAN_RECORD_TYPE',
    'assertPermission',
    'checkPermission',
    'createBackpressureProbe',
    'createDeoptParser',
    'createEventLoopSampler',
    'createGcSampler',
    'createNdjsonExporter',
    'createSamplerController',
    'currentTraceId',
    'defaultAgentConfig',
    'isPermissionModelEnabled',
    'loadAgentConfig',
    'runWithTrace',
    'sampleAllocations',
    'sampleHeapSpaces',
    'sampleMemory',
    'takeHeapSnapshot',
  ],
  './collector': [
    'DEFAULT_MAX_LINE_BYTES',
    'DEFAULT_SPAN_CAPACITY',
    'createAlertEvaluator',
    'createCollector',
    'createFileSink',
    'createNdjsonDecoder',
    'createRingBuffer',
    'createSinks',
    'createStdoutSink',
    'createWebhookSink',
    'createWindowStore',
    'validateAlertRules',
  ],
  './analyzer': [
    'DEFAULT_MAX_SNAPSHOT_BYTES',
    'DEFAULT_MAX_SOURCE_FILE_BYTES',
    'DEFAULT_RESOURCE_LIMITS',
    'HeapSnapshotTooLargeError',
    'MalformedSourceMapError',
    'WorkerCrashedError',
    'WorkerPoolClosedError',
    'WorkerQueueFullError',
    'WorkerTaskError',
    'WorkerTaskTimeoutError',
    'createHeapSnapshotPool',
    'createSymbolizationPool',
    'createWorkerPool',
    'diffHeapSnapshots',
    'heapSnapshotTimeoutMs',
    'summarizeHeapSnapshot',
    'symbolizeStackFrames',
  ],
  './dashboard': ['createDashboardServer', 'isLoopbackHost'],
  './plugin-runner': [
    'BuiltinRuleId',
    'RuleErrorCode',
    'RuleParameterError',
    'createPluginRunner',
    'eventLoopLagRule',
    'gcPauseShareRule',
    'heapGrowthRule',
    'loadRulesDirectory',
    'runRules',
  ],
  './otel': [
    'AGGREGATION_TEMPORALITY_DELTA',
    'SPAN_KIND_SERVER',
    'STATUS_CODE_ERROR',
    'STATUS_CODE_UNSET',
    'createOtlpMetricsExporter',
    'createOtlpTraceExporter',
    'toOtlpMetrics',
    'toOtlpTraces',
  ],
};

const exportedSubpaths = Object.keys(pkg.exports).filter((subpath) => subpath !== './package.json');

// Fail closed: the expected table and package.json "exports" must name the same subpaths.
for (const subpath of exportedSubpaths) {
  if (!Object.hasOwn(EXPECTED_EXPORTS, subpath)) {
    failed = true;
    console.error(
      `FAIL ${'expect'.padEnd(7)} ${subpath}: no EXPECTED_EXPORTS entry for this subpath`,
    );
  }
}
for (const subpath of Object.keys(EXPECTED_EXPORTS)) {
  if (!exportedSubpaths.includes(subpath)) {
    failed = true;
    console.error(
      `FAIL ${'expect'.padEnd(7)} ${subpath}: EXPECTED_EXPORTS has an entry that is not a package.json exports subpath`,
    );
  }
}

for (const subpath of exportedSubpaths) {
  const specifier = `${pkg.name}${subpath.slice(1)}`;
  for (const [format, load] of [
    ['import', () => import(specifier)],
    ['require', () => Promise.resolve(require(specifier))],
  ]) {
    try {
      const names = Object.keys(await load()).sort();
      const expected = EXPECTED_EXPORTS[subpath];
      if (expected === undefined) continue;
      const added = names.filter((name) => !expected.includes(name));
      const missing = expected.filter((name) => !names.includes(name));
      if (added.length > 0 || missing.length > 0) {
        failed = true;
        console.error(
          `FAIL ${format.padEnd(7)} ${specifier}: runtime exports differ from the expected list; added: ${added.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}`,
        );
        continue;
      }
      console.log(`ok   ${format.padEnd(7)} ${specifier}`);
    } catch (error) {
      failed = true;
      console.error(
        `FAIL ${format.padEnd(7)} ${specifier}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// Every "bin" entry: the file exists, starts with the shebang, is executable (POSIX) and answers
// --help with the serve command in its usage text.
for (const [name, target] of Object.entries(pkg.bin ?? {})) {
  const file = fileURLToPath(new URL(`../${target}`, import.meta.url));
  try {
    if (!readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node\n')) {
      throw new Error(`${target} does not start with "#!/usr/bin/env node"`);
    }
    if (process.platform !== 'win32' && (statSync(file).mode & 0o111) === 0) {
      throw new Error(`${target} is not executable`);
    }
    const stdout = execFileSync(process.execPath, [file, '--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!stdout.includes('serve')) {
      throw new Error(`${target} --help does not mention serve`);
    }
    console.log(`ok   ${'bin'.padEnd(7)} ${name}`);
  } catch (error) {
    failed = true;
    console.error(
      `FAIL ${'bin'.padEnd(7)} ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

process.exitCode = failed ? 1 : 0;
