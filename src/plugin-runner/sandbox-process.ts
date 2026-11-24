import { fork, type ChildProcess } from 'node:child_process';
import { RuleErrorCode, ruleFailure, type RuleFinding, type RuleRunResult } from './rule-result.js';

/** Host to child: run one rule source over the JSON-encoded windows. */
export type RunRequest = {
  type: 'run';
  id: number;
  source: string;
  windowsJson: string;
  timeoutMs: number;
  memoryLimitMb: number;
  isolatedVmModule: string;
  /** Most findings the rule may return; more is PHARGUS_RULE_INVALID_RESULT. */
  maxFindings: number;
  /** Most bytes of JSON the rule's result may serialize to; more is PHARGUS_RULE_INVALID_RESULT. */
  maxResultBytes: number;
};

/** Child to host: the outcome of the request with the same id. */
export type RunReply = { type: 'result'; id: number; result: RuleRunResult };

/** Child to host, once, after the child has loaded isolated-vm: a run sent now is timed from here. */
export type ReadyMessage = { type: 'ready' };

export type SandboxRequest = Omit<RunRequest, 'type' | 'id'>;

export type SandboxProcess = {
  request(req: SandboxRequest, watchdogMs: number): Promise<RuleRunResult>;
  kill(): Promise<void>;
};

export type SandboxProcessOptions = {
  /** Most findings a reply may carry; a larger reply is turned into PHARGUS_RULE_INVALID_RESULT. */
  maxFindings: number;
  /** Most characters of finding messages a reply may carry, same treatment. */
  maxResultBytes: number;
  /** The host flags the child's permissions are derived from. Default `process.execArgv`. */
  hostExecArgv?: readonly string[];
};

type Pending = {
  id: number;
  resolve: (result: RuleRunResult) => void;
  /** The start-up cap until the child is ready, then the run's watchdog. */
  timer: NodeJS.Timeout | undefined;
  message: RunRequest;
  watchdogMs: number;
};

const KILL_FALLBACK_MS = 1000;
/** Most time a fresh child may take to load isolated-vm and report ready. */
const STARTUP_LIMIT_MS = 10_000;
const ERROR_CODES: ReadonlySet<string> = new Set(Object.values(RuleErrorCode));

/**
 * The child's execArgv. `--no-node-snapshot` is required by isolated-vm. The host's Permission
 * Model flags (`--permission`, its pre-22.13 name `--experimental-permission`, and every
 * `--allow-*` grant) are forwarded so the sandbox is never less constrained than the host.
 */
export function sandboxExecArgv(hostExecArgv: readonly string[] = process.execArgv): string[] {
  const forwarded: string[] = [];
  for (let index = 0; index < hostExecArgv.length; index += 1) {
    const token = hostExecArgv[index] ?? '';
    const equals = token.indexOf('=');
    const name = equals < 0 ? token : token.slice(0, equals);
    const isPermissionFlag =
      name === '--permission' ||
      name === '--experimental-permission' ||
      name.startsWith('--allow-');
    if (!isPermissionFlag) continue;
    forwarded.push(token);
    const next = hostExecArgv[index + 1];
    // A grant given as `--allow-fs-read /dir` carries its value in the next token.
    if (equals < 0 && name.startsWith('--allow-') && next !== undefined && !next.startsWith('-')) {
      forwarded.push(next);
      index += 1;
    }
  }
  return ['--no-node-snapshot', ...forwarded];
}

type RawReply = { type: 'result'; id: number; result: unknown };

function isReady(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'ready'
  );
}

function isRawReply(value: unknown): value is RawReply {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return v['type'] === 'result' && typeof v['id'] === 'number' && Number.isSafeInteger(v['id']);
}

/** Re-validates the child's result: shape, error code, finding count and message volume. */
function checkResult(value: unknown, options: SandboxProcessOptions): RuleRunResult {
  const malformed = (why: string): RuleRunResult =>
    ruleFailure(RuleErrorCode.INVALID_RESULT, `the sandbox child sent an invalid result: ${why}`);
  if (typeof value !== 'object' || value === null) {
    return malformed('not an object');
  }
  const result = value as { ok?: unknown; findings?: unknown; error?: unknown };
  if (result.ok === false) {
    const error = result.error as { code?: unknown; message?: unknown } | null | undefined;
    if (
      typeof error !== 'object' ||
      error === null ||
      typeof error.code !== 'string' ||
      !ERROR_CODES.has(error.code) ||
      typeof error.message !== 'string'
    ) {
      return malformed('the failure has no known code and string message');
    }
    return value as RuleRunResult;
  }
  if (result.ok !== true || !Array.isArray(result.findings)) {
    return malformed('neither a failure nor a findings array');
  }
  if (result.findings.length > options.maxFindings) {
    return malformed(
      `${String(result.findings.length)} findings, over the limit of ${String(options.maxFindings)}`,
    );
  }
  const findings: RuleFinding[] = [];
  let characters = 0;
  for (const item of result.findings as unknown[]) {
    const finding = item as { windowStart?: unknown; message?: unknown } | null;
    if (
      typeof finding !== 'object' ||
      finding === null ||
      typeof finding.windowStart !== 'number' ||
      !Number.isSafeInteger(finding.windowStart) ||
      typeof finding.message !== 'string'
    ) {
      return malformed('a finding is not { windowStart: integer, message: string }');
    }
    characters += finding.message.length;
    if (characters > options.maxResultBytes) {
      return malformed(`finding messages exceed ${String(options.maxResultBytes)} characters`);
    }
    findings.push({ windowStart: finding.windowStart, message: finding.message });
  }
  return { ok: true, findings };
}

