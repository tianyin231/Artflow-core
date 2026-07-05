/**
 * Proxy Configuration
 * 
 * Handles proxy configuration for Python login adapter
 */

/**
 * Proxy configuration interface
 */
export interface ProxyConfig {
  enabled: boolean;
  host: string;
  port: number;
  protocol: 'http' | 'https' | 'socks4' | 'socks5';
  username?: string;
  password?: string;
}

/**
 * Build proxy URL from proxy configuration
 */
export function buildProxyUrl(proxy: ProxyConfig): string {
  const { protocol, host, port, username, password } = proxy;
  let proxyUrl = `${protocol}://`;
  if (username && password) {
    proxyUrl += `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
  }
  proxyUrl += `${host}:${port}`;
  return proxyUrl;
}

/**
 * Build proxy environment variables string for Python script
 */
export function buildProxyEnvVars(proxy?: ProxyConfig): string {
  if (!proxy || !proxy.enabled) {
    return '';
  }

  const proxyUrl = buildProxyUrl(proxy);
  const chromeProxy = `${proxy.host}:${proxy.port}`;
  return `
import os
proxy_url = "${proxyUrl}"
chrome_proxy = "${chromeProxy}"
os.environ['HTTPS_PROXY'] = proxy_url
os.environ['HTTP_PROXY'] = proxy_url
os.environ['ALL_PROXY'] = proxy_url
os.environ['NO_PROXY'] = 'localhost,127.0.0.1,::1'
os.environ['no_proxy'] = 'localhost,127.0.0.1,::1'
print(f"[DEBUG]: Proxy configured: {proxy_url}", file=sys.stderr)
try:
    import gppt.utils as gppt_utils
    gppt_utils.PROXIES = {
        'http': proxy_url,
        'https': proxy_url,
        'all': chrome_proxy,
    }
    print(f"[DEBUG]: Chrome proxy configured: {chrome_proxy}", file=sys.stderr)
except Exception as proxy_patch_error:
    print(f"[WARNING]: Failed to patch gppt proxy settings: {proxy_patch_error}", file=sys.stderr)
`;
}





























































