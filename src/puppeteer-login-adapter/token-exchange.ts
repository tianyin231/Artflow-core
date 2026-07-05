/**
 * Token exchange utilities
 */

import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { LoginInfo } from '../terminal-login';
import { AUTH_TOKEN_URL, CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, USER_AGENT } from './constants';
import { ProxyConfig, buildProxyUrl } from './proxy';

/**
 * Exchange authorization code for access token
 */
export async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
  proxy?: ProxyConfig
): Promise<LoginInfo> {
  try {
    const enabledProxy = proxy?.enabled ? proxy : undefined;
    const proxyUrl = enabledProxy ? buildProxyUrl(enabledProxy) : undefined;
    const agent = proxyUrl
      ? enabledProxy?.protocol === 'socks4' || enabledProxy?.protocol === 'socks5'
        ? new SocksProxyAgent(proxyUrl)
        : new HttpsProxyAgent(proxyUrl)
      : undefined;

    const response = await axios.post(
      AUTH_TOKEN_URL,
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        include_policy: 'true',
        redirect_uri: REDIRECT_URI,
      }).toString(),
      {
        headers: {
          'user-agent': USER_AGENT,
          'app-os-version': '14.6',
          'app-os': 'ios',
          'content-type': 'application/x-www-form-urlencoded',
        },
        ...(agent ? { httpAgent: agent, httpsAgent: agent, proxy: false as const } : {}),
        timeout: 30000,
      }
    );
    
    const data = response.data;
    
    return {
      access_token: data.access_token,
      expires_in: data.expires_in,
      token_type: data.token_type || 'bearer',
      scope: data.scope || '',
      refresh_token: data.refresh_token,
      user: data.user,
      response: data,
    };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      const responseData = typeof error.response.data === 'string'
        ? error.response.data
        : JSON.stringify(error.response.data);
      throw new Error(
        `Failed to exchange code for token: ${error.response.status} ${error.response.statusText}` +
        (responseData ? ` - ${responseData}` : '')
      );
    }
    throw new Error(`Failed to exchange code for token: ${formatTokenExchangeError(error)}`);
  }
}

function formatTokenExchangeError(error: unknown): string {
  if (error instanceof AggregateError) {
    const messages = error.errors
      .map((item) => item instanceof Error ? `${item.message}${getErrorCode(item)}` : String(item))
      .join('; ');
    return `${error.message}${messages ? ` (${messages})` : ''}`;
  }

  if (error instanceof Error) {
    return `${error.message}${getErrorCode(error)}`;
  }

  return String(error);
}

function getErrorCode(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? ` [${code}]` : '';
}





























































