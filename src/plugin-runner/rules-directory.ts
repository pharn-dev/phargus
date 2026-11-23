import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuleDescriptor } from './rule-descriptor.js';
import { RuleErrorCode } from './rule-result.js';

export type RuleLoadFailure = {
  id: string;
  error: { code: typeof RuleErrorCode.RULE_FILE_UNREADABLE; message: string };
};

export type RulesDirectoryResult =
  | { ok: true; rules: RuleDescriptor[]; failures: RuleLoadFailure[] }
  | { ok: false; error: { code: typeof RuleErrorCode.RULES_DIR_UNREADABLE; message: string } };

const RULE_EXTENSION = '.js';
/** A rule file larger than this is reported, not read: it would sit in the host's heap and cross IPC on every run. */
const MAX_RULE_FILE_BYTES = 1024 * 1024;

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Reads every `.js` file directly inside `dir` as rule text. The host never imports, requires or
 * evaluates the text; only the sandbox runs it. A file over 1 MiB is a RULE_FILE_UNREADABLE failure
 * and is not read. Never rejects.
 */
export async function loadRulesDirectory(dir: string): Promise<RulesDirectoryResult> {
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(RULE_EXTENSION))
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: RuleErrorCode.RULES_DIR_UNREADABLE,
        message: `cannot list rules directory "${dir}": ${describeCause(cause)}`,
      },
    };
  }

  const rules: RuleDescriptor[] = [];
  const failures: RuleLoadFailure[] = [];
  for (const name of names) {
    const id = name.slice(0, -RULE_EXTENSION.length);
    const path = join(dir, name);
    try {
      const { size } = await stat(path);
      if (size > MAX_RULE_FILE_BYTES) {
        failures.push({
          id,
          error: {
            code: RuleErrorCode.RULE_FILE_UNREADABLE,
            message: `rule file "${path}" is ${String(size)} bytes, over the limit of ${String(MAX_RULE_FILE_BYTES)} (1 MiB)`,
          },
        });
        continue;
      }
      rules.push({ id, source: await readFile(path, 'utf8') });
    } catch (cause) {
      failures.push({
        id,
        error: {
          code: RuleErrorCode.RULE_FILE_UNREADABLE,
          message: `cannot read rule file "${path}": ${describeCause(cause)}`,
        },
      });
    }
  }
  return { ok: true, rules, failures };
}
