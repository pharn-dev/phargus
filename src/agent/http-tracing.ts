import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { Server as HttpServer } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import { disableTraceContext, runInTrace } from './context.js';
import { createSpanBuffer } from './span-buffer.js';
import type { SpanBuffer, SpanDrain } from './span-buffer.js';
import { newTraceId, parseTraceparent } from './trace-id.js';

export const DEFAULT_SPAN_BUFFER_SIZE = 1024;

export type HttpTracingOptions = { spanBufferSize?: number };

type Inflight = {
  traceId: string;
  startTimeMs: number;
  startNs: bigint;
  method: string;
  path: string;
  /** The parent-id of a continued `traceparent`; undefined for a fresh trace. */
  parentSpanId: string | undefined;
};

/** A span keeps at most this many characters of the requested path. */
const MAX_PATH_CHARS = 256;

const START_CHANNEL = 'http.server.request.start';
const FINISH_CHANNEL = 'http.server.response.finish';

let enabled = false;
let buffer: SpanBuffer = createSpanBuffer(DEFAULT_SPAN_BUFFER_SIZE);
/** Drops of a buffer replaced by `setSpanBufferSize()`, reported by the next `drainSpans()`. */
let carriedDrops = 0;
const inflight = new WeakMap<object, Inflight>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function warn(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.emitWarning(`http tracing handler failed: ${message}`, 'PhargusTracingWarning');
}

function headerValue(headers: unknown): string | string[] | undefined {
  if (!isObject(headers)) {
    return undefined;
  }
  const value = headers.traceparent;
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return undefined;
}

function onStart(message: unknown): void {
  try {
    if (!isObject(message) || !isObject(message.request)) {
      return;
    }
    const request = message.request;
    const parent = parseTraceparent(headerValue(request.headers));
    // Read now: a framework may rewrite `req.url` before the response finishes.
    const url = typeof request.url === 'string' ? request.url : '';
    const queryAt = url.indexOf('?');
    const pathEnd = Math.min(queryAt === -1 ? url.length : queryAt, MAX_PATH_CHARS);
    inflight.set(request, {
      traceId: parent?.traceId ?? newTraceId(),
      startTimeMs: Date.now(),
      startNs: process.hrtime.bigint(),
      method: typeof request.method === 'string' ? request.method : '',
      path: url.slice(0, pathEnd),
      parentSpanId: parent?.parentSpanId,
    });
    if (message.response instanceof EventEmitter) {
      message.response.once('close', onClose);
    }
  } catch (error) {
    warn(error);
  }
}

/**
 * The response closed. After a normal finish the entry is gone; one still in flight means the
 * request ended early (client disconnected, `destroy()`, a timeout), so it gets an aborted span.
 */
function onClose(this: unknown): void {
  onResponseClose(this);
}

function onResponseClose(response: unknown): void {
  try {
    if (!enabled || !isObject(response) || !isObject(response.req)) {
      return;
    }
    const entry = inflight.get(response.req);
    if (entry === undefined) {
      return;
    }
    const statusCode =
      response.headersSent === true && typeof response.statusCode === 'number'
        ? response.statusCode
        : 0;
    recordSpan(response.req, entry, statusCode, true);
  } catch (error) {
    warn(error);
  }
}

function onFinish(message: unknown): void {
  try {
    if (!isObject(message) || !isObject(message.request) || !isObject(message.response)) {
      return;
    }
    const request = message.request;
    const entry = inflight.get(request);
    if (entry === undefined) {
      return;
    }
    recordSpan(
      request,
      entry,
      typeof message.response.statusCode === 'number' ? message.response.statusCode : 0,
      false,
    );
  } catch (error) {
    warn(error);
  }
}

function recordSpan(request: object, entry: Inflight, statusCode: number, aborted: boolean): void {
  inflight.delete(request);
  const elapsed = Number(process.hrtime.bigint() - entry.startNs);
  // The span id is made here, as bytes in the buffer: nothing reads it while the request runs.
  buffer.record(
    entry.traceId,
    entry.method,
    entry.path,
    statusCode,
    entry.startTimeMs,
    Math.min(Math.max(elapsed, 0), Number.MAX_SAFE_INTEGER),
    aborted,
    entry.parentSpanId,
  );
}

