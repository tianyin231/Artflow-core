/**
 * AI planning JSON Schema (F2-M5) + repair-on-error.
 */
export interface AiPlan {
  pixivTarget: { tag: string; limit?: number; minBookmarks?: number; sort?: string };
  video: {
    title: string;
    description?: string;
    tags?: string[];
    aspectRatio?: '16:9' | '9:16' | '1:1' | '3:4';
    secondsPerImage?: number;
    bpm?: number;
  };
  publish?: { title?: string; description?: string; tags?: string[] };
}

export function validatePlan(obj: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const o = obj as Record<string, any>;
  if (!o || typeof o !== 'object') return { ok: false, errors: ['not an object'] };
  if (!o.pixivTarget || typeof o.pixivTarget !== 'object') errors.push('pixivTarget required');
  else if (!o.pixivTarget.tag) errors.push('pixivTarget.tag required');
  if (!o.video || typeof o.video !== 'object') errors.push('video required');
  else if (!o.video.title) errors.push('video.title required');
  return { ok: errors.length === 0, errors };
}

export function repairPlan(raw: string): AiPlan | null {
  try {
    let text = raw.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    const obj = JSON.parse(text) as AiPlan;
    const v = validatePlan(obj);
    return v.ok ? obj : null;
  } catch {
    return null;
  }
}

export function localRulePlan(command: string): AiPlan {
  const tag = command.match(/[一-鿿A-Za-z]+/)?.[0] ?? 'original';
  return {
    pixivTarget: { tag, limit: 10, minBookmarks: 0, sort: 'popular_desc' },
    video: { title: command.slice(0, 20) || 'Artflow Video', aspectRatio: '16:9', secondsPerImage: 1.5 },
  };
}
