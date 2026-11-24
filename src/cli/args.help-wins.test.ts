import { describe, expect, it } from 'vitest';
import { main, type MainIo } from './main.js';
import { USAGE } from './usage.js';

describe('phargus: --help wins over everything', () => {
  it('prints the usage and exits 0 for --bogus --help, not a usage error', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: MainIo = {
      env: {},
      stdin: () => {
        throw new Error('stdin must not be touched');
      },
      output: () => {
        throw new Error('output must not be touched');
      },
      signals: { on: () => undefined, off: () => undefined },
      write: (text) => err.push(text),
      forceExit: (code) => {
        throw new Error(`forced exit ${String(code)}`);
      },
      stdout: (text) => out.push(text),
    };

    const code = await main(['--bogus', '--help'], io);

    expect(code).toBe(0);
    expect(out.join('')).toBe(USAGE);
    expect(err).toEqual([]);
  });
});
