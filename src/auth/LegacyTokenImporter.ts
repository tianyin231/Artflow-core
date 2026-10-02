import { getConfigPath, loadConfig } from '../config';
import { TerminalLogin } from '../terminal-login';
import { clearConfigToken, updateConfigWithToken } from '../utils/login-helper';
import { isPlaceholderToken } from '../utils/token-manager';
import { TokenImporter } from './PixivLoginService';

export class LegacyTokenImporter implements TokenImporter {
  async importToken(token: string): Promise<void> {
    const config = loadConfig(getConfigPath(), true);
    const proxy = config.network?.proxy;
    const result = await TerminalLogin.refresh(token, proxy ? { ...proxy, protocol: proxy.protocol ?? 'http' } : undefined);
    await updateConfigWithToken(getConfigPath(), result.refresh_token || token);
  }

  async listAccounts() {
    return (await this.check()).authenticated
      ? [{ userId: 'legacy', name: 'Legacy Pixiv', isDefault: true }] : [];
  }

  async useAccount(uid: string): Promise<void> {
    if (uid !== 'legacy' || !(await this.check()).authenticated) throw new Error('legacy account not found');
  }

  async check() {
    return { authenticated: !isPlaceholderToken(loadConfig(getConfigPath(), true).pixiv?.refreshToken) };
  }

  async logout(): Promise<void> { await clearConfigToken(getConfigPath()); }
}