/** The host side of one lazily forked sandbox child; one request in flight at a time. */
export function createSandboxProcess(
  scriptPath: string,
  options: SandboxProcessOptions,
): SandboxProcess {
  const execArgv = sandboxExecArgv(options.hostExecArgv);
  let child: ChildProcess | undefined;
  /** Whether `child` has loaded isolated-vm; a run's watchdog is armed only once it has. */
  let ready = false;
  let pending: Pending | undefined;
  let nextId = 0;
  let closed = false;

  function settle(result: RuleRunResult): void {
    const current = pending;
    if (current === undefined) {
      return;
    }
    pending = undefined;
    clearTimeout(current.timer);
    child?.unref();
    child?.channel?.unref();
    current.resolve(result);
  }

  function start(isolatedVmModule: string): ChildProcess {
    ready = false;
    const proc = fork(scriptPath, [isolatedVmModule], {
      execArgv,
      // A minimal environment: no NODE_OPTIONS (a preloaded agent would start in the child)
      // and none of the host's secrets. Its stdout is ignored, so nothing reaches the host's.
      env: {
        PATH: process.env['PATH'],
        SystemRoot: process.env['SystemRoot'],
        PHARGUS_ENABLED: 'false',
      },
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    proc.on('message', (message: unknown) => {
      if (proc !== child) {
        return;
      }
      if (isReady(message)) {
        if (!ready) {
          ready = true;
          if (pending !== undefined) {
            dispatch(proc, pending);
          }
        }
        return;
      }
      if (!isRawReply(message) || pending === undefined || message.id !== pending.id) {
        process.emitWarning('phargus sandbox: ignored an unexpected reply from the sandbox child');
        return;
      }
      settle(checkResult(message.result, options));
    });
    proc.on('error', (error: Error) => {
      onChildGone(proc, `the sandbox child errored: ${error.message}`);
    });
    proc.on('exit', (code, signal) => {
      onChildGone(
        proc,
        `the sandbox child exited (code ${String(code)}, signal ${String(signal)})`,
      );
    });
    proc.unref();
    proc.channel?.unref();
    return proc;
  }

  function onChildGone(proc: ChildProcess, reason: string): void {
    if (proc !== child) {
      return;
    }
    child = undefined;
    if (pending !== undefined) {
      settle(ruleFailure(RuleErrorCode.SANDBOX_CRASHED, reason));
    } else if (!closed) {
      process.emitWarning(`phargus sandbox: ${reason} while idle`);
    }
  }

  /** Settles `current` with `result` and kills the child if nothing else settles it within `ms`. */
  function killAfter(
    proc: ChildProcess,
    current: Pending,
    ms: number,
    result: RuleRunResult,
  ): void {
    clearTimeout(current.timer);
    current.timer = setTimeout(() => {
      settle(result);
      child = undefined;
      proc.kill('SIGKILL');
    }, ms);
  }

  /** Sends the pending run to a ready child and arms its watchdog. */
  function dispatch(proc: ChildProcess, current: Pending): void {
    killAfter(
      proc,
      current,
      current.watchdogMs,
      ruleFailure(
        RuleErrorCode.TIMEOUT,
        `the sandbox did not answer within ${current.watchdogMs} ms and was killed`,
      ),
    );
    proc.send(current.message, (error: Error | null) => {
      if (error !== null) {
        onChildGone(proc, `could not send the request to the sandbox child: ${error.message}`);
        proc.kill('SIGKILL');
      }
    });
  }

  function request(req: SandboxRequest, watchdogMs: number): Promise<RuleRunResult> {
    if (closed) {
      return Promise.resolve(
        ruleFailure(RuleErrorCode.RUNNER_CLOSED, 'the plugin runner is closed'),
      );
    }
    return new Promise<RuleRunResult>((resolve) => {
      nextId += 1;
      const id = nextId;
      let proc: ChildProcess;
      try {
        child ??= start(req.isolatedVmModule);
        proc = child;
      } catch (error) {
        resolve(
          ruleFailure(
            RuleErrorCode.SANDBOX_CRASHED,
            `could not start the sandbox child: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      const current: Pending = {
        id,
        resolve,
        timer: undefined,
        message: { type: 'run', id, ...req },
        watchdogMs,
      };
      pending = current;
      proc.ref();
      proc.channel?.ref();
      if (ready) {
        dispatch(proc, current);
      } else {
        killAfter(
          proc,
          current,
          STARTUP_LIMIT_MS,
          ruleFailure(
            RuleErrorCode.SANDBOX_CRASHED,
            `the sandbox child did not start within ${STARTUP_LIMIT_MS} ms and was killed`,
          ),
        );
      }
    });
  }

  function kill(): Promise<void> {
    closed = true;
    settle(ruleFailure(RuleErrorCode.RUNNER_CLOSED, 'the plugin runner was closed during the run'));
    const proc = child;
    child = undefined;
    if (proc === undefined || proc.exitCode !== null || proc.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const fallback = setTimeout(() => {
        proc.kill('SIGKILL');
      }, KILL_FALLBACK_MS);
      proc.once('exit', () => {
        clearTimeout(fallback);
        resolve();
      });
      proc.ref();
      if (proc.connected) {
        proc.disconnect();
      }
    });
  }

  return { request, kill };
}
