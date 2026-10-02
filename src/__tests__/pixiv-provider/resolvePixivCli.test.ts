import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PIXIV_CLI,
  isPixivCliAvailable,
  resolvePixivCliHome,
  resolvePixivCliPath,
} from '../../pixiv-provider/resolvePixivCli';

describe('resolvePixivCli', () => {
  it('prefers explicit, then PIXIV_CLI_PATH, then ARTFLOW_PIXIV_CLI, then `pixiv`', () => {
    expect(resolvePixivCliPath('/x/pixiv', { PIXIV_CLI_PATH: '/y', ARTFLOW_PIXIV_CLI: '/z' })).toBe('/x/pixiv');
    expect(resolvePixivCliPath(undefined, { PIXIV_CLI_PATH: '/y', ARTFLOW_PIXIV_CLI: '/z' })).toBe('/y');
    expect(resolvePixivCliPath(undefined, { ARTFLOW_PIXIV_CLI: '/z' })).toBe('/z');
    expect(resolvePixivCliPath(undefined, {})).toBe(DEFAULT_PIXIV_CLI);
  });

  it('resolves cli HOME override', () => {
    expect(resolvePixivCliHome({ PIXIV_CLI_HOME: '/h', ARTFLOW_PIXIV_CLI_HOME: '/a' })).toBe('/h');
    expect(resolvePixivCliHome({ ARTFLOW_PIXIV_CLI_HOME: '/a' })).toBe('/a');
    expect(resolvePixivCliHome({})).toBeNull();
  });

  it('detects bare commands on PATH and explicit paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artflow-pixivcli-'));
    const bin = join(dir, process.platform === 'win32' ? 'pixiv.EXE' : 'pixiv');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    expect(isPixivCliAvailable('pixiv', { PATH: dir })).toBe(true);
    expect(isPixivCliAvailable('pixiv', { PATH: '/nonexistent-dir' })).toBe(false);
    expect(isPixivCliAvailable(bin, {})).toBe(true);
    expect(isPixivCliAvailable(join(dir, 'missing'), {})).toBe(false);
  });
});
