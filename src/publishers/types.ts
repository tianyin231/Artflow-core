/**
 * Publisher contract (T8).
 */
export interface PublishPackage {
  taskId: string;
  videoPath: string;
  coverPath: string;
  title: string;
  description: string;
  tags: string[];
  aspectRatio: '16:9' | '9:16' | '1:1' | '3:4';
  durationSec: number;
  sizeBytes: number;
  sources: { pixivId: string; author: string; url: string }[];
  extras?: Record<string, unknown>;
}

export interface PublisherCapabilities {
  maxSizeBytes?: number;
  maxDurationSec?: number;
  aspectRatios?: string[];
  titleMax?: number;
  descMax?: number;
  tagsMax?: number;
  auth: 'none' | 'oauth2' | 'apiKey' | 'botToken' | 'steamLogin';
  experimental?: boolean;
  manualOnly?: boolean;
}

export interface PublishIssue {
  field: string;
  message: string;
}

export interface PublishValidation {
  ok: boolean;
  issues: PublishIssue[];
}

export type AuthState = 'not_configured' | 'ok' | 'expired' | 'error';

export interface PublishResult {
  status: 'published' | 'submitted' | 'exported' | 'dry_run' | 'failed' | 'auth_required';
  remoteId?: string;
  url?: string;
  exportDir?: string;
  message?: string;
}

export interface PublishOptions {
  dryRun: boolean;
  signal?: AbortSignal;
  onProgress?: (p: number, msg: string) => void;
}

export interface Publisher {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: PublisherCapabilities;
  validate(pkg: PublishPackage): PublishValidation;
  authStatus(): Promise<{ state: AuthState; expiresAt?: string; account?: string }>;
  beginAuth?(): Promise<{ authorizeUrl: string; state: string }>;
  completeAuth?(input: { state: string; callback: string }): Promise<void>;
  refreshAuth?(): Promise<void>;
  publish(pkg: PublishPackage, opts: PublishOptions): Promise<PublishResult>;
}

export function validateCommon(pkg: PublishPackage, caps: PublisherCapabilities): PublishValidation {
  const issues: PublishIssue[] = [];
  if (caps.titleMax && pkg.title.length > caps.titleMax) {
    issues.push({ field: 'title', message: `title exceeds ${caps.titleMax} chars` });
  }
  if (caps.descMax && pkg.description.length > caps.descMax) {
    issues.push({ field: 'description', message: `description exceeds ${caps.descMax} chars` });
  }
  if (caps.tagsMax && pkg.tags.length > caps.tagsMax) {
    issues.push({ field: 'tags', message: `tags exceed ${caps.tagsMax}` });
  }
  if (caps.maxSizeBytes && pkg.sizeBytes > caps.maxSizeBytes) {
    issues.push({ field: 'sizeBytes', message: `file exceeds ${caps.maxSizeBytes} bytes` });
  }
  if (caps.maxDurationSec && pkg.durationSec > caps.maxDurationSec) {
    issues.push({ field: 'durationSec', message: `duration exceeds ${caps.maxDurationSec} seconds` });
  }
  if (caps.aspectRatios && !caps.aspectRatios.includes(pkg.aspectRatio)) {
    issues.push({ field: 'aspectRatio', message: `unsupported aspect ${pkg.aspectRatio}` });
  }
  return { ok: issues.length === 0, issues };
}
