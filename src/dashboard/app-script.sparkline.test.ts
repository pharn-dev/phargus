import { describe, expect, it } from 'vitest';
import { APP_SCRIPT } from './ui/app-script.js';
import { renderPage } from './ui/page.js';
import { buildSparkline } from './ui/sparkline-model.js';

type DomElement = {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  closest(selector: string): DomElement | null;
  appendChild(child: DomElement): unknown;
};

type TestWindow = {
  document: {
    write(html: string): void;
    createElement(tagName: string): DomElement;
    body: DomElement | null;
    getElementById(id: string): DomElement | null;
    querySelectorAll(selector: string): ArrayLike<DomElement>;
  };
  Element: { prototype: { setAttribute(name: string, value: string): void } };
  happyDOM: { close(): Promise<void> };
};

type HappyDomModule = {
  Window: new (options: { url: string; settings: Record<string, boolean> }) => TestWindow;
};

/** The dashboard client in happy-dom, with hand-driven streams (one per connect) and frames. */
type Page = {
  window: TestWindow;
  frames: (() => void)[];
  /** `points` attribute writes since the counter was last reset. */
  counts: { points: number; fetches: number };
  send(text: string): void;
  /** Ends the current stream: the client reconnects after its backoff. */
  end(): void;
  runFrames(): void;
};

const CARDS = ['lag', 'memory', 'gc', 'backpressure'];

/** Window `i` of a series whose figures grow with `i` (times `scale`). */
function windowFrame(i: number, scale = 1): string {
  const w = {
    start: i * 1000,
    end: i * 1000 + 1000,
    eventLoop: { p99: (i + 1) * 1_000_000 * scale, max: (i + 1) * 2_000_000 * scale },
    memory: { heapUsedLast: (i + 1) * 1_048_576 * scale, rssLast: (i + 1) * 2_097_152 * scale },
    gc: { count: i, totalPause: (i + 1) * 100_000 * scale, maxPause: 50_000 },
    backpressure: {
      events: 1,
      totalStall: (i + 1) * 200_000 * scale,
      maxStall: 100_000,
      hotspots: [],
    },
  };
  return 'event: window\ndata: ' + JSON.stringify(w) + '\n\n';
}

function windows(count: number, scale = 1): string {
  let text = '';
  for (let i = 0; i < count; i += 1) {
    text += windowFrame(i, scale);
  }
  return text;
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for ' + what);
}

/** Polls on real time: the client's reconnect waits out a timer. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for ' + what);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function openPage(): Promise<Page> {
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
  const frames: (() => void)[] = [];
  const counts = { points: 0, fetches: 0 };
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  Object.assign(window, {
    requestAnimationFrame(callback: () => void): number {
      frames.push(callback);
      return frames.length;
    },
    fetch: () => {
      counts.fetches += 1;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      return Promise.resolve({ status: 200, ok: true, body });
    },
  });
  const proto = window.Element.prototype;
  const setAttribute = proto.setAttribute;
  proto.setAttribute = function (this: unknown, name: string, value: string): void {
    if (name === 'points') {
      counts.points += 1;
    }
    setAttribute.call(this, name, value);
  };

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
    frames,
    counts,
    send(text) {
      controller?.enqueue(encoder.encode(text));
    },
    end() {
      controller?.close();
    },
    runFrames() {
      for (const callback of frames.splice(0)) {
        callback();
      }
    },
  };
}

/** The card holding the figure with this id. */
function card(page: Page, id: string): DomElement {
  const figure = page.window.document.getElementById(id);
  const section = figure?.closest('section') ?? null;
  if (section === null) {
    throw new Error('no card for #' + id);
  }
  return section;
}

/** Each polyline's point count in the card's sparkline. */
function pointCounts(page: Page, id: string): number[] {
  return Array.from(card(page, id).querySelectorAll('svg.trend polyline')).map((line) => {
    const points = (line.getAttribute('points') ?? '').trim();
    return points === '' ? 0 : points.split(' ').length;
  });
}

function linePoints(page: Page, id: string): string[] {
  const line = card(page, id).querySelector('svg.trend polyline');
  return (line?.getAttribute('points') ?? '').split(' ');
}

function firstPoint(page: Page, id: string): string {
  return linePoints(page, id)[0] ?? '';
}

function lastPoint(page: Page, id: string): string {
  return linePoints(page, id).at(-1) ?? '';
}

function maxLabel(page: Page, id: string): string {
  return card(page, id).querySelector('.trend-max')?.textContent ?? '';
}

