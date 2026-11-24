import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const agentDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(agentDir, '..', '..');
const tscPath = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

function agentSources(): string[] {
  return readdirSync(agentDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map((f) => join(agentDir, f));
}

function compile(sources: string[], outDir: string, moduleArgs: string[], type: string): void {
  const result = spawnSync(
    process.execPath,
    [
      tscPath,
      // TS 6 refuses command-line files while a tsconfig.json is present (TS5112).
      '--ignoreConfig',
      '--outDir',
      outDir,
      '--rootDir',
      agentDir,
      ...moduleArgs,
      '--target',
      'ES2022',
      '--skipLibCheck',
      '--types',
      'node',
      '--declaration',
      'false',
      '--sourceMap',
      'false',
      ...sources,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  );
  for (const source of sources) {
    const emitted = join(outDir, basename(source).replace(/\.ts$/, '.js'));
    expect(
      existsSync(emitted),
      `compiling ${source} (${type}) failed:\n${result.stdout}\n${result.stderr}`,
    ).toBe(true);
  }
  writeFileSync(join(outDir, '..', 'package.json'), JSON.stringify({ type }));
}

/** A private copy of the package: both builds of src/agent and the real `exports`, named "phargus". */
function buildTempPackage(): string {
  const pkgDir = mkdtempSync(join(tmpdir(), 'phargus-span-buffer-'));
  const sources = agentSources();
  const esmDir = join(pkgDir, 'dist', 'esm', 'agent');
  const cjsDir = join(pkgDir, 'dist', 'cjs', 'agent');
  mkdirSync(esmDir, { recursive: true });
  mkdirSync(cjsDir, { recursive: true });
  compile(sources, esmDir, ['--module', 'NodeNext', '--moduleResolution', 'NodeNext'], 'module');
  compile(
    sources,
    cjsDir,
    ['--module', 'CommonJS', '--moduleResolution', 'Node10', '--ignoreDeprecations', '6.0'],
    'commonjs',
  );
  const realPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    exports: unknown;
  };
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: 'phargus',
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: realPkg.exports,
    }),
  );
  return pkgDir;
}

let pkgDir: string | undefined;
function tempPackage(): string {
  pkgDir ??= buildTempPackage();
  return pkgDir;
}

