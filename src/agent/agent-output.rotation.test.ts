import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { openAgentOutput, rotatedOutputPath } from './agent-output.js';
import { defaultAgentConfig, readConfigEnv, validateConfigValue } from './config.js';

const MIB = 1_048_576;

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'phargus-output-rotation-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** NDJSON lines of varying length (about 200 to 1700 bytes), numbered from 0, `totalBytes` in all. */
function lines(totalBytes: number): { lines: string[]; longest: number } {
  const out: string[] = [];
  let bytes = 0;
  let longest = 0;
  for (let seq = 0; bytes < totalBytes; seq += 1) {
    const line = `${JSON.stringify({ seq, pad: 'x'.repeat(200 + ((seq * 37) % 1500)) })}\n`;
    out.push(line);
    bytes += line.length;
    longest = Math.max(longest, line.length);
  }
  return { lines: out, longest };
}

async function writeAll(file: string, maxBytes: number, all: string[]): Promise<void> {
  await pipeline(Readable.from(all), openAgentOutput(file, maxBytes));
}

/** Parse every line of a file; throws on a line that is not JSON (a split line). */
async function parsedSeqs(file: string): Promise<number[]> {
  const text = await readFile(file, 'utf8');
  expect(text.endsWith('\n'), `${file} ends with a whole line`).toBe(true);
  return text
    .slice(0, -1)
    .split('\n')
    .map((line) => (JSON.parse(line) as { seq: number }).seq);
}

describe('agent output file size bound', () => {
  it('AC-1: with a 1 MiB bound, 3 MiB of output leaves exactly <file> and <file>.1, each within the bound plus one line, every line whole JSON and contiguous across the two', async () => {
    const dir = await tempDir();
    const file = join(dir, 'out.ndjson');
    const { lines: all, longest } = lines(3 * MIB);
    await writeAll(file, MIB, all);

    expect((await readdir(dir)).sort()).toEqual(['out.ndjson', 'out.ndjson.1']);
    for (const path of [file, rotatedOutputPath(file)]) {
      expect((await stat(path)).size).toBeLessThanOrEqual(MIB + longest);
    }
    const older = await parsedSeqs(rotatedOutputPath(file));
    const newer = await parsedSeqs(file);
    const seqs = [...older, ...newer];
    // The newest lines survive, in order, with no gap at the rotation point.
    expect(seqs.at(-1)).toBe(all.length - 1);
    seqs.forEach((seq, i) => {
      expect(seq).toBe((seqs[0] ?? 0) + i);
    });
  });

  it('AC-1: an existing file counts toward the bound', async () => {
    const dir = await tempDir();
    const file = join(dir, 'out.ndjson');
    await writeFile(file, `${JSON.stringify({ seq: -1, pad: 'y'.repeat(900) })}\n`);
    await writeAll(file, 1000, lines(10).lines);

    expect(await parsedSeqs(rotatedOutputPath(file))).toEqual([-1]);
    expect(await parsedSeqs(file)).toEqual([0]);
  });

  it('AC-3: a bound of 0 keeps one file with every line', async () => {
    const dir = await tempDir();
    const file = join(dir, 'out.ndjson');
    const { lines: all } = lines(3 * MIB);
    await writeAll(file, 0, all);

    expect(await readdir(dir)).toEqual(['out.ndjson']);
    expect((await parsedSeqs(file)).length).toBe(all.length);
  });

  it('AC-3: PHARGUS_OUTPUT_MAX_BYTES defaults to 64 MiB, takes 0, and an invalid value throws naming the variable', () => {
    expect(defaultAgentConfig.outputMaxBytes).toBe(67_108_864);
    expect(readConfigEnv({ PHARGUS_OUTPUT_MAX_BYTES: '0' }, '/', () => {})).toEqual({
      outputMaxBytes: 0,
    });
    expect(readConfigEnv({ PHARGUS_OUTPUT_MAX_BYTES: '1048576' }, '/', () => {})).toEqual({
      outputMaxBytes: MIB,
    });
    for (const bad of ['lots', '-1', '1.5', '']) {
      expect(() => readConfigEnv({ PHARGUS_OUTPUT_MAX_BYTES: bad }, '/', () => {})).toThrow(
        /PHARGUS_OUTPUT_MAX_BYTES/,
      );
    }
    expect(() => {
      validateConfigValue('phargus.config.json', 'outputMaxBytes', -1);
    }).toThrow(/outputMaxBytes/);
  });

  it.skipIf(process.platform === 'win32')(
    'AC-4: the file opened after a rotation has mode 0600',
    async () => {
      const dir = await tempDir();
      const file = join(dir, 'out.ndjson');
      await writeAll(file, 4096, lines(20_000).lines);

      expect((await stat(rotatedOutputPath(file))).isFile()).toBe(true);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    },
  );

  it('a failed rename fails the stream with an error naming both paths', async () => {
    const dir = await tempDir();
    const file = join(dir, 'out.ndjson');
    // A non-empty directory at <file>.1: the rename cannot replace it.
    await mkdir(join(rotatedOutputPath(file), 'keep'), { recursive: true });

    await expect(writeAll(file, 1000, lines(5000).lines)).rejects.toThrow(
      `cannot rotate ${file} to ${rotatedOutputPath(file)}`,
    );
  });

  it('AC-5: stdout is returned as is, whatever the bound', () => {
    expect(openAgentOutput('stdout', 0)).toBe(process.stdout);
    expect(openAgentOutput('stdout', MIB)).toBe(process.stdout);
  });
});
