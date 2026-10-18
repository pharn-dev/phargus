import { CONFIG_FILE_VARIABLE, readConfigEnv } from './config-env.js';
import { readConfigFile, readPinnedConfigFile } from './config-file.js';
import { defaultAgentConfig } from './config-schema.js';
import type { AgentConfig } from './config-schema.js';

export type LoadAgentConfigOptions = {
  /**
   * Receives each non-fatal config problem (an unknown PHARGUS_* variable, which is ignored).
   * Defaults to one `[phargus] warning: ...` line on stderr per problem.
   */
  onWarning?: (message: string) => void;
};

function warnOnStderr(message: string): void {
  try {
    process.stderr.write(`[phargus] warning: ${message.replace(/\s+/g, ' ').trim()}\n`);
  } catch {
    // A warning must never throw into the caller; stderr is the only channel.
  }
}

/**
 * Resolve the agent config: defaults, then the config file, then PHARGUS_* env. The file is the one
 * `PHARGUS_CONFIG` names when that variable is set (the working directory is then not searched),
 * otherwise phargus.config.json/js in `cwd`.
 */
export async function loadAgentConfig(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  options: LoadAgentConfigOptions = {},
): Promise<AgentConfig> {
  const fromEnv = readConfigEnv(env, cwd, options.onWarning ?? warnOnStderr);
  const pinned = env[CONFIG_FILE_VARIABLE];
  const fromFile =
    pinned === undefined
      ? await readConfigFile(cwd)
      : await readPinnedConfigFile(cwd, CONFIG_FILE_VARIABLE, pinned);
  return Object.freeze({ ...defaultAgentConfig, ...fromFile, ...fromEnv });
}
