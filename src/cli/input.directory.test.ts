import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { main, type MainIo } from './main.js';

const dir = mkdtempSync(join(tmpdir(), 'phargus-input-dir-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('phargus serve: an unreadable input fails before anything binds', () => {
  it('refuses a directory path by name and never prints a dashboard URL', async () => {
    const lines: string[] = [];
    const io: MainIo = {
      env: {},
      stdin: () => new PassThrough(),
      output: () => new PassThrough(),
      signals: new EventEmitter(),
      write: (text) => lines.push(text),
      forceExit: (code) => {
        throw new Error(`forced exit ${String(code)}: ${lines.join('\n')}`);
      },
      stdout: () => undefined,
    };

    const code = await main(['serve', '--port', '0', dir], io);

    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(`cannot read input file "${dir}": EISDIR`);
    expect(lines.some((line) => line.includes('dashboard at'))).toBe(false);
  });
});
