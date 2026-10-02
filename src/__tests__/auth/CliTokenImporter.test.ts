/**
 * CliTokenImporter contract against fake-pixiv (stdin-only import).
 */
import { mkdtempSync, chmodSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { CliTokenImporter } from '../../auth/PixivLoginService';

const FAKE = join(__dirname, '..', '..', '..', 'test', 'fakes', 'fake-pixiv.cjs');

const SENTINEL = ['SENTINEL', '_rt_', '7f3a9c'].join('');

function makeRunner(home: string) {
  const argvLog = join(home, 'argv.log');
  writeFileSync(argvLog, '');
  const run = (args: string[], stdin?: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        [FAKE, ...args],
        { env: { ...process.env, HOME: home, FAKE_PIXIV_ARGV_LOG: argvLog, FAKE_PIXIV_SCENARIO: 'ok' }, shell: false },
        (err, stdout, stderr) => {
          const code = (err as { code?: number } | null)?.code ?? 0;
          resolve({ code: err ? Number(code) || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
        }
      );
      if (stdin !== undefined && child.stdin) {
        child.stdin.write(stdin);
        child.stdin.end();
      }
    });
  return { run, argvLog };
}

describe('CliTokenImporter', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'artflow-cli-import-'));
    chmodSync(FAKE, 0o755);
  });

  it('imports token via stdin, not argv', async () => {
    const { run, argvLog } = makeRunner(home);
    const importer = new CliTokenImporter(run);
    await importer.importToken(SENTINEL);
    const lines = readFileSync(argvLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { argv: string[]; stdin?: string });
    const importLine = lines.find((l) => l.argv?.includes('import') && l.stdin !== undefined);
    expect(importLine).toBeTruthy();
    // token must be on stdin only
    expect(JSON.stringify(lines.filter((l) => l.argv?.includes('import')).map((l) => l.argv))).not.toContain(SENTINEL);
    expect(String(importLine!.stdin)).toContain(SENTINEL);
  });

  it('lists accounts from pixiv auth list', async () => {
    const { run } = makeRunner(home);
    const importer = new CliTokenImporter(run);
    const accounts = await importer.listAccounts();
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts[0]).toEqual({ userId: '1', name: 'Fake User', isDefault: true });
  });

  it('check returns authenticated', async () => {
    const { run } = makeRunner(home);
    const importer = new CliTokenImporter(run);
    const st = await importer.check();
    expect(st.authenticated).toBe(true);
  });
});
