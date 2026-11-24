import { resolve } from 'node:path';
import type { ResourceLimits } from 'node:worker_threads';
import { resolveBundledWorkerFile } from './worker-file.js';
import { createWorkerPool, type WorkerPool } from './worker-pool.js';

/** Typed error for a source map that was found but cannot be parsed. */
export class MalformedSourceMapError extends Error {
  readonly code = 'ERR_MALFORMED_SOURCE_MAP';
  readonly file: string;

  constructor(file: string, reason: string) {
    super(`malformed source map for ${file}: ${reason}`);
    this.name = 'MalformedSourceMapError';
    this.file = file;
  }
}

/** Payload the symbolization worker receives. */
export type SymbolizeRequest = {
  frames: { url: string; line: number; column: number }[];
  /** Largest built file or source map the worker reads, in bytes. */
  maxFileBytes: number;
  /**
   * Absolute directories reads are confined to; absent means unconfined. The API sends it absent
   * only for an explicit `roots: null`; when the caller leaves `roots` out it sends the working
   * directory.
   */
  roots?: string[];
};

/** Per-frame result the symbolization worker sends back. */
export type SymbolizeResult =
  | { status: 'unchanged' }
  | { status: 'mapped'; url: string; line: number; column: number }
  | { status: 'malformed'; file: string; reason: string };

export type StackFrame = { url: string; line: number; column: number };

export type OriginalPosition = { url: string; line: number; column: number };

export type SymbolizedFrame = StackFrame & {
  original?: OriginalPosition;
  error?: MalformedSourceMapError;
};

type SymbolizeOptions = {
  /** A pool from `createSymbolizationPool()`; its worker's reply is used without a re-check. */
  pool?: WorkerPool;
  timeoutMs?: number;
  /**
   * Directories the symbolizer may read from. A frame's built file and its source map are read
   * only if their real path (symlinks and `..` resolved) lies inside one of them; frames outside
   * are returned unchanged, with no `original` and no `error`. When left out, reads are confined
   * to the current working directory (read on each call). `null` turns confinement off, so any
   * local file a frame or `sourceMappingURL` names may be read. A broad working directory such as
   * `/` or `$HOME` confines little: pass `roots` naming your build output instead.
   */
  roots?: readonly string[] | null | undefined;
  /**
   * Largest built file or source map read, in bytes. Default 64 MiB, lowered to 1/8 of the
   * pool's `resourceLimits.maxOldGenerationSizeMb` when that is smaller. A larger built file is
   * left unsymbolized; a larger source map is reported as malformed. An explicit value needs a
   * worker old generation of at least 8x itself, or the call rejects with a RangeError.
   */
  maxFileBytes?: number;
};

export const DEFAULT_MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
/** Worker old-generation size needed per byte of file the symbolizer may read and parse. */
const HEAP_PER_FILE_BYTE = 8;
const MIB = 1024 * 1024;

export function createSymbolizationPool(
  options: { size?: number; taskTimeoutMs?: number; resourceLimits?: ResourceLimits } = {},
): WorkerPool {
  return createWorkerPool({
    size: options.size ?? 1,
    workerFile: resolveBundledWorkerFile('symbolize.worker'),
    ...(options.taskTimeoutMs === undefined ? {} : { taskTimeoutMs: options.taskTimeoutMs }),
    ...(options.resourceLimits === undefined ? {} : { resourceLimits: options.resourceLimits }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function checkFrames(frames: readonly StackFrame[]): void {
  if (!Array.isArray(frames)) throw new TypeError('frames must be an array');
  frames.forEach((frame: unknown, index: number) => {
    if (
      !isRecord(frame) ||
      typeof frame.url !== 'string' ||
      !isInt(frame.line) ||
      frame.line <= 0 ||
      !isInt(frame.column) ||
      frame.column <= 0
    ) {
      throw new TypeError(
        `frames[${index}] must have a string url and positive integer line and column`,
      );
    }
  });
}

function checkRoots(roots: readonly string[] | null | undefined): string[] | undefined {
  if (roots === undefined) return [resolve(process.cwd())];
  if (roots === null) return undefined;
  if (!Array.isArray(roots)) {
    throw new TypeError('roots must be null or an array of directory paths');
  }
  return roots.map((root: unknown, index) => {
    if (typeof root !== 'string' || root === '') {
      throw new TypeError(`roots[${index}] must be a non-empty string`);
    }
    return resolve(root);
  });
}

/**
 * The file cap for this call. Reading a file and JSON.parse-ing a map are native operations that
 * V8 cannot interrupt near the worker's heap limit (an overrun aborts the whole process), so the
 * cap must leave the worker heap a wide margin over the largest file.
 */
function checkMaxFileBytes(value: number | undefined, pool: WorkerPool | undefined): number {
  const heapMb = pool === undefined ? undefined : pool.resourceLimits?.maxOldGenerationSizeMb;
  const fitsHeap =
    heapMb === undefined ? undefined : Math.floor((heapMb * MIB) / HEAP_PER_FILE_BYTE);
  if (value === undefined) {
    return Math.max(1, Math.min(DEFAULT_MAX_SOURCE_FILE_BYTES, fitsHeap ?? Infinity));
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('maxFileBytes must be a positive safe integer');
  }
  if (heapMb !== undefined && fitsHeap !== undefined && value > fitsHeap) {
    const neededMb = Math.ceil((value * HEAP_PER_FILE_BYTE) / MIB);
    throw new RangeError(
      `maxFileBytes ${String(value)} needs a symbolization worker heap of at least ` +
        `${String(neededMb)} MiB (resourceLimits.maxOldGenerationSizeMb is ${String(heapMb)})`,
    );
  }
  return value;
}

async function runTask(payload: unknown, options: SymbolizeOptions): Promise<unknown> {
  const pool = options.pool ?? createSymbolizationPool();
  try {
    return await pool.run(
      payload,
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    );
  } finally {
    if (options.pool === undefined) await pool.close();
  }
}

export async function symbolizeStackFrames(
  frames: readonly StackFrame[],
  options: SymbolizeOptions = {},
): Promise<SymbolizedFrame[]> {
  checkFrames(frames);
  const roots = checkRoots(options.roots);
  const maxFileBytes = checkMaxFileBytes(options.maxFileBytes, options.pool);
  const payload: SymbolizeRequest = {
    frames: frames.map(({ url, line, column }) => ({ url, line, column })),
    maxFileBytes,
    ...(roots === undefined ? {} : { roots }),
  };
  // The bundled worker is trusted code in this process: its reply is not re-checked.
  const reply = (await runTask(payload, options)) as SymbolizeResult[];
  const errors = new Map<string, MalformedSourceMapError>();
  return frames.map((frame, index): SymbolizedFrame => {
    const result = reply[index] as SymbolizeResult;
    if (result.status === 'mapped') {
      const { url, line, column } = result;
      return { ...frame, original: { url, line, column } };
    }
    if (result.status === 'malformed') {
      let error = errors.get(result.file);
      if (error === undefined) {
        error = new MalformedSourceMapError(result.file, result.reason);
        errors.set(result.file, error);
      }
      return { ...frame, error };
    }
    return { ...frame };
  });
}
