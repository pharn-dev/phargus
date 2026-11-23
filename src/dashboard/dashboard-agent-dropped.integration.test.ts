import { request } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCollector } from '../collector/index.js';
import { APP_SCRIPT } from './ui/app-script.js';
import { createDashboardServer } from './index.js';

/** The slice of happy-dom's API this test drives (typed locally: the module loads inside the test body). */
type DomElement = {
  textContent: string | null;
  hidden: boolean;
  closest(selector: string): DomElement | null;
  querySelector(selector: string): DomElement | null;
  appendChild(child: DomElement): unknown;
};

type DomDocument = {
  write(html: string): void;
  createElement(tagName: string): DomElement;
  readonly body: DomElement | null;
  getElementById(id: string): DomElement | null;
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
  dropped: { samples: number; spans: number },
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
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
    dropped,
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

/** The text of every element of `root` a reader sees: hidden elements are left out. */
function visibleText(root: DomElement | null | undefined): string {
  if (root === null || root === undefined) {
    return '';
  }
  const node = root as unknown as {
    hidden?: boolean;
    childNodes: ArrayLike<unknown>;
    nodeType: number;
    textContent: string | null;
  };
  if (node.nodeType === 3) {
    return node.textContent ?? '';
  }
  if (node.hidden === true) {
    return '';
  }
  return Array.from(node.childNodes)
    .map((child) => visibleText(child as DomElement))
    .join(' ');
}

describe('dashboard — agent drop counters', () => {
  it('shows nothing extra while the counters are 0, then the counters in the header and a note on the waterfall', async () => {
    const happyDom = (await import('happy-dom')) as unknown as HappyDomModule;
    const collector = createCollector({ windowMs: 1000, capacity: 50 });
    await collector.consume(Readable.from([makeSample(100, { samples: 0, spans: 0 })]));

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

      const header = (): string => visibleText(document.querySelectorAll('header')[0]);
      const waterfall = (): string => visibleText(sectionOf(document, 'Recent requests'));

      // Given zero counters: the replayed window is drawn and the header says nothing extra.
      await waitFor(
        () => (document.getElementById('lag')?.textContent ?? '–') !== '–',
        10_000,
        'the replayed window on the page',
      );
      expect(header()).not.toContain('dropped');
      expect(waterfall()).not.toContain('missing');

      // When a window with non-zero counters closes, the header and the waterfall say so.
      await collector.consume(Readable.from([makeSample(1100, { samples: 2, spans: 40 })]));
      await waitFor(
        () => header().includes('agent dropped 2 samples, 40 spans'),
        10_000,
        'the drop counters in the header',
      );
      expect(waterfall()).toContain('older requests may be missing');
    } finally {
      await window?.happyDOM.close();
      await server.close();
    }
  }, 30_000);
});
