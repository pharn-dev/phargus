import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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
  const pkgDir = mkdtempSync(join(tmpdir(), 'phargus-entry-off-'));
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

/** The child's env: the parent's minus every PHARGUS_* name (an unknown one warns on stderr). */
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

const MARKER = 'config-loaded.txt';

/**
 * A phargus.config.js that leaves a marker file next to itself when it is executed. The agent never
 * executes it; it warns about it when it looks in the working directory, so an empty stderr shows
 * that no config lookup ran.
 */
function writeMarkerConfig(dir: string): void {
  writeFileSync(
    join(dir, 'phargus.config.js'),
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(new URL('./${MARKER}', import.meta.url), 'loaded');`,
      'export default { enabled: false };',
      '',
    ].join('\n'),
  );
}

const PATCH_APP = [
  "import http from 'node:http';",
  "console.log('own emit ' + String(Object.hasOwn(http.Server.prototype, 'emit')));",
  '',
].join('\n');

function runPatchApp(
  dir: string,
  preload: (typeof PRELOADS)[number],
  env: Record<string, string>,
): SpawnSyncReturns<string> {
  const app = join(dir, 'patch-app.mjs');
  writeFileSync(app, PATCH_APP);
  return spawnSync(process.execPath, [preload, 'phargus/agent', app], {
    cwd: dir,
    env: childEnv(env),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function expectCleanRun(child: SpawnSyncReturns<string>): void {
  expect(child.error, `child failed to run: ${String(child.error)}`).toBeUndefined();
  expect(child.signal, `child was killed:\n${child.stderr}`).toBeNull();
  expect(child.status, `child exited non-zero:\n${child.stderr}`).toBe(0);
}

const OFF_ENVS: Record<string, string>[] = [
  { PHARGUS_ENABLED: 'false' },
  { PHARGUS_ENABLED: '0' },
  { PHARGUS_OUTPUT: 'none' },
];

describe('phargus/agent entry — off in the environment means off', () => {
  for (const preload of PRELOADS) {
    for (const env of OFF_ENVS) {
      const label = Object.entries(env)
        .map(([name, value]) => `${name}=${value}`)
        .join(' ');
      it(`${preload} phargus/agent with ${label} leaves http.Server.prototype.emit unpatched and does not look for a config file`, () => {
        const dir = caseDir();
        writeMarkerConfig(dir);
        const child = runPatchApp(dir, preload, env);
        expectCleanRun(child);
        expect(child.stderr).toBe('');
        expect(child.stdout).toBe('own emit false\n');
        expect(existsSync(join(dir, MARKER)), 'phargus.config.js was executed').toBe(false);
      }, 300_000);
    }

    it(`${preload} phargus/agent with the agent on does not execute phargus.config.js and warns once naming phargus.config.json (control)`, () => {
      const dir = caseDir();
      writeMarkerConfig(dir);
      const child = runPatchApp(dir, preload, {});
      expectCleanRun(child);
      expect(existsSync(join(dir, MARKER)), 'phargus.config.js was executed').toBe(false);
      expect(child.stderr).toContain('[phargus] warning: phargus.config.js is no longer read');
      expect(child.stderr.match(/phargus\.config\.json/g), child.stderr).toHaveLength(1);
    }, 300_000);
  }
});

const IN_FLIGHT_APP_BODY = [
  'const resultFile = process.argv[2];',
  'const results = {};',
  'function get(port, path, done) {',
  "  http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {",
  '    res.resume();',
  "    res.on('end', done);",
  '  });',
  '}',
  'const server = http.createServer(async (req, res) => {',
  "  if (req.url === '/first') {",
  '    results.before = currentTraceId() ?? null;',
  '    // The destination fails while this request is in flight: the agent disables itself.',
  "    process.stdout.destroy(new Error('destination closed'));",
  '    await new Promise((resolve) => setTimeout(resolve, 50));',
  '    results.inFlight = currentTraceId() ?? null;',
  '  } else {',
  '    results.later = currentTraceId() ?? null;',
  '  }',
  "  res.end('ok');",
  '});',
  '// The agent wires its output once its config has loaded; wait until it listens for errors.',
  'function whenAgentStarted(done) {',
  "  if (process.stdout.listenerCount('error') > 0) done();",
  '  else setTimeout(() => whenAgentStarted(done), 5);',
  '}',
  "server.listen(0, '127.0.0.1', () => {",
  '  const { port } = server.address();',
  '  whenAgentStarted(() => {',
  "    get(port, '/first', () => {",
  '      results.outside = currentTraceId() ?? null;',
  "      results.ownEmit = Object.hasOwn(http.Server.prototype, 'emit');",
  "      get(port, '/second', () => {",
  '        server.close();',
  '        writeFileSync(resultFile, JSON.stringify(results));',
  '      });',
  '    });',
  '  });',
  '});',
  '',
].join('\n');

const IN_FLIGHT_APP_HEADERS = {
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

describe('phargus/agent entry — an agent that disables itself switches the trace context off', () => {
  for (const preload of PRELOADS) {
    it(`${preload} phargus/agent: after a destination error currentTraceId() is undefined everywhere, including in the request already in flight`, () => {
      const dir = caseDir();
      const app = join(dir, preload === '--require' ? 'in-flight-app.cjs' : 'in-flight-app.mjs');
      writeFileSync(app, [...IN_FLIGHT_APP_HEADERS[preload], IN_FLIGHT_APP_BODY].join('\n'));
      const resultFile = join(dir, 'results.json');
      // The app fails the destination by destroying process.stdout. On Windows a stdout pipe gets
      // the agent's own writer instead (agent-output.ts), so there stdout is a file, which the
      // agent writes through process.stdout.
      const stdoutFd =
        process.platform === 'win32' ? openSync(join(dir, 'stdout.txt'), 'w') : 'pipe';
      let child: SpawnSyncReturns<string>;
      try {
        child = spawnSync(process.execPath, [preload, 'phargus/agent', app, resultFile], {
          cwd: dir,
          env: childEnv({ PHARGUS_OUTPUT: 'stdout', PHARGUS_INTERVAL_MS: '60000' }),
          encoding: 'utf8',
          stdio: ['ignore', stdoutFd, 'pipe'],
          timeout: 30_000,
        });
      } finally {
        if (typeof stdoutFd === 'number') closeSync(stdoutFd);
      }
      expectCleanRun(child);
      const stderrLines = child.stderr.split('\n').filter((l) => l.length > 0);
      expect(stderrLines, `stderr:\n${child.stderr}`).toEqual([
        '[phargus] agent disabled: destination closed',
      ]);
      const results = JSON.parse(readFileSync(resultFile, 'utf8')) as Record<string, unknown>;
      expect(results['before'], 'traced before the error').toMatch(TRACE_ID);
      expect(results['inFlight'], 'in the request in flight').toBeNull();
      expect(results['outside'], 'outside any request').toBeNull();
      expect(results['later'], 'in a later request').toBeNull();
      expect(results['ownEmit'], 'emit restored').toBe(false);
    }, 300_000);
  }
});