// ---- `emit` wrap -----------------------------------------------------------------------------
//
// Each server's 'request' listeners run inside the trace the start channel assigned to that
// request. The start channel publishes synchronously right before `emit('request', …)`, so the
// request is already in `inflight` when the wrapper runs. `runInTrace` scopes the context to the
// listeners and their async continuations only — nothing created earlier (a keep-alive socket)
// inherits it.
//
// The wrappers are installed once, by the first `enable()`, and never removed. While tracing is
// disabled they are inert: they call the next `emit` with the same `this` and arguments and return
// its result, so a wrapper someone installs on top keeps working. One copy of Phargus patches: the
// agent starts once per process (`auto-start.ts`), and only the agent enables tracing.

type Emit = (this: unknown, event: string | symbol, ...args: unknown[]) => boolean;

let emitsInstalled = false;

function patchEmit(proto: object): void {
  try {
    const own = Object.hasOwn(proto, 'emit') ? (proto as { emit: Emit }).emit : undefined;
    const parent = Object.getPrototypeOf(proto) as { emit: Emit };
    // With no own `emit`, the next one is looked up on the prototype chain at call time, so a later
    // replacement (node:domain, other instrumentation) of `EventEmitter.prototype.emit` is reached.
    const length = (own ?? parent.emit).length;
    // The named parameter keeps `wrapper.length` at EventEmitter#emit's arity; `arguments` forwards
    // exactly what the caller passed.
    const wrapper = function emit(this: unknown, event: string | symbol): boolean {
      // eslint-disable-next-line prefer-rest-params -- see above
      const args = arguments;
      const next = own ?? parent.emit;
      const request: unknown = args[1];
      const entry =
        enabled && event === 'request' && isObject(request) ? inflight.get(request) : undefined;
      if (entry === undefined) {
        return Reflect.apply(next, this, args) as boolean;
      }
      return runInTrace(entry.traceId, () => Reflect.apply(next, this, args) as boolean);
    };
    Object.defineProperty(wrapper, 'length', { value: length, configurable: true });
    Object.defineProperty(proto, 'emit', {
      value: wrapper,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch (error) {
    // A frozen prototype cannot be patched; requests on it are still timed, just not context-scoped.
    warn(error);
  }
}

function installEmits(): void {
  if (emitsInstalled) {
    return;
  }
  emitsInstalled = true;
  patchEmit(HttpServer.prototype);
  patchEmit(HttpsServer.prototype);
}

/** Start tracing inbound HTTP requests. Idempotent: a second call while enabled is a no-op. */
export function enable(options: HttpTracingOptions = {}): void {
  if (enabled) {
    return;
  }
  if (options.spanBufferSize !== undefined) {
    setSpanBufferSize(options.spanBufferSize);
  }
  installEmits();
  subscribe(START_CHANNEL, onStart);
  subscribe(FINISH_CHANNEL, onFinish);
  enabled = true;
}

/** Stop tracing and switch the trace context off. Buffered spans are kept for `drainSpans()`. */
export function disable(): void {
  if (!enabled) {
    return;
  }
  unsubscribe(START_CHANNEL, onStart);
  unsubscribe(FINISH_CHANNEL, onFinish);
  disableTraceContext();
  enabled = false;
}

/**
 * Keep at most `size` spans until the next drain. Spans already buffered move to the new buffer;
 * when it is smaller, the oldest are dropped and counted, like any other overflow.
 */
export function setSpanBufferSize(size: number): void {
  if (size === buffer.capacity) {
    return;
  }
  const next = createSpanBuffer(size);
  const previous = buffer.drain();
  for (const span of previous.spans) {
    next.push(span);
  }
  carriedDrops += previous.dropped;
  buffer = next;
}

/** Return buffered spans (oldest first) and the number dropped since the previous drain. */
export function drainSpans(): SpanDrain {
  const drained = buffer.drain();
  drained.dropped += carriedDrops;
  carriedDrops = 0;
  return drained;
}
