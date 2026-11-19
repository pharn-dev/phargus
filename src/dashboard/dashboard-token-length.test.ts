import { describe, expect, it } from 'vitest';
import { createCollector } from '../collector/index.js';
import { createDashboardServer } from './index.js';

function collector() {
  return createCollector({ windowMs: 1000, capacity: 10 });
}

describe('dashboard token length', () => {
  it('rejects a short token off loopback without including the value in the error', async () => {
    const token = 'secret-short';
    let caught: unknown;
    try {
      await createDashboardServer({ collector: collector(), host: '0.0.0.0', port: 0, token });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as Error).message).toContain('16 characters');
    expect((caught as Error).message).not.toContain(token);
  });

  it('accepts a 16-character token off loopback and a one-character token on loopback', async () => {
    const remote = await createDashboardServer({
      collector: collector(),
      host: '0.0.0.0',
      port: 0,
      token: '0123456789abcdef',
    });
    await remote.close();

    const local = await createDashboardServer({
      collector: collector(),
      host: '127.0.0.1',
      port: 0,
      token: 'a',
    });
    await local.close();
  });
});