afterAll(() => {
  if (pkgDir !== undefined) {
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

/** The child's env: the parent's minus every PHARGUS_* name and NODE_OPTIONS. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.startsWith('PHARGUS_') || name === 'NODE_OPTIONS') {
      continue;
    }
    env[name] = value;
  }
  return { ...env, ...extra };
}

const PRELOADS = ['--require', '--import'] as const;
const TRACE_ID = /^[0-9a-f]{32}$/;

let caseCount = 0;
/** A fresh working directory inside the temp package, so `phargus/agent` still self-resolves. */
function caseDir(): string {
  caseCount += 1;
  const dir = join(tempPackage(), `case-${String(caseCount)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const APP_HEADERS = {
  '--require': [
    "const http = require('node:http');",
    "const { writeFileSync } = require('node:fs');",
    "const { currentTraceId } = require('phargus/agent');",
  ],
  '--import': [
    "import http from 'node:http';",
    "import { writeFileSync } from 'node:fs';",
    "import { currentTraceId } from 'phargus/agent';",
  ],
} as const;

/**
 * Serves `requests` requests (25 in flight at a time), waits `settleMs`, then writes what it saw to
 * argv[2]: whether `emit` was patched right after the preload, and `currentTraceId()` per request.
 */
const APP_BODY = [
  'const [resultFile, requests, settleMs] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];',
  "const results = { ownEmitAtStart: Object.hasOwn(http.Server.prototype, 'emit'), traceIds: [] };",
  'const server = http.createServer((req, res) => {',
  '  results.traceIds.push(currentTraceId() ?? null);',
  "  res.end('ok');",
  '});',
  'function get(port, path) {',
  '  return new Promise((resolve, reject) => {',
  "    http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {",
  '      res.resume();',
  "      res.on('end', resolve);",
  "    }).on('error', reject);",
  '  });',
  '}',
  "server.listen(0, '127.0.0.1', async () => {",
  '  const { port } = server.address();',
  '  for (let sent = 0; sent < requests; sent += 25) {',
  '    const batch = Math.min(25, requests - sent);',
  '    await Promise.all(Array.from({ length: batch }, (_, i) => get(port, `/r${sent + i}`)));',
  '  }',
  '  setTimeout(() => {',
  '    server.close();',
  '    writeFileSync(resultFile, JSON.stringify(results));',
  '  }, settleMs);',
  '});',
  '',
].join('\n');

type AppResults = { ownEmitAtStart: boolean; traceIds: (string | null)[] };
type Line = { type?: string; dropped?: { samples: number; spans: number } };

function runApp(
  dir: string,
  preload: (typeof PRELOADS)[number],
  env: Record<string, string>,
  requests: number,
  settleMs: number,
): { results: AppResults; lines: Line[] } {
  const app = join(dir, preload === '--require' ? 'app.cjs' : 'app.mjs');
  writeFileSync(app, [...APP_HEADERS[preload], APP_BODY].join('\n'));
  const resultFile = join(dir, 'results.json');
  const output = join(dir, 'out.ndjson');
  const child = spawnSync(
    process.execPath,
    [preload, 'phargus/agent', app, resultFile, String(requests), String(settleMs)],
    {
      cwd: dir,
      env: childEnv({ PHARGUS_OUTPUT: output, ...env }),
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  expect(child.error, `child failed to run: ${String(child.error)}`).toBeUndefined();
  expect(child.signal, `child was killed:\n${child.stderr}`).toBeNull();
  expect(child.status, `child exited non-zero:\n${child.stderr}`).toBe(0);
  expect(child.stderr).toBe('');
  const results = JSON.parse(readFileSync(resultFile, 'utf8')) as AppResults;
  const lines = readFileSync(output, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Line);
  return { results, lines };
}

describe('phargus/agent entry — PHARGUS_SPAN_BUFFER=0 switches tracing off, not the samplers (CORE-275)', () => {
  for (const preload of PRELOADS) {
    it(`${preload}: emit is never patched, currentTraceId() is undefined in the handler, no span line is written, and sample lines continue`, () => {
      const { results, lines } = runApp(
        caseDir(),
        preload,
        { PHARGUS_SPAN_BUFFER: '0', PHARGUS_INTERVAL_MS: '50' },
        5,
        300,
      );
      expect(results.ownEmitAtStart).toBe(false);
      expect(results.traceIds).toEqual([null, null, null, null, null]);
      expect(lines.filter((l) => l.type === 'span')).toEqual([]);
      expect(lines.length, 'sample lines').toBeGreaterThanOrEqual(2);
    }, 300_000);

    it(`${preload}: without PHARGUS_SPAN_BUFFER the same app is traced (control)`, () => {
      const { results, lines } = runApp(caseDir(), preload, { PHARGUS_INTERVAL_MS: '50' }, 5, 300);
      expect(results.ownEmitAtStart).toBe(true);
      for (const id of results.traceIds) {
        expect(id).toMatch(TRACE_ID);
      }
      expect(lines.filter((l) => l.type === 'span')).toHaveLength(5);
    }, 300_000);
  }
});

/** Span lines between consecutive sample lines, and the last sample's `dropped.spans`. */
function perInterval(lines: Line[]): { groups: number[]; spanLines: number; dropped: number } {
  const groups = [0];
  let dropped = 0;
  for (const line of lines) {
    if (line.type === 'span') {
      groups[groups.length - 1] = (groups.at(-1) ?? 0) + 1;
    } else {
      dropped = line.dropped?.spans ?? Number.NaN;
      groups.push(0);
    }
  }
  return { groups, spanLines: groups.reduce((a, b) => a + b, 0), dropped };
}

const REQUESTS = 300;

type CapCase = {
  label: string;
  preload: (typeof PRELOADS)[number];
  env: Record<string, string>;
  file?: string;
};

const CAP_CASES: CapCase[] = [
  { label: 'PHARGUS_SPAN_BUFFER=64', preload: '--require', env: { PHARGUS_SPAN_BUFFER: '64' } },
  { label: 'PHARGUS_SPAN_BUFFER=64', preload: '--import', env: { PHARGUS_SPAN_BUFFER: '64' } },
  {
    label: 'phargus.config.json { spanBuffer: 64 }',
    preload: '--import',
    env: {},
    file: JSON.stringify({ spanBuffer: 64 }),
  },
];

describe('phargus/agent entry — a span buffer of 64 writes at most 64 span lines per interval (CORE-275)', () => {
  for (const { label, preload, env, file } of CAP_CASES) {
    it(`${preload} with ${label}: ${String(REQUESTS)} requests give at most 64 span lines per interval, and dropped.spans counts the rest`, () => {
      const dir = caseDir();
      if (file !== undefined) {
        writeFileSync(join(dir, 'phargus.config.json'), file);
      }
      const { results, lines } = runApp(
        dir,
        preload,
        { PHARGUS_INTERVAL_MS: '1000', ...env },
        REQUESTS,
        2500,
      );
      expect(results.traceIds).toHaveLength(REQUESTS);
      const { groups, spanLines, dropped } = perInterval(lines);
      for (const group of groups) {
        expect(group, `span lines per interval: ${JSON.stringify(groups)}`).toBeLessThanOrEqual(64);
      }
      expect(dropped).toBeGreaterThan(0);
      expect(spanLines + dropped).toBe(REQUESTS);
    }, 300_000);
  }
});

const PATCH_APP = [
  "import http from 'node:http';",
  "console.log('own emit ' + String(Object.hasOwn(http.Server.prototype, 'emit')));",
  '',
].join('\n');

describe('phargus/agent entry — an invalid PHARGUS_SPAN_BUFFER disables the agent (CORE-275)', () => {
  for (const preload of PRELOADS) {
    for (const value of ['65537', 'lots']) {
      it(`${preload} with PHARGUS_SPAN_BUFFER=${value} reports one line naming the variable and patches nothing`, () => {
        const dir = caseDir();
        const app = join(dir, 'patch-app.mjs');
        writeFileSync(app, PATCH_APP);
        const child = spawnSync(process.execPath, [preload, 'phargus/agent', app], {
          cwd: dir,
          env: childEnv({ PHARGUS_SPAN_BUFFER: value }),
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect(child.status, `child exited non-zero:\n${child.stderr}`).toBe(0);
        expect(child.stdout).toBe('own emit false\n');
        expect(child.stderr).toMatch(
          /^\[phargus\] agent disabled: phargus config: PHARGUS_SPAN_BUFFER: spanBuffer: .+\n$/,
        );
      }, 300_000);
    }
  }
});
