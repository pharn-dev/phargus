import { describe, expect, it } from 'vitest';
import { APP_SCRIPT } from './ui/app-script.js';
import { renderPage } from './ui/page.js';
import { buildWaterfall } from './ui/waterfall-model.js';

type DomElement = {
  textContent: string | null;
  innerHTML: string;
  hidden: boolean;
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

/** The dashboard client running in happy-dom, with a hand-driven stream and animation frame. */
type Page = {
  window: TestWindow;
  waterfall: DomElement;
  /** Animation-frame callbacks requested and not yet run. */
  frames: (() => void)[];
  counts: { builds: number; rebuilds: number };
  send(text: string): void;
  runFrames(): void;
};

const MAX_TRACES = 20;

/** 1,024 spans: 256 traces of four spans each, every seventh a 503, in start order. */
function makeSpans(): Record<string, unknown>[] {
  const spans: Record<string, unknown>[] = [];
  for (let i = 0; i < 1024; i += 1) {
    const trace = Math.floor(i / 4);
    const statusCode = i % 7 === 0 ? 503 : 200;
    spans.push({
      type: 'span',
      traceId: trace.toString(16).padStart(32, '0'),
      spanId: i.toString(16).padStart(16, '0'),
      name: 'GET /item/' + i,
      method: 'GET',
      path: '/item/' + i,
      statusCode,
      startTimeMs: 1_700_000_000_000 + trace * 10 + (i % 4),
      durationNs: 1_000_000 + (i % 13) * 250_000,
    });
  }
  return spans;
}

function spanFrame(span: Record<string, unknown>): string {
  return 'event: span\ndata: ' + JSON.stringify(span) + '\n\n';
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

/** Wraps an own-instance setter around the prototype's `hidden` accessor to count assignments. */
function countHidden(element: DomElement, onSet: () => void): void {
  let proto: object | null = Object.getPrototypeOf(element) as object | null;
  let descriptor: PropertyDescriptor | undefined;
  while (proto !== null && descriptor === undefined) {
    descriptor = Object.getOwnPropertyDescriptor(proto, 'hidden');
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  const { get, set } = descriptor ?? {};
  if (get === undefined || set === undefined) {
    throw new Error('no hidden accessor on the element');
  }
  Object.defineProperty(element, 'hidden', {
    configurable: true,
    get(this: DomElement): unknown {
      return get.call(this);
    },
    set(this: DomElement, value: unknown): void {
      onSet();
      set.call(this, value);
    },
  });
}

/** With `syncFrames`, a requested frame runs at once: every span event rebuilds, as before. */
async function openPage(syncFrames = false): Promise<Page> {
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
  const counts = { builds: 0, rebuilds: 0 };
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  Object.assign(window, {
    requestAnimationFrame(callback: () => void): number {
      if (syncFrames) {
        callback();
        return 0;
      }
      frames.push(callback);
      return frames.length;
    },
    fetch: () => Promise.resolve({ status: 200, ok: true, body }),
    countBuild:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]): unknown => {
        counts.builds += 1;
        return fn(...args);
      },
  });

  // The embedded layout function, wrapped so the page counts its calls.
  const embedded = 'var buildWaterfall = ' + buildWaterfall.toString() + ';';
  expect(APP_SCRIPT).toContain(embedded);
  const source = APP_SCRIPT.replace(
    embedded,
    'var buildWaterfall = window.countBuild(' + buildWaterfall.toString() + ');',
  );

  const document = window.document;
  document.write(renderPage());
  const waterfall = document.getElementById('waterfall');
  const empty = document.getElementById('waterfall-empty');
  const status = document.getElementById('status');
  if (waterfall === null || empty === null || status === null) {
    throw new Error('the page is missing the waterfall or status element');
  }
  // renderWaterfall assigns `hidden` once per rebuild.
  countHidden(empty, () => {
    counts.rebuilds += 1;
  });
  const script = document.createElement('script');
  script.textContent = source;
  document.body?.appendChild(script);
  await until(() => status.textContent === 'live', 'the stream to connect');

  const encoder = new TextEncoder();
  return {
    window,
    waterfall,
    frames,
    counts,
    send(text) {
      controller?.enqueue(encoder.encode(text));
    },
    runFrames() {
      for (const callback of frames.splice(0)) {
        callback();
      }
    },
  };
}

describe('dashboard waterfall — one rebuild per animation frame', () => {
  it('1,024 span events in one task cause one buildWaterfall call and one rebuild, with the same DOM as a rebuild per span', async () => {
    const spans = makeSpans();
    const burst = await openPage();
    const perSpan = await openPage(true);
    try {
      // Connecting clears the waterfall; let that frame run, then count from zero.
      burst.runFrames();
      burst.counts.builds = 0;
      burst.counts.rebuilds = 0;

      burst.send(spans.map(spanFrame).join(''));
      await until(() => burst.frames.length > 0, 'a frame request after the burst');
      // A few more turns: nothing else is requested and nothing is built before the frame runs.
      for (let i = 0; i < 10; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(burst.frames.length, 'pending frame requests').toBe(1);
      expect(burst.counts.builds, 'builds before the frame').toBe(0);

      burst.runFrames();
      expect(burst.counts.builds, 'buildWaterfall calls').toBe(1);
      expect(burst.counts.rebuilds, 'waterfall rebuilds').toBe(1);
      expect(burst.frames.length, 'frame requests after the frame').toBe(0);

      // The previous behaviour: the same burst with the waterfall rebuilt for every span.
      perSpan.counts.builds = 0;
      perSpan.send(spans.map(spanFrame).join(''));
      await until(() => perSpan.counts.builds === spans.length, 'a rebuild per span');

      const traces = burst.waterfall.querySelectorAll('li.trace');
      expect(traces.length).toBe(MAX_TRACES);
      expect(traces[0]?.textContent).toContain('GET /item/1023 200');
      expect(burst.waterfall.querySelectorAll('.row-error').length).toBeGreaterThan(0);
      expect(burst.waterfall.innerHTML).toBe(perSpan.waterfall.innerHTML);
    } finally {
      await burst.window.happyDOM.close();
      await perSpan.window.happyDOM.close();
    }
  }, 60_000);

  it('an aborted span keeps its marker after later spans arrive', async () => {
    const [first, second] = makeSpans();
    const page = await openPage();
    try {
      page.send(spanFrame({ ...first, aborted: true }));
      await until(() => page.frames.length > 0, 'a frame request');
      page.runFrames();
      page.send(spanFrame({ ...second }));
      await until(() => page.frames.length > 0, 'a frame request');
      page.runFrames();
      expect(page.waterfall.textContent).toContain('GET /item/0 503 1.0 ms aborted');
      expect(page.waterfall.textContent).toContain('GET /item/1 200');
    } finally {
      await page.window.happyDOM.close();
    }
  });

  it('the read loop is an async while loop', () => {
    expect(APP_SCRIPT).toMatch(/async function readLoop\(/);
    expect(APP_SCRIPT).toContain('while (true)');
    expect(APP_SCRIPT).toContain('await reader.read()');
  });
});
