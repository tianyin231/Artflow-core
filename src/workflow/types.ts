import { StandaloneConfig, TargetConfig } from '../config';

export type WorkflowStageId =
  | 'plan'
  | 'download'
  | 'filter'
  | 'image'
  | 'render'
  | 'review'
  | 'publish';

export type WorkflowStageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
export type WorkflowTaskStatus =
  | 'running'
  | 'asset_review_required'
  | 'cover_review_required'
  | 'review_required'
  | 'approved'
  | 'rejected'
  | 'published'
  | 'failed';

export type WorkflowPrefilterMode = 'manual' | 'ai_rules' | 'keep_all';
export type WorkflowAction =
  | 'continue_assets_manual'
  | 'continue_assets_keep_all'
  | 'continue_assets_ai_rules'
  | 'approve_cover'
  | 'approve_video'
  | 'reject';

export interface WorkflowStage {
  id: WorkflowStageId;
  label: string;
  status: WorkflowStageStatus;
  message: string;
  progress: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface WorkflowPlan {
  title: string;
  description: string;
  pixivTarget: TargetConfig;
  video: {
    style: WorkflowVideoStyle;
    motion: WorkflowVideoMotion;
    width: number;
    height: number;
    fps: number;
    secondsPerImage: number;
    crossfade: number;
    zoom: number;
    maxImages: number;
    shuffleSeed: number;
    totalDuration?: number;
    bgmPath?: string;
  };
  publish: {
    platform: 'bilibili';
    dryRun: true;
    category: string;
    tags: string[];
    original: boolean;
    aigc: boolean;
  };
}

export type WorkflowVideoStyle = 'beat' | 'soft' | 'square';
export type WorkflowVideoMotion = 'none' | 'slow_zoom' | 'beat_zoom';

export interface WorkflowVideoOverrides {
  aspectRatio?: '16:9' | '9:16' | '1:1';
  totalDuration?: number;
  maxImages?: number;
  secondsPerImage?: number;
  fps?: number;
  crossfade?: number;
  zoom?: number;
  motion?: WorkflowVideoMotion;
  bgmPath?: string;
  style?: WorkflowVideoStyle;
}

export interface WorkflowImageAsset {
  path: string;
  name: string;
  width: number;
  height: number;
  size: number;
  pixivId?: string;
  title?: string;
  caption?: string;
  author?: {
    id: string;
    name: string;
    account?: string;
    profileImageUrls?: Record<string, string>;
  };
  tags?: Array<{ name: string; translated_name?: string }>;
  fileHash?: string;
  status: 'accepted' | 'rejected';
  reason?: string;
}

export interface WorkflowProgressEvent {
  id: string;
  timestamp: string;
  stage: WorkflowStageId;
  type: 'stage' | 'asset' | 'cover' | 'video' | 'publish';
  message: string;
  current?: number;
  total?: number;
  assetName?: string;
  artifactPath?: string;
}

export interface WorkflowLatestArtifact {
  type: 'asset' | 'cover' | 'video' | 'publish';
  name?: string;
  path?: string;
  assetIndex?: number;
  message?: string;
}

export interface WorkflowTask {
  id: string;
  command: string;
  status: WorkflowTaskStatus;
  createdAt: string;
  updatedAt: string;
  stages: WorkflowStage[];
  plan?: WorkflowPlan;
  pixivConfig?: Partial<StandaloneConfig>;
  assets: WorkflowImageAsset[];
  currentStage?: WorkflowStageId;
  latestArtifact?: WorkflowLatestArtifact;
  requiresUserConfirmation?: boolean;
  availableActions?: WorkflowAction[];
  progressEvents?: WorkflowProgressEvent[];
  coverPath?: string;
  videoPath?: string;
  review?: {
    status: 'pending' | 'approved' | 'rejected';
    note?: string;
    reviewedAt?: string;
  };
  publish?: {
    status: 'pending' | 'dry_run_completed';
    platform: 'bilibili';
    message?: string;
    publishedAt?: string;
  };
  logs: Array<{
    timestamp: string;
    level: 'info' | 'warn' | 'error';
    message: string;
  }>;
}

export interface CreateWorkflowTaskRequest {
  command: string;
  dryRunDownload?: boolean;
  prefilterMode?: WorkflowPrefilterMode;
  videoOverrides?: WorkflowVideoOverrides;
  pixivOverrides?: Partial<Pick<
    TargetConfig,
    | 'tag'
    | 'limit'
    | 'searchTarget'
    | 'sort'
    | 'mode'
    | 'rankingMode'
    | 'rankingDate'
    | 'filterTag'
    | 'minBookmarks'
    | 'startDate'
    | 'endDate'
    | 'tagWhitelist'
    | 'tagBlacklist'
  >>;
}
