/**
 * Token refresh functionality
 * Handles refreshing OAuth tokens using refresh tokens
 */

import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { AUTH_TOKEN_URL, CLIENT_ID, CLIENT_SECRET, USER_AGENT, TIMEOUT } from './constants';
import { LoginInfo, OAuthResponse, PixivLoginFailedError } from './types';
import { ProxyConfig, buildProxyUrl } from '../puppeteer-login-adapter/proxy';

/**
 * Refresh OAuth token using refresh token
 * 
 * Based on gppt's refresh token implementation.
 * This matches the token refresh flow used by get-pixivpy-token.
 * 
 * Reference: https://github.com/eggplants/get-pixivpy-token
 */
export async function refreshToken(refreshToken: string, proxy?: ProxyConfig): Promise<LoginInfo> {
  try {
    const enabledProxy = proxy?.enabled ? proxy : undefined;
    const proxyUrl = enabledProxy ? buildProxyUrl(enabledProxy) : undefined;
    const agent = proxyUrl
      ? enabledProxy?.protocol === 'socks4' || enabledProxy?.protocol === 'socks5'
        ? new SocksProxyAgent(proxyUrl)
        : new HttpsProxyAgent(proxyUrl)
      : undefined;

    const response = await axios.post<OAuthResponse>(
      AUTH_TOKEN_URL,
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        include_policy: 'true',
        refresh_token: refreshToken,
      }).toString(),
      {
        headers: {
          'user-agent': USER_AGENT,
          'app-os-version': '14.6',
          'app-os': 'ios',
          'content-type': 'application/x-www-form-urlencoded',
        },
        ...(agent ? { httpAgent: agent, httpsAgent: agent, proxy: false as const } : {}),
        timeout: TIMEOUT,
      }
    );

    // Convert OAuthResponse to LoginInfo
    return {
      ...response.data,
      response: response.data,
    };
  } catch (error) {
    const errorMessage = formatRefreshError(error);
    throw new PixivLoginFailedError(`Failed to refresh token: ${errorMessage}`);
  }
}

function formatRefreshError(error: unknown): string {
  if (axios.isAxiosError(error) && error.response) {
    const responseData = typeof error.response.data === 'string'
      ? error.response.data
      : JSON.stringify(error.response.data);
    return `${error.response.status} ${error.response.statusText}${responseData ? ` - ${responseData}` : ''}`;
  }

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






























































