/** Payload and per-frame result shapes shared by the symbolization API and its worker. Types only. */

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

export type SymbolizeResult =
  | { status: 'unchanged' }
  | { status: 'mapped'; url: string; line: number; column: number }
  | { status: 'malformed'; file: string; reason: string };