/** Lets the stream deliver: waits for a frame request, then a few more turns. */
async function settle(page: Page): Promise<void> {
  await until(() => page.frames.length > 0, 'a frame request');
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('dashboard cards — recent trend sparklines', () => {
  it('a replay of 300 windows draws 300 points per line in one redraw; a new window drops the oldest', async () => {
    const page = await openPage();
    try {
      page.runFrames();
      page.counts.points = 0;

      // The oldest window is a spike, so its removal shows in the max label.
      page.send(windowFrame(0, 1000) + windows(300).slice(windowFrame(0).length));
      await settle(page);
      expect(page.frames.length, 'pending frame requests').toBe(1);
      expect(page.counts.points, 'points writes before the frame').toBe(0);

      page.runFrames();
      // Five polylines (lag, heap, rss, gc, stall), each drawn once.
      expect(page.counts.points, 'points writes in the one redraw').toBe(5);
      expect(pointCounts(page, 'lag')).toEqual([300]);
      expect(pointCounts(page, 'memory')).toEqual([300, 300]);
      expect(pointCounts(page, 'gc')).toEqual([300]);
      expect(pointCounts(page, 'backpressure')).toEqual([300]);
      expect(maxLabel(page, 'lag')).toBe('max 1000.0 ms');
      expect(maxLabel(page, 'memory')).toBe('max 2000.0 MiB');
      expect(maxLabel(page, 'gc')).toBe('max 100.0 ms');
      expect(maxLabel(page, 'backpressure')).toBe('max 200.0 ms');
      expect(page.window.document.getElementById('lag')?.textContent).toContain('300.0 ms');

      // One more window: still 300 points, and the spike is gone.
      page.send(windowFrame(300));
      await settle(page);
      page.runFrames();
      expect(pointCounts(page, 'lag')).toEqual([300]);
      expect(pointCounts(page, 'memory')).toEqual([300, 300]);
      expect(maxLabel(page, 'lag')).toBe('max 301.0 ms');
      expect(maxLabel(page, 'memory')).toBe('max 602.0 MiB');
      expect(firstPoint(page, 'lag')).toBe('0,40');
      expect(lastPoint(page, 'lag')).toBe('299,0');
    } finally {
      await page.window.happyDOM.close();
    }
  });

  it('the page never holds more than 300 windows', async () => {
    const page = await openPage();
    try {
      page.send(windows(750));
      await settle(page);
      page.runFrames();
      for (const id of CARDS) {
        for (const count of pointCounts(page, id)) {
          expect(count, id).toBe(300);
        }
      }
      // The oldest 450 windows are gone: the series maximum and minimum are the last 300's.
      expect(maxLabel(page, 'lag')).toBe('max 750.0 ms');
    } finally {
      await page.window.happyDOM.close();
    }
  });

  it('a reconnect clears the sparklines and refills them from the new replay', async () => {
    const page = await openPage();
    try {
      page.send(windows(300));
      await settle(page);
      page.runFrames();
      expect(pointCounts(page, 'lag')).toEqual([300]);

      page.end();
      await waitFor(() => page.counts.fetches === 2, 'the reconnect');
      await settle(page);
      page.runFrames();
      expect(pointCounts(page, 'lag'), 'after reconnect, before the replay').toEqual([0]);
      expect(maxLabel(page, 'lag')).toBe('');

      page.send(windows(5, 2));
      await settle(page);
      page.runFrames();
      for (const id of CARDS) {
        for (const count of pointCounts(page, id)) {
          expect(count, id).toBe(5);
        }
      }
      expect(maxLabel(page, 'lag')).toBe('max 10.0 ms');
    } finally {
      await page.window.happyDOM.close();
    }
  }, 30_000);

  it('the sparklines are SVG built without style attributes or inline script', async () => {
    const page = await openPage();
    try {
      page.send(windows(3));
      await settle(page);
      page.runFrames();
      const document = page.window.document;
      const svgs = Array.from(document.querySelectorAll('svg.trend'));
      expect(svgs.length).toBe(4);
      for (const svg of svgs) {
        expect(svg.getAttribute('viewBox')).toBe('0 0 299 40');
      }
      expect(document.querySelectorAll('[style]').length).toBe(0);
      expect(APP_SCRIPT).toContain('createElementNS');
      expect(APP_SCRIPT).not.toContain('innerHTML');
      expect(renderPage().toLowerCase()).not.toContain(' style=');
      expect(renderPage().toLowerCase()).not.toContain('<script>');
    } finally {
      await page.window.happyDOM.close();
    }
  });

  it('embeds the unit-tested layout function, which right-aligns lines and scales to the shared max', () => {
    expect(APP_SCRIPT).toContain('var buildSparkline = ' + buildSparkline.toString() + ';');
    expect(
      buildSparkline(
        [
          [1, 2, 4],
          [0, 8],
        ],
        5,
        40,
      ),
    ).toEqual({
      points: ['2,35 3,30 4,20', '3,40 4,0'],
      max: 8,
    });
    expect(buildSparkline([[0, 0], []], 3, 40)).toEqual({ points: ['1,40 2,40', ''], max: 0 });
  });
});
