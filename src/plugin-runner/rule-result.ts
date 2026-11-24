/** Stable error codes for a rule run that did not produce findings. */
export const RuleErrorCode = Object.freeze({
  RULE_THREW: 'PHARGUS_RULE_THREW',
  TIMEOUT: 'PHARGUS_RULE_TIMEOUT',
  MEMORY_LIMIT: 'PHARGUS_RULE_MEMORY_LIMIT',
  COMPILE_ERROR: 'PHARGUS_RULE_COMPILE_ERROR',
  ISOLATED_VM_MISSING: 'PHARGUS_ISOLATED_VM_MISSING',
  INVALID_RESULT: 'PHARGUS_RULE_INVALID_RESULT',
  SANDBOX_CRASHED: 'PHARGUS_SANDBOX_CRASHED',
  RUNNER_CLOSED: 'PHARGUS_RUNNER_CLOSED',
  INVALID_PARAMETER: 'PHARGUS_RULE_INVALID_PARAMETER',
  RULES_DIR_UNREADABLE: 'PHARGUS_RULES_DIR_UNREADABLE',
  RULE_FILE_UNREADABLE: 'PHARGUS_RULE_FILE_UNREADABLE',
  DUPLICATE_RULE_ID: 'PHARGUS_RULE_DUPLICATE_ID',
} as const);

export type RuleErrorCodeValue = (typeof RuleErrorCode)[keyof typeof RuleErrorCode];

/** A rule ready to hand to a plugin runner: a stable id and the rule's source text. */
export type RuleDescriptor = { readonly id: string; readonly source: string };

/** One finding a rule reported; it identifies its window by that window's `start`. */
export type RuleFinding = { windowStart: number; message: string };

/** Plain JSON data describing the outcome of one rule run. */
export type RuleRunResult =
  | { ok: true; findings: RuleFinding[] }
  | { ok: false; error: { code: RuleErrorCodeValue; message: string } };

export function ruleFailure(code: RuleErrorCodeValue, message: string): RuleRunResult {
  return { ok: false, error: { code, message } };
}
