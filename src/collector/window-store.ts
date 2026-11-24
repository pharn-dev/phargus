import { open, readFile, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { isPermissionModelEnabled } from '../agent/permission.js';
import { createRingBuffer } from './ring-buffer.js';
import type { AggregatedWindow } from './window.js';
import { parseWindowLine, serializeWindow } from './window-codec.js';

export type PersistOptions = {
  path: string;
  maxBytes: number;
  /**
   * Most windows waiting for the disk; when full the oldest is dropped and counted (default
   * 1024). Used by the collector's persistence queue; the store itself ignores it.
   */
  maxQueueSize?: number;
};

/** Mode for files the store creates (owner read/write only); existing files keep their mode. */
const FILE_MODE = 0o600;

export type WindowStore = {
  readonly path: string;
  readonly maxBytes: number;
  readonly skipped: number;
  readonly restored: number;
  readonly bytes: number;
  restore(): Promise<AggregatedWindow[]>;
  /**
   * Appends one window; call it again only once the previous call settled (the collector's
   * persistence queue appends one at a time). Rejects after `close()`, and never reopens the file.
   */
  append(window: AggregatedWindow): Promise<void>;
  /** Closes the file handle once a pending write finishes; a later `append()` reopens it. */
  release(): Promise<void>;
  /** Releases and latches the store closed: every later `append()` rejects. Idempotent. */
  close(): Promise<void>;
};

export function createWindowStore(options: PersistOptions & { capacity: number }): WindowStore {
  const { path, maxBytes, capacity } = options;
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('persist.path must be a non-empty string');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('persist.maxBytes must be a positive safe integer');
  }
  const ring = createRingBuffer<AggregatedWindow>(capacity);
  const tmpPath = `${path}.compact.tmp`;
  let skipped = 0;
  let restored = 0;
  let bytes = 0;
  let needsNewline = false;
  let handle: FileHandle | undefined;
  let closed = false;

  // FileHandle.close() waits for a pending write on the handle before it closes it.
  async function closeHandle(): Promise<void> {
    const current = handle;
    handle = undefined;
    if (current !== undefined) {
      await current.close();
    }
  }

  /** The newest windows whose lines fit in half of `maxBytes`, and always the newest one. */
  function newestContent(): string {
    const lines = ring.snapshot().map(serializeWindow);
    const budget = Math.floor(maxBytes / 2);
    let start = lines.length - 1;
    let size = Buffer.byteLength(lines[start] as string);
    while (start > 0) {
      const next = Buffer.byteLength(lines[start - 1] as string);
      if (size + next > budget) {
        break;
      }
      size += next;
      start -= 1;
    }
    return lines.slice(start).join('');
  }

  /**
   * Rewrites the file with the newest windows that fit in half of `maxBytes`, through a temp file
   * next to it and a rename, so one compaction leaves room for many appends.
   */
  async function compact(): Promise<void> {
    await closeHandle();
    const content = newestContent();
    // The rewrite replaces the file, so carry its current mode over (0600 when the store made it).
    let mode = FILE_MODE;
    try {
      mode = (await stat(path)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    // A stale temp file (a crash mid-compaction) is removed; 'wx' then refuses anything that
    // appears in its place, such as a planted symlink, instead of writing through it.
    await rm(tmpPath, { force: true });
    try {
      const tmp = await open(tmpPath, 'wx', mode);
      // Recent Node releases refuse fd-based fchmod and fdatasync under the permission model. There
      // the temp file keeps the mode open() gave it (the umask can only narrow it), and the rewrite
      // is not flushed before the rename, so a power loss can cost the compacted windows.
      const fdCallsAllowed = !isPermissionModelEnabled();
      try {
        if (fdCallsAllowed && ((await tmp.stat()).mode & 0o777) !== mode) {
          await tmp.chmod(mode);
        }
        await tmp.writeFile(content);
        if (fdCallsAllowed) {
          await tmp.datasync();
        }
      } finally {
        await tmp.close();
      }
      await rename(tmpPath, path);
    } catch (error) {
      try {
        await rm(tmpPath, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'window compaction failed and its temp file could not be removed',
          { cause: cleanupError },
        );
      }
      throw error;
    }
    bytes = Buffer.byteLength(content);
    needsNewline = false;
  }

  return {
    path,
    maxBytes,
    get skipped(): number {
      return skipped;
    },
    get restored(): number {
      return restored;
    },
    get bytes(): number {
      return bytes;
    },
    async restore(): Promise<AggregatedWindow[]> {
      let data: Buffer;
      try {
        data = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return [];
        }
        throw error;
      }
      const lines = data.toString('utf8').split('\n');
      // The text after the last newline is empty, or a partial line left by a crash.
      const last = lines.pop() as string;
      if (last.length > 0) {
        lines.push(last);
        needsNewline = true;
      }
      for (const line of lines) {
        const window = parseWindowLine(line);
        if (window === undefined) {
          skipped += 1;
        } else {
          ring.push(window);
        }
      }
      bytes = data.length;
      const out = ring.snapshot();
      restored = out.length;
      return out;
    },
    async append(window: AggregatedWindow): Promise<void> {
      if (closed) {
        throw new Error(`window store ${path} is closed; the window was not persisted`);
      }
      const line = `${needsNewline ? '\n' : ''}${serializeWindow(window)}`;
      ring.push(window);
      if (bytes + Buffer.byteLength(line) > maxBytes) {
        // Compacting first keeps the file within maxBytes; the rewrite includes this window. If
        // it fails, nothing is appended, so the file stays within the cap.
        await compact();
        return;
      }
      handle ??= await open(path, 'a', FILE_MODE);
      await handle.appendFile(line);
      needsNewline = false;
      bytes += Buffer.byteLength(line);
    },
    release: closeHandle,
    close(): Promise<void> {
      closed = true;
      return closeHandle();
    },
  };
}
