import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createServer, get, OutgoingMessage, Server as HttpServer } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { Duplex, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Regression tests for F-01, F-13 and F-22 (production-readiness audit) and CORE-365: Phargus
// installs each prototype wrapper once and never removes it; a disabled wrapper is inert, never
// throws, and a wrapper a third party installs on top of it keeps working.

type Sample = { events: number; hotspots: { site: string }[] };
type Probe = { enable(): void; disable(): void; sample(): Sample };
type ProbeModule = {
  createBackpressureProbe(options?: { maxHotspots?: number }): Probe;
  excludeFromBackpressure(stream: object): void;
};
type TracingModule = {
  enable(options?: { spanBufferSize?: number }): void;
  disable(): void;
  currentTraceId(): string | undefined;
};
type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

const writeTargets = [Writable.prototype, Duplex.prototype, OutgoingMessage.prototype];
const pristineWrite = writeTargets.map((target) =>
  Object.getOwnPropertyDescriptor(target, 'write'),
);
const emitTargets = [HttpServer.prototype, HttpsServer.prototype];
const pristineEmit = emitTargets.map((target) => Object.getOwnPropertyDescriptor(target, 'emit'));
const pristineEventEmitterEmit = Object.getOwnPropertyDescriptor(EventEmitter.prototype, 'emit');
const cleanups: (() => void)[] = [];

function restoreDescriptor(target: object, key: string, own: PropertyDescriptor | undefined): void {
  if (own === undefined) {
    delete (target as Record<string, unknown>)[key];
  } else {
    Object.defineProperty(target, key, own);
  }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
  writeTargets.forEach((target, i) => restoreDescriptor(target, 'write', pristineWrite[i]));
  emitTargets.forEach((target, i) => restoreDescriptor(target, 'emit', pristineEmit[i]));
  restoreDescriptor(EventEmitter.prototype, 'emit', pristineEventEmitterEmit);
});

/** A fresh, independent evaluation of the probe module: a second "copy" of Phargus. */
async function loadProbeCopy(): Promise<ProbeModule> {
  vi.resetModules();
  return (await import('./backpressure-probe.js')) as unknown as ProbeModule;
}

async function loadTracingCopy(): Promise<TracingModule> {
  vi.resetModules();
  const tracing = (await import('./http-tracing.js')) as unknown as Omit<
    TracingModule,
    'currentTraceId'
  >;
  const context = (await import('./context.js')) as unknown as Pick<
    TracingModule,
    'currentTraceId'
  >;
  return { ...tracing, currentTraceId: context.currentTraceId };
}

function track<T extends { disable(): void }>(subject: T): T {
  cleanups.push(() => subject.disable());
  return subject;
}

/** Install a third-party wrapper on `target.write` that counts calls and delegates. */
function installForeignWrite(target: object): { calls: () => number; beneath: AnyFn } {
  const holder = target as { write: AnyFn };
  const beneath = holder.write;
  let calls = 0;
  holder.write = function foreignWrite(this: unknown, ...args: unknown[]): unknown {
    calls += 1;
    return Reflect.apply(beneath, this, args);
  };
  return { calls: () => calls, beneath };
}

function sink(Ctor: typeof Writable | typeof Duplex): { stream: Writable; received: string[] } {
  const received: string[] = [];
  const stream = new Ctor({
    write(chunk: Buffer, _encoding, callback) {
      received.push(chunk.toString());
      callback();
    },
    read() {},
  });
  return { stream, received };
}

/** A Writable with a 1-byte highWaterMark that acknowledges each chunk after a short delay. */
function slowWritable(): Writable {
  return new Writable({
    highWaterMark: 1,
    write(_chunk: Buffer, _encoding, callback) {
      setTimeout(() => callback(), 2);
    },
  });
}

async function stallOnce(stream: Writable): Promise<void> {
  let guard = 0;
  while (stream.write('x')) {
    guard += 1;
    if (guard > 1000) throw new Error('write() never returned false');
  }
  await once(stream, 'drain');
}

