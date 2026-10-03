/**
 * Cover templates (F2-M3) — JSON-described layouts.
 */
export type CoverTemplateId = 'grid' | 'single' | 'collage' | 'poster-3x4' | 'bilibili-16x10' | 'youtube-720p';

export interface CoverTemplate {
  id: CoverTemplateId;
  name: string;
  width: number;
  height: number;
  layout: 'grid' | 'single' | 'collage' | 'poster-vertical' | 'bilibili-16x10' | 'youtube-720p';
  title?: { x: number; y: number; size: number; color: string };
  description?: { x: number; y: number; size: number; color: string };
}

export const COVER_TEMPLATES: CoverTemplate[] = [
  { id: 'grid', name: '网格', width: 1280, height: 720, layout: 'grid' },
  { id: 'single', name: '单图大标题', width: 1280, height: 720, layout: 'single', title: { x: 64, y: 640, size: 48, color: '#ffffff' } },
  { id: 'collage', name: '拼贴', width: 1280, height: 720, layout: 'collage' },
  { id: 'poster-3x4', name: '竖版海报', width: 1080, height: 1440, layout: 'poster-vertical', title: { x: 54, y: 1320, size: 56, color: '#fff' } },
  { id: 'bilibili-16x10', name: 'B站 16:10', width: 1146, height: 717, layout: 'bilibili-16x10' },
  { id: 'youtube-720p', name: 'YouTube 1280x720', width: 1280, height: 720, layout: 'youtube-720p', title: { x: 48, y: 80, size: 42, color: '#fff' } },
];

export function getCoverTemplate(id: string): CoverTemplate | undefined {
  return COVER_TEMPLATES.find((t) => t.id === id);
}

export function validateCoverTemplate(t: CoverTemplate): string[] {
  const errs: string[] = [];
  if (t.width <= 0 || t.height <= 0) errs.push('invalid size');
  if (!t.layout) errs.push('missing layout');
  return errs;
}
