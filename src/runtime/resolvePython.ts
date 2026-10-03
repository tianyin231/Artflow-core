/**
 * Resolve a usable Python executable.
 * Order: ARTFLOW_PYTHON → config.runtime.python → ../.venv/bin/python → python3 → python
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ResolvePythonOptions {
  /** Explicit config value (config.runtime.python) */
  configured?: string | null;
  /** Project root used to locate ../.venv (defaults to cwd's parent of src) */
  projectRoot?: string;
  /** Optional predicate to check whether a binary works (for tests) */
  probe?: (bin: string) => boolean;
}

function defaultProbe(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve Python binary path/name. Throws if nothing works.
 */
export function resolvePython(options: ResolvePythonOptions = {}): string {
  const probe = options.probe ?? defaultProbe;
  const projectRoot = options.projectRoot ?? resolve(__dirname, '..', '..');

  const candidates: string[] = [];
  const fromEnv = process.env.ARTFLOW_PYTHON;
  if (fromEnv) candidates.push(fromEnv);
  if (options.configured) candidates.push(options.configured);
  const venvPython = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  candidates.push(join(projectRoot, '..', '.venv', ...venvPython));
  candidates.push(join(projectRoot, '.venv', ...venvPython));
  candidates.push('python3');
  candidates.push('python');

  for (const bin of candidates) {
    if (!bin) continue;
    // Absolute/relative paths must exist when using the default filesystem probe.
    // Custom probes (tests) decide for themselves.
    if (probe === defaultProbe && (bin.includes('/') || bin.includes('\\'))) {
      if (!existsSync(bin)) continue;
    }
    if (probe(bin)) return bin;
  }

  throw new Error(
    'Unable to resolve a Python executable. Set ARTFLOW_PYTHON or config.runtime.python.'
  );
}
