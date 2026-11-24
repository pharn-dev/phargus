import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Server, createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { startAgentOnce } from './auto-start.js';
import { disable, drainSpans } from './http-tracing.js';

const AGENT_KEY = Symbol.for('phargus.agent');

type AgentGlobal = { [AGENT_KEY]?: true };

const dir = mkdtempSync(join(tmpdir(), 'phargus-auto-start-span-buffer-'));

afterEach(() => {
  vi.unstubAllEnvs();
  disable();
  drainSpans();
  delete (globalThis as AgentGlobal)[AGENT_KEY];
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Polls `condition` every 5 ms for up to 5 s. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i += 1) {
    await delay(5);
  }
  expect(condition(), what).toBe(true);
}

/** Starts the agent with `env`, writing to its own file; resolves once the config has loaded. */
async function startWith(name: string, env: Record<string, string>): Promise<void> {
  const output = join(dir, `${name}.ndjson`);
  vi.stubEnv('PHARGUS_OUTPUT', output);
  vi.stubEnv('PHARGUS_INTERVAL_MS', '3600000');
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  startAgentOnce();
  // The output file is opened right after the span buffer is set from the loaded config.
  await until(() => existsSync(output), 'the agent opened its output');
}

async function serve(requests: number): Promise<void> {
  const server = createServer((_req, res) => {
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  for (let i = 0; i < requests; i += 1) {
    await new Promise<void>((resolve, reject) => {
      get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
  }
  await delay(25);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('startAgentOnce — spanBuffer (CORE-275)', () => {
  it('PHARGUS_SPAN_BUFFER=64 traces from the preload and keeps 64 spans per drain', async () => {
    await startWith('env-64', { PHARGUS_SPAN_BUFFER: '64' });
    expect(Object.hasOwn(Server.prototype, 'emit')).toBe(true);
    await serve(80);
    const { spans, dropped } = drainSpans();
    expect(spans).toHaveLength(64);
    expect(dropped).toBe(16);
  });

  it('spanBuffer: 0 in a pinned config file switches tracing off once the file is read', async () => {
    const config = join(dir, 'off.json');
    writeFileSync(config, JSON.stringify({ spanBuffer: 0 }));
    await startWith('file-0', { PHARGUS_CONFIG: config });
    expect(Object.hasOwn(Server.prototype, 'emit')).toBe(false);
    await serve(3);
    expect(drainSpans()).toEqual({ spans: [], dropped: 0 });
  });
});
