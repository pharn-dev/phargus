import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, repoRoot, tempDir } from '../../test/support.js';

const PACK_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 360_000;

/**
 * Packs the package into `destination` with `npm pack --ignore-scripts` and returns the tarball's
 * path. `prepack` would rebuild (and first delete) dist/ while other tests run from it; the test
 * run's global setup has already built it.
 */
async function packFreshTarball(destination: string): Promise<string> {
  // Under `npm test`, npm_execpath is npm's own CLI script: running it with this Node avoids
  // resolving an `npm` shim, which on Windows is npm.cmd and needs a shell.
  const npmCli = process.env['npm_execpath'];
  const [command, prefix] =
    npmCli !== undefined && /\.c?js$/.test(npmCli)
      ? [process.execPath, [npmCli]]
      : ['npm', [] as string[]];
  const result = spawnSync(
    command,
    [...prefix, 'pack', '--ignore-scripts', '--pack-destination', destination],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: PACK_TIMEOUT_MS,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `npm pack failed (status ${String(result.status)}, signal ${String(result.signal)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  const tarballs = readdirSync(destination).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(
      `expected exactly one tarball in ${destination}, found ${JSON.stringify(tarballs)}`,
    );
  }
  return join(destination, String(tarballs[0]));
}

type TarEntry = { mode: number; data: Buffer };

function cString(bytes: Buffer): string {
  const nul = bytes.indexOf(0);
  return (nul === -1 ? bytes : bytes.subarray(0, nul)).toString('utf8');
}

function octal(bytes: Buffer): number {
  const text = cString(bytes).trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/** The `path` record of a pax extended header, if it has one. */
function paxPath(data: Buffer): string | undefined {
  let offset = 0;
  const text = data.toString('utf8');
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    const eq = record.indexOf('=');
    if (eq !== -1 && record.slice(0, eq) === 'path') return record.slice(eq + 1);
    offset += length;
  }
  return undefined;
}

/** Reads the regular-file entries of a gzipped ustar/pax tarball: path -> mode and contents. */
function readTarball(file: string): Map<string, TarEntry> {
  const tar = gunzipSync(readFileSync(file));
  const entries = new Map<string, TarEntry>();
  let offset = 0;
  let nextPath: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = cString(header.subarray(0, 100));
    const mode = octal(header.subarray(100, 108));
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = cString(header.subarray(345, 500));
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      nextPath = paxPath(data);
      continue;
    }
    if (type === 'L') {
      nextPath = cString(data);
      continue;
    }
    if (type === 'g') continue;
    const path = nextPath ?? (prefix === '' ? name : `${prefix}/${name}`);
    nextPath = undefined;
    if (type === '0' || type === '\0') {
      entries.set(path, { mode, data: Buffer.from(data) });
    }
  }
  return entries;
}

afterAll(cleanup);

describe('phargus CLI: the packed tarball ships the bin', () => {
  it(
    "AC-9: npm pack's manifest maps bin phargus to a file in the tarball whose first line is #!/usr/bin/env node and whose mode is executable",
    async () => {
      const destination = tempDir('phargus-ac9-pack-');
      const tarball = await packFreshTarball(destination);
      const entries = readTarball(tarball);

      const manifestEntry = entries.get('package/package.json');
      expect(
        manifestEntry,
        `package/package.json in ${[...entries.keys()].join(', ')}`,
      ).toBeDefined();
      const manifest = JSON.parse(manifestEntry?.data.toString('utf8') ?? '{}') as {
        name?: unknown;
        bin?: unknown;
      };

      const bin = manifest.bin;
      let target: unknown;
      if (typeof bin === 'string') {
        target = bin;
      } else if (typeof bin === 'object' && bin !== null) {
        target = (bin as Record<string, unknown>)['phargus'];
      }
      expect(typeof target, `manifest bin: ${JSON.stringify(bin)}`).toBe('string');

      const entryPath = `package/${posix.normalize(String(target)).replace(/^\.\//, '')}`;
      const binEntry = entries.get(entryPath);
      expect(binEntry, `${entryPath} in ${[...entries.keys()].join(', ')}`).toBeDefined();

      const firstLine = (binEntry?.data.toString('utf8') ?? '').split('\n')[0];
      expect(firstLine).toBe('#!/usr/bin/env node');
      // npm pack takes file modes from the file system, and Windows has no POSIX execute bit, so
      // a tarball packed there has a 644 bin. Releases are packed on Linux (see docs/LIMITS.md).
      if (process.platform !== 'win32') {
        expect((binEntry?.mode ?? 0) & 0o111, `mode ${(binEntry?.mode ?? 0).toString(8)}`).not.toBe(
          0,
        );
      }
    },
    TEST_TIMEOUT_MS,
  );
});