describe('prototype patch safety — backpressure probe write wrappers (F-01)', () => {
  it.each([
    ['Writable', Writable],
    ['Duplex', Duplex],
  ] as const)(
    'a foreign %s.prototype.write wrapper installed after enable() keeps working after disable()',
    async (_name, Ctor) => {
      const { createBackpressureProbe } = await loadProbeCopy();
      const probe = track(createBackpressureProbe());
      probe.enable();
      const foreign = installForeignWrite(Ctor.prototype);
      probe.disable();

      const { stream, received } = sink(Ctor);
      expect(() => stream.write('hello')).not.toThrow();
      expect(received).toEqual(['hello']);
      expect(foreign.calls()).toBe(1);
      expect((Ctor.prototype.write as AnyFn).name).toBe('foreignWrite');

      // Enabling again with the foreign wrapper still on top counts a stall exactly once.
      probe.enable();
      await stallOnce(slowWritable());
      expect(probe.sample().events).toBe(1);
      probe.disable();
      expect(() => sink(Ctor).stream.write('again')).not.toThrow();
    },
  );

  it('an inert Phargus wrapper that a third party restored on top is reused, not wrapped again, by the next enable()', async () => {
    const original = Writable.prototype.write;
    const { createBackpressureProbe } = await loadProbeCopy();
    const probe = track(createBackpressureProbe());
    probe.enable();
    const foreign = installForeignWrite(Writable.prototype);
    probe.disable();
    // The third party uninstalls itself by restoring what it saw: Phargus's now-inert wrapper.
    (Writable.prototype as { write: AnyFn }).write = foreign.beneath;

    const { stream, received } = sink(Writable);
    expect(() => stream.write('a')).not.toThrow();
    expect(received).toEqual(['a']);

    probe.enable();
    await stallOnce(slowWritable());
    expect(probe.sample().events).toBe(1);
    probe.disable();
    expect(Writable.prototype.write).toBe(foreign.beneath);
    expect(Writable.prototype.write).not.toBe(original);
  });

  it.each([['first-enabled disabled first'], ['first-enabled disabled last']])(
    'two module copies enabled together, %s: writes keep working and the wrappers stay installed',
    async (order) => {
      const copyA = await loadProbeCopy();
      const copyB = await loadProbeCopy();
      expect(copyA.createBackpressureProbe).not.toBe(copyB.createBackpressureProbe);
      const probeA = track(copyA.createBackpressureProbe());
      const probeB = track(copyB.createBackpressureProbe());

      probeA.enable();
      probeB.enable();
      // The second copy wraps the first copy's wrappers again: each copy has its own guard.
      const wrapped = writeTargets.map((target) =>
        Object.getOwnPropertyDescriptor(target, 'write'),
      );

      // Each copy's probe sees the stall exactly once.
      await stallOnce(slowWritable());
      expect(probeA.sample().events).toBe(1);
      expect(probeB.sample().events).toBe(1);

      const [first, second] = order.endsWith('first') ? [probeA, probeB] : [probeB, probeA];
      first.disable();
      expect(() => sink(Writable).stream.write('mid')).not.toThrow();
      await stallOnce(slowWritable());
      expect(first.sample().events).toBe(0);
      expect(second.sample().events).toBe(1);
      second.disable();

      for (const Ctor of [Writable, Duplex]) {
        const { stream, received } = sink(Ctor);
        expect(() => stream.write('after')).not.toThrow();
        expect(received).toEqual(['after']);
      }
      writeTargets.forEach((target, i) => {
        expect(Object.getOwnPropertyDescriptor(target, 'write')).toEqual(wrapped[i]);
      });
    },
  );

  it('enabling, disabling and enabling again leaves one wrapper on each prototype', async () => {
    const { createBackpressureProbe } = await loadProbeCopy();
    const probe = track(createBackpressureProbe());
    probe.enable();
    const wrapped = writeTargets.map((target) => (target as { write: unknown }).write);
    wrapped.forEach((write, i) => {
      expect(write, `target ${i}`).not.toBe(pristineWrite[i]?.value);
    });
    probe.disable();
    probe.enable();
    const second = track(createBackpressureProbe());
    second.enable();
    writeTargets.forEach((target, i) => {
      expect((target as { write: unknown }).write, `target ${i}`).toBe(wrapped[i]);
    });

    // One wrapper, so each enabled probe sees the stall exactly once.
    await stallOnce(slowWritable());
    expect(probe.sample().events).toBe(1);
    expect(second.sample().events).toBe(1);
  });

  it.each([
    ['Writable', Writable.prototype],
    ['Duplex', Duplex.prototype],
    ['OutgoingMessage', OutgoingMessage.prototype],
  ] as const)(
    'after disable() the %s.prototype.write wrapper stays installed and is inert: same this, arguments, return value and length',
    async (_name, target) => {
      const holder = target as unknown as { write: AnyFn };
      const calls: { self: unknown; args: unknown[] }[] = [];
      const returned: unknown[] = [{ sentinel: true }, false];
      const beneath = function write(this: unknown, ...args: unknown[]): unknown {
        calls.push({ self: this, args });
        return returned[calls.length - 1];
      };
      Object.defineProperty(beneath, 'length', { value: 3 });
      holder.write = beneath;

      const { createBackpressureProbe } = await loadProbeCopy();
      const probe = track(createBackpressureProbe());
      probe.enable();
      probe.disable();

      expect(holder.write).not.toBe(beneath);
      expect(holder.write.length).toBe(3);
      const self = sink(Writable).stream;
      const callback = (): void => {};
      expect(holder.write.call(self, 'a', 'utf8', callback)).toBe(returned[0]);
      expect(holder.write.call(self, 'b')).toBe(false);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.self).toBe(self);
      expect(calls[0]?.args).toEqual(['a', 'utf8', callback]);
      expect(calls[0]?.args[2]).toBe(callback);
      expect(calls[1]?.self).toBe(self);
      expect(calls[1]?.args).toEqual(['b']);
    },
  );

  it('an observer that throws (a stream whose once() throws) never reaches the caller of write()', async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);
    cleanups.push(() => process.off('warning', onWarning));

    const { createBackpressureProbe } = await loadProbeCopy();
    const probe = track(createBackpressureProbe());
    probe.enable();
    class HostileWritable extends Writable {
      override once(): this {
        throw new Error('hostile once');
      }
    }
    const stream = new HostileWritable({
      highWaterMark: 1,
      write(_chunk: Buffer, _encoding, callback) {
        setTimeout(() => callback(), 2);
      },
    });
    let result: boolean | undefined;
    expect(() => {
      result = stream.write('xx');
    }).not.toThrow();
    expect(result).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(warnings.some((w) => w.name === 'PhargusBackpressureWarning')).toBe(true);
    probe.disable();
  });
});

