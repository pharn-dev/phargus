import path from 'node:path';
import process from 'node:process';

/**
 * Thrown when the Node permission model (`--permission`) denies a file system
 * access the agent needs. Names the denied scope, the absolute resource and the
 * flag that would grant it.
 */
export class PhargusPermissionError extends Error {
  readonly scope: string;
  readonly resource: string;
  readonly code = 'PHARGUS_ERR_PERMISSION_DENIED';

  constructor(scope: string, resource: string, options?: ErrorOptions) {
    const flag = scope === 'fs.read' ? '--allow-fs-read' : '--allow-fs-write';
    super(
      `phargus: permission denied for ${scope} on ${resource}; grant it with ${flag}=<${resource} or its directory>`,
      options,
    );
    this.name = 'PhargusPermissionError';
    this.scope = scope;
    this.resource = resource;
  }
}

export type PermissionScope = 'fs.read' | 'fs.write';
export type PermissionCheck = { allowed: boolean; scope: string; resource: string };

/** `process.permission` exists only under `--permission`; `@types/node` declares it unconditionally. */
type PermissionProcess = {
  permission?: { has(scope: string, reference?: string): boolean } | null;
};

/** Read at call time, never cached, so a test can stub it and the flag state is always current. */
function currentPermission(): NonNullable<PermissionProcess['permission']> | undefined {
  const permission = (process as unknown as PermissionProcess).permission;
  return typeof permission === 'object' && permission !== null ? permission : undefined;
}

/** True when the process runs under the Node permission model (`--permission`). */
export function isPermissionModelEnabled(): boolean {
  return currentPermission() !== undefined;
}

/**
 * Ask the permission model whether `scope` is granted on `reference`. The path is
 * resolved to absolute first because `has()` does not match relative paths. When the
 * model is inactive the check is always allowed.
 */
export function checkPermission(scope: PermissionScope, reference: string): PermissionCheck {
  const resource = path.resolve(reference);
  const permission = currentPermission();
  if (permission === undefined) {
    return { allowed: true, scope, resource };
  }
  return { allowed: permission.has(scope, resource), scope, resource };
}

/** Throw `PhargusPermissionError` when the permission model denies `scope` on `reference`. */
export function assertPermission(scope: PermissionScope, reference: string): void {
  const check = checkPermission(scope, reference);
  if (!check.allowed) {
    throw new PhargusPermissionError(check.scope, check.resource);
  }
}
