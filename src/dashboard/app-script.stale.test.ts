import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_SCRIPT } from './ui/app-script.js';
import { renderPage } from './ui/page.js';

type DomElement = {
  textContent: string | null;
  className: string;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  appendChild(child: DomElement): unknown;
};

type TestWindow = {
  document: {
    write(html: string): void;
    createElement(tagName: string): DomElement;
    body: DomElement | null;
    getElementById(id: string): DomElement | null;
  };
  happyDOM: { close(): Promise<void> };
};

type HappyDomModule = {
  Window: new (options: { url: string; settings: Record<string, boolean> }) => TestWindow;
};

/** The dashboard client in happy-dom, its clock and interval faked, fed by a hand-driven stream. */
type Page = {
  window: TestWindow;
  status: DomElement;
  send(text: string): void;
  close(): void;
};

const WINDOW_END = Date.UTC(2026, 10, 23, 10, 0, 1);

/** A window event one second long, ending at `end` (epoch milliseconds). */
function windowFrame(end: number): string {
  const w = {
    start: end - 1000,
    end,
    count: 10,
    late: 0,
    eventLoop: { max: 2_000_000, p99: 1_500_000, mean: 500_000 },
    memory: {
      heapUsedLast: 10_485_760,
      heapUsedMax: 10_485_760,
      rssLast: 52_428_800,
      rssMax: 52_428_800,
    },
    gc: { count: 1, totalPause: 1_000_000, maxPause: 1_000_000 },
    backpressure: { events: 0, totalStall: 0, maxStall: 0 },
  };
  return 'event: window\ndata: ' + JSON.stringify(w) + '\n\n';
}

/** Lets pending promise jobs and immediates run until the predicate holds. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for ' + what);
}

async function openPage(): Promise<Page> {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const happyDom = (await import('happy-dom')) as unknown as HappyDomModule;
  const window = new happyDom.Window({
    url: 'http://dashboard.test/',
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  let fetches = 0;
  Object.assign(window, {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    Date: globalThis.Date,
    requestAnimationFrame: (): number => 0,
    // The first fetch connects; a reconnect attempt never settles, so the page stays disconnected.
    fetch: () => {
      fetches += 1;
      return fetches === 1
        ? Promise.resolve({ status: 200, ok: true, body })
        : new Promise(() => undefined);
    },
  });

  const document = window.document;
  document.write(renderPage());
  const status = document.getElementById('status');
  if (status === null) {
    throw new Error('the page is missing the status element');
  }
  const script = document.createElement('script');
  script.textContent = APP_SCRIPT;
  document.body?.appendChild(script);
  await until(() => status.textContent === 'live', 'the stream to connect');

  const encoder = new TextEncoder();
  return {
    window,
    status,
    send(text) {
      controller?.enqueue(encoder.encode(text));
    },
    close() {
      controller?.close();
    },
  };
}

describe('dashboard staleness', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('with one-second windows the status reads stale after 5 s without a window, keeps counting, and the next window sets it back to live', async () => {
    const page = await openPage();
    try {
      page.send(windowFrame(WINDOW_END));
      await until(
        () => page.window.document.getElementById('lag')?.textContent !== '–',
        'the window',
      );

      vi.advanceTimersByTime(4000);
      expect(page.status.textContent).toBe('live');

      vi.advanceTimersByTime(1000);
      expect(page.status.textContent).toBe('stale: no data for 5 s');
      expect(page.status.className).toBe('status-error');

      vi.advanceTimersByTime(1000);
      expect(page.status.textContent).toBe('stale: no data for 6 s');

      page.send(windowFrame(WINDOW_END + 1000));
      await until(() => page.status.textContent === 'live', 'the status to return to live');
      expect(page.status.className).toBe('status-live');
    } finally {
      await page.window.happyDOM.close();
    }
  });

  it('each card shows the end time of the window on display', async () => {
    const page = await openPage();
    try {
      page.send(windowFrame(WINDOW_END));
      const ends = page.window.document.body?.querySelectorAll('.window-end');
      await until(() => (ends?.[0]?.textContent ?? '') !== '', 'the window');
      expect(ends?.length).toBe(4);
      for (let i = 0; i < (ends?.length ?? 0); i += 1) {
        expect(ends?.[i]?.textContent).toBe('window ending ' + new Date(WINDOW_END).toISOString());
      }
    } finally {
      await page.window.happyDOM.close();
    }
  });

  it('a disconnected stream shows reconnecting, never stale', async () => {
    const page = await openPage();
    try {
      page.send(windowFrame(WINDOW_END));
      await until(
        () => page.window.document.getElementById('lag')?.textContent !== '–',
        'the window',
      );
      page.close();
      await until(() => page.status.textContent === 'reconnecting', 'the disconnect');

      // Past the 5 s threshold: the status is still the disconnected one. (A retry that fires in the
      // meantime shows 'connecting', in the same reconnecting style.)
      vi.advanceTimersByTime(10_000);
      expect(page.status.className).toBe('status-reconnecting');
      expect(page.status.textContent).toMatch(/^(re)?connecting$/);
    } finally {
      await page.window.happyDOM.close();
    }
  });
});
