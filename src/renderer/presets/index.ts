/**
 * Platform render presets (F2-M3).
 */
export interface RenderPreset {
  id: string;
  platform: string;
  width: number;
  height: number;
  fps: number;
  videoBitrate?: string;
  loopSeamless?: boolean;
  notes?: string;
}

export const RENDER_PRESETS: RenderPreset[] = [
  { id: 'bilibili-1080p', platform: 'bilibili', width: 1920, height: 1080, fps: 30 },
  { id: 'douyin-1080x1920', platform: 'douyin', width: 1080, height: 1920, fps: 30 },
  { id: 'xiaohongshu-1080x1920', platform: 'xiaohongshu', width: 1080, height: 1920, fps: 30 },
  { id: 'youtube-4k', platform: 'youtube', width: 3840, height: 2160, fps: 30, notes: 'optional 4K' },
  { id: 'we-loop', platform: 'wallpaper-engine-package', width: 1920, height: 1080, fps: 60, loopSeamless: true, notes: 'seamless loop' },
];

export function presetForPlatform(platform: string): RenderPreset | undefined {
  return RENDER_PRESETS.find((p) => p.platform === platform);
}
