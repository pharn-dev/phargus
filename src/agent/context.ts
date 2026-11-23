// The single importer of `node:async_hooks` in the agent (ARCHITECTURE.md).
import { AsyncLocalStorage } from 'node:async_hooks';
import { newTraceId } from './trace-id.js';

type TraceStore = { readonly traceId: string };

const storage = new AsyncLocalStorage<TraceStore>();

// Node 24's `disable()` clears the store only in the current context, so a context created
// earlier (a request in flight) would still see its trace; this flag hides it everywhere.
let active = true;

function run<T>(store: TraceStore, fn: () => T): T {
  active = true;
  return storage.run(store, fn);
}

/** The trace id of the current async context, or undefined outside any trace. */
export function currentTraceId(): string | undefined {
  return active ? storage.getStore()?.traceId : undefined;
}

/** Run `fn` inside a fresh trace context; async continuations of `fn` keep the same id. */
export function runWithTrace<T>(fn: () => T): T {
  return run({ traceId: newTraceId() }, fn);
}

/**
 * Internal: switch the trace context off (HTTP tracer's `disable()` only). `currentTraceId()` is
 * undefined everywhere, and on Node 22 the storage's async hooks are removed. The next run re-enables
 * it, as `AsyncLocalStorage.run()` does.
 */
export function disableTraceContext(): void {
  active = false;
  storage.disable();
}

/**
 * Internal: run `fn` inside the trace `traceId` (HTTP tracer only). Scoped with `run`, never
 * `enterWith`: an entered context leaks into async resources that outlive the request (a
 * keep-alive socket's parser on Node 22), so a later request would inherit a stale trace.
 */
export function runInTrace<T>(traceId: string, fn: () => T): T {
  return run({ traceId }, fn);
}
