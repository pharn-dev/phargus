import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join, relative } from 'node:path';
import type { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cliEnv,
  diagnostics,
  HTTP_TIMEOUT_MS,
  openEvents,
  repoRoot,
  sleep,
  STARTUP_TIMEOUT_MS,
  stopCli as stopExample,
  track,
  type ExitInfo,
  type Proc,
} from '../../test/support.js';

const exampleDir = join(repoRoot, 'examples', 'express-app');
const EXAMPLE_ENTRY = 'examples/express-app/index.mjs';

const EXIT_TIMEOUT_MS = 20_000;

const APP_LINE = /^\[express-app\] app listening on http:\/\/127\.0\.0\.1:(\d+)$/m;
const DASHBOARD_LINE = /^\[express-app\] dashboard listening on http:\/\/127\.0\.0\.1:(\d+)$/m;
const PHARGUS_SUBPATH = /^@pharn-dev\/phargus\/[a-z-]+$/;
const SOURCE_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.mts', '.cts'];

type ExampleRun = Proc<ChildProcessByStdio<null, Readable, Readable>>;

/** Spawns the example entry with both ports set to 0. */
function startExample(): ExampleRun {
  return track(
    spawn(process.execPath, [EXAMPLE_ENTRY], {
      cwd: repoRoot,
      env: cliEnv({ APP_PORT: '0', DASHBOARD_PORT: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}

/** Waits for both address lines; fails if the example exits first or the timeout passes. */
async function waitForPorts(
  run: ExampleRun,
  timeoutMs: number,
): Promise<{ appPort: number; dashboardPort: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const app = APP_LINE.exec(run.stdout());
    const dashboard = DASHBOARD_LINE.exec(run.stdout());
    if (app && dashboard) {
      return { appPort: Number(app[1]), dashboardPort: Number(dashboard[1]) };
    }
    if (run.exitInfo() !== undefined) {
      throw new Error(`the example exited before reporting its addresses\n${diagnostics(run)}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the example's addresses\n${diagnostics(run)}`);
    }
    await sleep(25);
  }
}

/** Resolves with the exit, or with undefined when the example has not exited within the bound. */
async function waitForExit(run: ExampleRun, timeoutMs: number): Promise<ExitInfo | undefined> {
  return Promise.race([run.exited, sleep(timeoutMs).then(() => undefined)]);
}

/** GETs a path on 127.0.0.1 and resolves with the status code once the body has been read. */
function httpGet(port: number, path: string): Promise<number> {
  return new Promise((done, fail) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', agent: false },
      (response) => {
        response.on('error', fail);
        response.on('end', () => {
          done(response.statusCode ?? 0);
        });
        response.resume();
      },
    );
    request.on('error', fail);
    request.setTimeout(HTTP_TIMEOUT_MS, () => {
      request.destroy(new Error(`GET ${path} timed out`));
    });
    request.end();
  });
}

type SseConnection = Awaited<ReturnType<typeof openEvents>>;

/** Opens GET /events; the example closes this stream on shutdown, and a reset then is recorded, not thrown. */
const openSse = (port: number): Promise<SseConnection> => openEvents(port);

/** Every source file under the directory, recursively (symbolic links are not followed). */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

function isIdentifierChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '_' ||
    ch === '$' ||
    ch === '.'
  );
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Index of the last non-whitespace character at or before `index`, or -1. */
function lastNonSpace(source: string, index: number): number {
  let k = index;
  while (k >= 0 && isSpace(source[k])) k -= 1;
  return k;
}

/** True when `word` is a whole word ending at `endIndex`. */
function wordEndsAt(source: string, endIndex: number, word: string): boolean {
  const start = endIndex - word.length + 1;
  if (start < 0 || source.slice(start, endIndex + 1) !== word) return false;
  return !isIdentifierChar(source[start - 1]);
}

/** Whether a string literal opening at `quoteIndex` is a module specifier position. */
function isSpecifierPosition(source: string, quoteIndex: number): boolean {
  const before = lastNonSpace(source, quoteIndex - 1);
  if (before < 0) return false;
  if (wordEndsAt(source, before, 'from') || wordEndsAt(source, before, 'import')) return true;
  if (source[before] !== '(') return false;
  const callee = lastNonSpace(source, before - 1);
  return wordEndsAt(source, callee, 'import') || wordEndsAt(source, callee, 'require');
}

/**
 * The module specifiers of static imports and re-exports (`from '…'`), side-effect imports
 * (`import '…'`), dynamic `import('…')` and `require('…')`. A linear scan that skips comments and
 * reads string literals; no regular expression is involved.
 */
function moduleSpecifiers(source: string): string[] {
  const found: string[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end === -1 ? n : end + 1;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      let value = '';
      while (j < n && source[j] !== ch) {
        if (source[j] === '\\') {
          value += source[j + 1] ?? '';
          j += 2;
        } else {
          value += source[j] ?? '';
          j += 1;
        }
      }
      if (isSpecifierPosition(source, i)) found.push(value);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return found;
}

let current: ExampleRun | undefined;
const connections: SseConnection[] = [];

afterAll(async () => {
  for (const connection of connections) {
    connection.request.destroy();
  }
  if (current !== undefined) {
    await stopExample(current);
  }
}, 40_000);

describe('examples/express-app: clean shutdown and dependency-free sources', () => {
  // On Windows, process.kill() with SIGTERM terminates the process without running its signal
  // handlers, so it cannot exit with code 0 (see docs/LIMITS.md).
  it.skipIf(process.platform === 'win32')(
    'AC-3: on SIGTERM the example exits with code 0 within a bounded time and its stderr has no agent-disabled line',
    async () => {
      const run = startExample();
      current = run;
      const { appPort, dashboardPort } = await waitForPorts(run, STARTUP_TIMEOUT_MS);

      // Shut down a running example: an SSE client is connected and a request has been served.
      const sse = await openSse(dashboardPort);
      connections.push(sse);
      expect(sse.statusCode, diagnostics(run)).toBe(200);
      expect(await httpGet(appPort, '/fast'), diagnostics(run)).toBe(200);

      run.child.kill('SIGTERM');
      const exit = await waitForExit(run, EXIT_TIMEOUT_MS);

      expect(
        exit,
        `the example did not exit within ${String(EXIT_TIMEOUT_MS)} ms\n${diagnostics(run)}`,
      ).toBeDefined();
      expect(exit?.error, diagnostics(run)).toBeUndefined();
      expect(exit?.signal, diagnostics(run)).toBeNull();
      expect(exit?.code, diagnostics(run)).toBe(0);
      expect(run.stderr()).not.toContain('[phargus] agent disabled');
    },
    90_000,
  );

  it('AC-3: the example imports Phargus only through bare @pharn-dev/phargus/<subpath> specifiers, never express, and its README documents build, run and Express', () => {
    const files = sourceFiles(exampleDir);
    expect(files.length, `source files under ${exampleDir}`).toBeGreaterThan(0);

    const all: string[] = [];
    for (const file of files) {
      const where = relative(repoRoot, file);
      for (const specifier of moduleSpecifiers(readFileSync(file, 'utf8'))) {
        all.push(specifier);
        expect(
          specifier.startsWith('node:') || PHARGUS_SUBPATH.test(specifier),
          `${where} imports ${JSON.stringify(specifier)}`,
        ).toBe(true);
        expect(specifier, where).not.toContain('src/');
        expect(specifier, where).not.toContain('dist/');
        expect(specifier === 'express' || specifier.startsWith('express/'), where).toBe(false);
      }
    }
    // The one-line agent setup is itself an Phargus import; a scan that found none proves nothing.
    expect(all).toContain('@pharn-dev/phargus/agent');

    const readme = readFileSync(join(exampleDir, 'README.md'), 'utf8');
    expect(readme).toContain('npm run build');
    expect(readme).toContain('node examples/express-app/index.mjs');
    expect(readme).toContain('Express');
  });
});
