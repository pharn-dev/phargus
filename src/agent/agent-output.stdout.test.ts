import { closeSync, openSync, readFileSync, fstatSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createFdOutput, writesStdoutItself } from './agent-output.js';

const dirs: string[] = [];
const fds: number[] = [];

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'phargus-fd-output-'));
  dirs.push(dir);
  return join(dir, 'out.ndjson');
}

function openFd(file: string, flags: string): number {
  const fd = openSync(file, flags);
  fds.push(fd);
  return fd;
}

afterEach(async () => {
  for (const fd of fds.splice(0)) closeSync(fd);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('writesStdoutItself', () => {
  const pipe = (): boolean => true;
  const notPipe = (): boolean => false;

  it('is true only on the main thread on Windows with stdout a pipe', () => {
    expect(writesStdoutItself('win32', true, pipe)).toBe(true);
    expect(writesStdoutItself('win32', true, notPipe)).toBe(false);
    expect(writesStdoutItself('win32', false, pipe)).toBe(false);
    expect(writesStdoutItself('linux', true, pipe)).toBe(false);
    expect(writesStdoutItself('darwin', true, pipe)).toBe(false);
  });

  it('does not look at stdout off Windows', () => {
    const throws = (): boolean => {
      throw new Error('stdout must not be inspected');
    };
    expect(writesStdoutItself('linux', true, throws)).toBe(false);
  });
});

describe('createFdOutput', () => {
  it('writes every line, in order, and leaves the descriptor open', async () => {
    const file = await tempFile();
    const fd = openFd(file, 'w');
    const lines = Array.from({ length: 500 }, (_, seq) => `${JSON.stringify({ seq })}\n`);

    await pipeline(Readable.from(lines), createFdOutput(fd));

    expect(readFileSync(file, 'utf8')).toBe(lines.join(''));
    expect(() => fstatSync(fd)).not.toThrow();
  });

  it('fails the stream with the write error', async () => {
    const file = await tempFile();
    openFd(file, 'w');
    const readOnly = openFd(file, 'r');

    await expect(pipeline(Readable.from(['{"a":1}\n']), createFdOutput(readOnly))).rejects.toThrow(
      /EBADF|EPERM|EACCES/,
    );
  });
});
