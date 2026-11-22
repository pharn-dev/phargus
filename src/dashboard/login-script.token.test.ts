import { describe, expect, it } from 'vitest';
import { LOGIN_SCRIPT } from './ui/login-script.js';

type DomElement = {
  textContent: string | null;
  appendChild(child: DomElement): unknown;
};

type TestWindow = {
  document: {
    write(html: string): void;
    createElement(tagName: string): DomElement;
    body: DomElement | null;
    getElementById(id: string): DomElement | null;
  };
  location: { href: string; hash: string };
  history: { replaceState(data: unknown, unused: string, url: string): void };
  fetch(input: string, init: { method: string; body: string }): Promise<{ status: number }>;
  happyDOM: { close(): Promise<void> };
};

type HappyDomModule = {
  Window: new (options: { url: string; settings: Record<string, boolean> }) => TestWindow;
};

async function runLogin(fragment: string): Promise<{
  postedBody: string | undefined;
  hashAtPost: string | undefined;
  status: string | null;
  finalHash: string;
}> {
  const happyDom = (await import('happy-dom')) as unknown as HappyDomModule;
  const window = new happyDom.Window({
    url: `http://dashboard.test/login${fragment}`,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  let postedBody: string | undefined;
  let hashAtPost: string | undefined;
  window.fetch = async (_input, init) => {
    postedBody = init.body;
    hashAtPost = window.location.hash;
    return { status: 401 };
  };
  try {
    window.document.write('<p id="status"></p>');
    const script = window.document.createElement('script');
    script.textContent = LOGIN_SCRIPT;
    window.document.body?.appendChild(script);
    await Promise.resolve();
    return {
      postedBody,
      hashAtPost,
      status: window.document.getElementById('status')?.textContent ?? null,
      finalHash: window.location.hash,
    };
  } finally {
    await window.happyDOM.close();
  }
}

describe('dashboard login token fragment parsing', () => {
  it.each([
    ['#token=ab+cd/ef==', 'ab+cd/ef=='],
    ['#token=ab%2Bcd', 'ab+cd'],
    ['#token=100%', '100%'],
  ])(
    'posts the original token from %s as JSON and clears the fragment first',
    async (fragment, token) => {
      const result = await runLogin(fragment);
      expect(result.postedBody).toBe(JSON.stringify({ token }));
      expect(result.hashAtPost).toBe('');
      expect(result.finalHash).toBe('');
    },
    30_000,
  );

  it.each(['', '#token=', '#other=value'])(
    'shows the missing-token message for %s',
    async (fragment) => {
      const result = await runLogin(fragment);
      expect(result.postedBody).toBeUndefined();
      expect(result.status).toBe('no login token in the link: open /login#token=<token>');
      expect(result.finalHash).toBe('');
    },
    30_000,
  );
});
