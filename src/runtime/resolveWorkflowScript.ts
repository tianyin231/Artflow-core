import { resolve } from 'node:path';

/** Runtime scripts live in the package even when the CLI runs in a user's directory. */
export function resolveWorkflowScript(name: 'workflow-render-cover.py' | 'workflow-render-video.py'): string {
  return resolve(__dirname, '..', '..', 'scripts', name);
}
