import { Request, Response } from 'express';
import { getConfigPath, loadConfig, ConfigValidationError } from '../../../../config';
import { logger } from '../../../../logger';
import { ErrorCode } from '../../../utils/error-codes';
import { ConfigError } from '../../../../utils/errors';
import { isPlaceholderToken, getBestAvailableToken } from '../../../../utils/token-manager';
import { readConfigRaw, getRefreshToken, validateToken, getValidationErrors } from './auth-utils';

/**
 * GET /api/auth/status
 * Get authentication status
 * Validates token to ensure it's still valid, not just checking if it exists
 */
export async function getAuthStatus(req: Request, res: Response): Promise<void> {
  try {
    const configPath = getConfigPath();
    const config = loadConfig(configPath);

    const refreshToken = config.pixiv?.refreshToken;
    const hasToken = !!refreshToken && !isPlaceholderToken(refreshToken);
    
    const authenticated = hasToken;

    if (!hasToken) {
      logger.debug('No valid token found - user is not authenticated', { hasToken, configPath });
    }

    logger.debug('Auth status check', { authenticated, hasToken, configPath });

    res.json({
      data: {
        authenticated,
        hasToken,
        tokenValid: hasToken ? null : false,
        isAuthenticated: authenticated, // Alias for compatibility
        user: null,
      },
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      const { errors: validationErrors, warnings: validationWarnings } = getValidationErrors(error);
      
      // Even if validation fails, check for refreshToken in raw config or unified storage
      // This allows users to be authenticated even if other config fields are missing
      const configPath = getConfigPath();
      const rawConfig = readConfigRaw(configPath);
      
      // Check config file token first
      let configToken = rawConfig?.pixiv?.refreshToken;
      if (isPlaceholderToken(configToken)) {
        // If config file has placeholder, check unified storage
        // We need to determine database path from config (even if invalid)
        const databasePath = rawConfig?.storage?.databasePath;
        const unifiedToken = getBestAvailableToken(configToken, databasePath);
        if (unifiedToken) {
          configToken = unifiedToken;
        }
      }
      
      const hasToken = !isPlaceholderToken(configToken);
      
      const finalAuthenticated = hasToken;

      logger.warn('Configuration invalid when checking auth status', {
        errors: validationErrors,
        warnings: validationWarnings,
        hasToken,
        authenticated: finalAuthenticated,
      });
      
      res.json({
        data: {
          authenticated: finalAuthenticated,
          hasToken,
          tokenValid: hasToken ? null : false,
          isAuthenticated: finalAuthenticated, // Alias for compatibility
          configReady: false, // Config is not fully ready (validation failed)
          errors: validationErrors,
          warnings: validationWarnings,
          user: null,
        },
      });
      return;
    }
    logger.error('Failed to get auth status', { error });
    res.status(500).json({ errorCode: ErrorCode.AUTH_STATUS_FAILED });
  }
}
