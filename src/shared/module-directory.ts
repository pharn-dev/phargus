import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The directory of the module whose function called this one, or undefined when it cannot be read.
 * It reads the caller's structured call site, so it works in the ESM and CJS builds and under type
 * stripping, for any install path: `import.meta` cannot appear in the CJS output, and `__dirname`
 * would name this file's directory, not the caller's.
 */
export function callerDirectory(): string | undefined {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- saved only to be restored in finally
  const previousPrepare = Error.prepareStackTrace;
  const previousLimit = Error.stackTraceLimit;
  let fileName: string | null | undefined;
  try {
    Error.stackTraceLimit = 10;
    Error.prepareStackTrace = (_, sites) => sites;
    const sites = new Error().stack as unknown as NodeJS.CallSite[] | undefined;
    // sites[0] is this function; sites[1] is the function that called it.
    fileName = sites?.[1]?.getFileName();
  } finally {
    Error.prepareStackTrace = previousPrepare;
    Error.stackTraceLimit = previousLimit;
  }
  if (typeof fileName !== 'string' || fileName === '') return undefined;
  return dirname(fileName.startsWith('file:') ? fileURLToPath(fileName) : fileName);
}
