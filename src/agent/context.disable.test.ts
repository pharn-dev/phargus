import { request, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { currentTraceId, disableTraceContext, runInTrace, runWithTrace } from './context.js';
import { disable, enable } from './http-tracing.js';

const TRACE_ID = /^[0-9a-f]{32}$/;

/** A promise and the function that settles it, so a trace can be held open across a disable. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('trace context disable', () => {
  it('hides the trace id everywhere, including inside a trace already in flight', async () => {
    const { wait, open } = gate();
    let before: string | undefined;
    const inFlight = runWithTrace(async () => {
      before = currentTraceId();
      await wait;
      return currentTraceId();
    });

    disableTraceContext();
    expect(currentTraceId()).toBeUndefined();
    open();

    expect(before).toMatch(TRACE_ID);
    expect(await inFlight).toBeUndefined();
  });

  it('a later runWithTrace or runInTrace re-enables it', async () => {
    disableTraceContext();
    const fresh = await runWithTrace(async () => {
      await Promise.resolve();
      return currentTraceId();
    });
    expect(fresh).toMatch(TRACE_ID);

    disableTraceContext();
    const id = 'a'.repeat(32);
    expect(runInTrace(id, () => currentTraceId())).toBe(id);
  });
});

describe('http tracing disable and re-enable', () => {
  afterEach(() => {
    disable();
  });

  /** One request to a server whose handler answers with the trace id it sees. */
  async function traceIdSeenByHandler(): Promise<string> {
    const server = createServer((_req, res) => {
      res.end(currentTraceId() ?? 'none');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      return await new Promise<string>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, agent: false }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => resolve(body));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }

  it('disable() switches the trace context off and enable() sets currentTraceId() again', async () => {
    enable();
    expect(await traceIdSeenByHandler()).toMatch(TRACE_ID);

    disable();
    expect(await traceIdSeenByHandler()).toBe('none');
    expect(currentTraceId()).toBeUndefined();

    enable();
    expect(await traceIdSeenByHandler()).toMatch(TRACE_ID);
  });
});
