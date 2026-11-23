import { request } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCollector } from '../collector/index.js';
import { APP_SCRIPT } from './ui/app-script.js';
import { createDashboardServer } from './index.js';

/** The slice of happy-dom's API this test drives (typed locally: the module loads inside the test body). */
type DomElement = {
  textContent: string | null;
  readonly parentElement: DomElement | null;
  closest(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  appendChild(child: DomElement): unknown;
};

type DomDocument = {
  write(html: string): void;
  createElement(tagName: string): DomElement;
  readonly body: DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  cookie: string;
};

type DomWindow = {
  readonly document: DomDocument;
  readonly happyDOM: { close(): Promise<void> };
};

type HappyDomModule = {
  Window: new (options: { url: string; settings: Record<string, boolean> }) => DomWindow;
};

type HttpResult = { status: number; setCookie: string; body: string };

function httpCall(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          setCookie: res.headers['set-cookie']?.[0] ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.setTimeout(5_000, () => req.destroy(new Error(`timed out: ${method} ${url}`)));
    req.end(body);
  });
}

function makeSample(
  timestamp: number,
  backpressure: { events: number; totalStall: number; maxStall: number; hotspots: unknown[] },
): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: 2, mean: 1, p50: 1, p99: 2 },
    memory: { heapUsed: 10, heapTotal: 20, rss: 30, external: 0, arrayBuffers: 0 },
    gc: {
      count: 0,
      totalPause: 0,
      maxPause: 0,
      kinds: { minor: 0, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The section led by the heading with exactly this text. */
function sectionOf(document: DomDocument, heading: string): DomElement | undefined {
  const match = Array.from(document.querySelectorAll('h2')).find(
    (element) => (element.textContent ?? '').trim() === heading,
  );
  return match?.closest('section') ?? undefined;
}

function callSites(document: DomDocument): string[] {
  const section = sectionOf(document, 'Backpressure');
  return section === undefined
    ? []
    : Array.from(section.querySelectorAll('li')).map((li) => li.textContent ?? '');
}

describe('dashboard — Backpressure section', () => {
  it('shows the latest window’s stall figures and call sites, then "No stalls" when events is 0', async () => {
    const happyDom = (await import('happy-dom')) as unknown as HappyDomModule;
    const collector = createCollector({ windowMs: 1000, capacity: 50 });
    const hostile = '<img src=x onerror=alert(1)>.js:9';
    await collector.consume(
      Readable.from([
        makeSample(100, {
          events: 3,
          totalStall: 12_000_000,
          maxStall: 8_000_000,
          hotspots: [
            { site: 'app/write.js:42', events: 2, totalStall: 9_000_000, maxStall: 8_000_000 },
            { site: hostile, events: 1, totalStall: 3_000_000, maxStall: 3_000_000 },
          ],
        }),
      ]),
    );

    const server = await createDashboardServer({
      collector,
      host: '127.0.0.1',
      port: 0,
      token: 's3cret',
    });
    let window: DomWindow | undefined;
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const session = await httpCall(
        `${base}/session`,
        'POST',
        { 'content-type': 'application/json' },
        JSON.stringify({ token: 's3cret' }),
      );
      expect(session.status).toBe(204);
      const cookie = session.setCookie.split(';')[0] ?? '';
      const page = await httpCall(`${base}/`, 'GET', { cookie });
      expect(page.status).toBe(200);
      // No inline script or style: the page keeps working under the unchanged CSP.
      const html = page.body.toLowerCase();
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<style');
      expect(html).not.toContain(' style=');

      window = new happyDom.Window({
        url: `${base}/`,
        settings: {
          enableJavaScriptEvaluation: true,
          suppressInsecureJavaScriptEnvironmentWarning: true,
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      });
      const document = window.document;
      document.cookie = session.setCookie;
      document.write(page.body);
      const script = document.createElement('script');
      script.textContent = APP_SCRIPT;
      document.body?.appendChild(script);

      // Then: the replayed window's figures and its call sites, written as text.
      await waitFor(() => callSites(document).length === 2, 10_000, 'the call sites on the page');
      const section = sectionOf(document, 'Backpressure');
      const text = section?.textContent ?? '';
      expect(text).toContain('3 stalls');
      expect(text).toContain('12.0 ms');
      expect(text).toContain('8.0 ms');
      const sites = callSites(document);
      expect(sites[0]).toContain('app/write.js:42');
      expect(sites[0]).toContain('9.0 ms');
      expect(sites[1]).toContain(hostile);
      expect(section?.querySelectorAll('img').length).toBe(0);

      // When: a window with no stalls closes, the section says so and lists no call sites.
      await collector.consume(
        Readable.from([makeSample(1100, { events: 0, totalStall: 0, maxStall: 0, hotspots: [] })]),
      );
      await waitFor(
        () => (sectionOf(document, 'Backpressure')?.textContent ?? '').includes('No stalls'),
        10_000,
        '"No stalls" on the page',
      );
      expect(callSites(document)).toEqual([]);
    } finally {
      await window?.happyDOM.close();
      await server.close();
    }
  }, 30_000);
});
