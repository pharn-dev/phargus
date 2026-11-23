import { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAgentOnce } from './auto-start.js';

const AGENT_KEY = Symbol.for('phargus.agent');

type AgentGlobal = { [AGENT_KEY]?: true };

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as AgentGlobal)[AGENT_KEY];
});

describe('startAgentOnce — off in the environment', () => {
  for (const [name, value] of [
    ['PHARGUS_ENABLED', 'false'],
    ['PHARGUS_ENABLED', '0'],
    ['PHARGUS_OUTPUT', 'none'],
  ] as const) {
    it(`${name}=${value} returns without patching http.Server.prototype.emit`, () => {
      vi.stubEnv(name, value);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        startAgentOnce();
        expect(Object.hasOwn(Server.prototype, 'emit')).toBe(false);
        expect(stderr).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
      }
    });
  }
});