describe('prototype patch safety — write wrapper arity and arguments (F-22)', () => {
  it('each patched write keeps the original length and receives exactly the arguments passed', async () => {
    const lengths = writeTargets.map((target) => (target as { write: AnyFn }).write.length);
    expect(lengths).toEqual([3, 3, 3]);

    // A spy beneath Phargus's wrapper records how many arguments reach the original.
    const counts: number[] = [];
    const holder = Writable.prototype as unknown as { write: AnyFn };
    const beneath = holder.write;
    const spy = function spy(this: unknown, ...args: unknown[]): unknown {
      counts.push(args.length);
      return Reflect.apply(beneath, this, args);
    };
    Object.defineProperty(spy, 'length', { value: beneath.length });
    holder.write = spy;

    const { createBackpressureProbe } = await loadProbeCopy();
    const probe = track(createBackpressureProbe());
    probe.enable();
    writeTargets.forEach((target, i) => {
      expect((target as { write: AnyFn }).write.length, `target ${i}`).toBe(lengths[i]);
    });

    const { stream, received } = sink(Writable);
    let called = false;
    stream.write('a');
    stream.write('b', 'utf8');
    stream.write('c', 'utf8', () => {
      called = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(counts).toEqual([1, 2, 3]);
    expect(received).toEqual(['a', 'b', 'c']);
    expect(called).toBe(true);
    probe.disable();
  });
});

describe('prototype patch safety — http tracing emit wrapper (F-13)', () => {
  it('a foreign Server.prototype.emit wrapper installed after enable() survives disable()', async () => {
    const tracing = track(await loadTracingCopy());
    tracing.enable();
    const beneath = HttpServer.prototype.emit as AnyFn;
    let calls = 0;
    Object.defineProperty(HttpServer.prototype, 'emit', {
      value: function foreignEmit(this: unknown, ...args: unknown[]): unknown {
        calls += 1;
        return Reflect.apply(beneath, this, args);
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
    tracing.disable();

    expect((HttpServer.prototype.emit as AnyFn).name).toBe('foreignEmit');
    const server = new HttpServer();
    let heard = 0;
    server.on('custom', () => {
      heard += 1;
    });
    expect(() => server.emit('custom')).not.toThrow();
    expect(calls).toBe(1);
    expect(heard).toBe(1);
  });

  it('enable() then disable() leaves the emit wrapper installed on the server prototypes', async () => {
    const tracing = track(await loadTracingCopy());
    tracing.enable();
    expect(Object.hasOwn(HttpServer.prototype, 'emit')).toBe(true);
    expect((HttpServer.prototype.emit as AnyFn).length).toBe(1);
    const wrapped = emitTargets.map((target) => Object.getOwnPropertyDescriptor(target, 'emit'));
    tracing.disable();
    emitTargets.forEach((target, i) => {
      expect(Object.getOwnPropertyDescriptor(target, 'emit')).toEqual(wrapped[i]);
    });
  });

  it.each([['first-enabled disabled first'], ['first-enabled disabled last']])(
    'two module copies both trace a request, and %s leaves the emit wrapper installed',
    async (order) => {
      const copyA = track(await loadTracingCopy());
      const copyB = track(await loadTracingCopy());
      copyA.enable();
      copyB.enable();
      // The second copy wraps the first copy's wrapper again: each copy has its own guard.
      const wrapped = emitTargets.map((target) => Object.getOwnPropertyDescriptor(target, 'emit'));

      const seen: (string | undefined)[] = [];
      const server = createServer((_req, res) => {
        seen.push(copyA.currentTraceId(), copyB.currentTraceId());
        res.end('ok');
      });
      cleanups.push(() => server.close());
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        get(
          {
            host: '127.0.0.1',
            port,
            path: '/',
            agent: false,
            headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
          },
          resolve,
        ).on('error', reject);
      });
      response.resume();
      await once(response, 'end');
      expect(seen).toEqual([traceId, traceId]);

      const [first, second] = order.endsWith('first') ? [copyA, copyB] : [copyB, copyA];
      first.disable();
      expect(HttpServer.prototype.emit).toBe(wrapped[0]?.value);
      second.disable();
      emitTargets.forEach((target, i) => {
        expect(Object.getOwnPropertyDescriptor(target, 'emit')).toEqual(wrapped[i]);
      });
    },
  );

  it('enabling, disabling and enabling again leaves one emit wrapper on each server prototype', async () => {
    const tracing = track(await loadTracingCopy());
    tracing.enable();
    const wrapped = emitTargets.map(
      (target) => Object.getOwnPropertyDescriptor(target, 'emit')?.value as unknown,
    );
    wrapped.forEach((emit, i) => {
      expect(typeof emit, `target ${i}`).toBe('function');
    });
    tracing.disable();
    tracing.enable();
    emitTargets.forEach((target, i) => {
      expect(Object.getOwnPropertyDescriptor(target, 'emit')?.value, `target ${i}`).toBe(
        wrapped[i],
      );
    });
  });

  it.each([
    ['http', HttpServer.prototype],
    ['https', HttpsServer.prototype],
  ] as const)(
    'after disable() the %s Server.prototype.emit wrapper stays installed and is inert: same this, arguments, return value and length',
    async (_name, proto) => {
      const calls: { self: unknown; args: unknown[] }[] = [];
      const sentinel = { sentinel: true };
      const beneath = function emit(this: unknown, ...args: unknown[]): unknown {
        calls.push({ self: this, args });
        return sentinel;
      };
      Object.defineProperty(beneath, 'length', { value: 1 });
      Object.defineProperty(proto, 'emit', {
        value: beneath,
        writable: true,
        configurable: true,
        enumerable: false,
      });

      const tracing = track(await loadTracingCopy());
      tracing.enable();
      tracing.disable();

      const emit = (proto as unknown as { emit: AnyFn }).emit;
      expect(emit).not.toBe(beneath);
      expect(emit.length).toBe(1);
      const self = new EventEmitter();
      const request = {};
      const response = {};
      expect(emit.call(self, 'request', request, response)).toBe(sentinel);
      expect(emit.call(self, 'custom')).toBe(sentinel);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.self).toBe(self);
      expect(calls[0]?.args[0]).toBe('request');
      expect(calls[0]?.args[1]).toBe(request);
      expect(calls[0]?.args[2]).toBe(response);
      expect(calls[0]?.args).toHaveLength(3);
      expect(calls[1]?.self).toBe(self);
      expect(calls[1]?.args).toEqual(['custom']);
    },
  );

  it('a function assigned to EventEmitter.prototype.emit after enable() sees every server emit', async () => {
    const tracing = track(await loadTracingCopy());
    tracing.enable();
    const beneath = EventEmitter.prototype.emit as AnyFn;
    const seenEvents: unknown[] = [];
    EventEmitter.prototype.emit = function laterEmit(this: unknown, ...args: unknown[]): boolean {
      if (this instanceof HttpServer || this instanceof HttpsServer) {
        seenEvents.push(args[0]);
      }
      return Reflect.apply(beneath, this, args) as boolean;
    };

    for (const server of [new HttpServer(), new HttpsServer()]) {
      seenEvents.length = 0;
      server.emit('custom');
      server.emit('request', {}, {});
      expect(seenEvents).toEqual(['custom', 'request']);
    }

    seenEvents.length = 0;
    const seenTraceIds: (string | undefined)[] = [];
    const server = createServer((_req, res) => {
      seenTraceIds.push(tracing.currentTraceId());
      res.end('ok');
    });
    cleanups.push(() => server.close());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      get(
        {
          host: '127.0.0.1',
          port,
          path: '/',
          agent: false,
          headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
        },
        resolve,
      ).on('error', reject);
    });
    response.resume();
    await once(response, 'end');
    expect(seenEvents).toContain('request');
    expect(seenTraceIds).toEqual([traceId]);
  });

  it('node:domain loaded after enable() still catches an error emitted on a domain-bound server', () => {
    // node:domain cannot be unloaded, so this runs in a child process. A resolve hook lets plain
    // `node` load the agent's TypeScript sources (`./x.js` -> `./x.ts`).
    const hooks = `
      import { registerHooks } from 'node:module';
      registerHooks({
        resolve(specifier, context, next) {
          try {
            return next(specifier, context);
          } catch (error) {
            if (specifier.startsWith('.') && specifier.endsWith('.js')) {
              return next(specifier.slice(0, -3) + '.ts', context);
            }
            throw error;
          }
        },
      });
    `;
    const tracingUrl = new URL('./http-tracing.ts', import.meta.url).href;
    const script = `
      const tracing = await import(${JSON.stringify(tracingUrl)});
      tracing.enable();
      const domain = await import('node:domain');
      const { Server } = await import('node:http');
      const d = domain.create();
      let caught;
      d.on('error', (error) => { caught = error.message; });
      const server = new Server();
      d.add(server);
      let thrown;
      try {
        server.emit('error', new Error('boom'));
      } catch (error) {
        thrown = error.message;
      }
      tracing.disable();
      console.log(JSON.stringify({ caught, thrown }));
    `;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        `data:text/javascript,${encodeURIComponent(hooks)}`,
        '--input-type=module',
        '--eval',
        script,
      ],
      { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', timeout: 30_000 },
    );
    expect(child.status, child.stderr).toBe(0);
    const lines = child.stdout.trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1] ?? '')).toEqual({ caught: 'boom' });
  });
});

describe('prototype patch safety — no globalThis registry (CORE-365)', () => {
  it('enabling the probe and tracing and excluding a stream puts no phargus symbol on globalThis', async () => {
    const { createBackpressureProbe, excludeFromBackpressure } = await loadProbeCopy();
    const probe = track(createBackpressureProbe());
    probe.enable();
    excludeFromBackpressure(sink(Writable).stream);
    const tracing = track(await loadTracingCopy());
    tracing.enable();
    // Only the start-once flag of auto-start.ts may live there, and nothing here starts the agent.
    const keys = Object.getOwnPropertySymbols(globalThis)
      .map((symbol) => Symbol.keyFor(symbol))
      .filter((key) => key !== undefined && key.startsWith('phargus.') && key !== 'phargus.agent');
    expect(keys).toEqual([]);
  });
});
