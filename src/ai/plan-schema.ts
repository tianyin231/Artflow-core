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
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(obj)) return { ok: false, errors: ['not an object'] };
  const text = (value: unknown, path: string, required = false, nonempty = false) => {
    if (value === undefined && !required) return;
    if (typeof value !== 'string' || ((required || nonempty) && !value.trim())) {
      errors.push(`${path} must be ${required || nonempty ? 'a nonempty string' : 'a string'}`);
    }
  };
  const number = (value: unknown, path: string, minimum: number, integer = false, exclusive = false) => {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || (exclusive && value === minimum) || (integer && !Number.isInteger(value))) {
      errors.push(`${path} must be a finite ${integer ? 'integer' : 'number'} ${exclusive ? '>' : '>='} ${minimum}`);
    }
  };
  const tags = (value: unknown, path: string) => {
    if (value !== undefined && (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string' || !tag.trim()))) {
      errors.push(`${path} must be an array of nonempty strings`);
    }
  };
  if (!record(obj.pixivTarget)) errors.push('pixivTarget required');
  else {
    text(obj.pixivTarget.tag, 'pixivTarget.tag', true);
    number(obj.pixivTarget.limit, 'pixivTarget.limit', 1, true);
    number(obj.pixivTarget.minBookmarks, 'pixivTarget.minBookmarks', 0, true);
    text(obj.pixivTarget.sort, 'pixivTarget.sort', false, true);
  }
  if (!record(obj.video)) errors.push('video required');
  else {
    text(obj.video.title, 'video.title', true);
    text(obj.video.description, 'video.description');
    tags(obj.video.tags, 'video.tags');
    if (obj.video.aspectRatio !== undefined && !['16:9', '9:16', '1:1', '3:4'].includes(obj.video.aspectRatio as string)) {
      errors.push('video.aspectRatio invalid');
    }
    for (const field of ['secondsPerImage', 'bpm'] as const) {
      number(obj.video[field], `video.${field}`, 0, false, true);
    }
  }
  if (obj.publish !== undefined) {
    if (!record(obj.publish)) errors.push('publish must be an object');
    else {
      text(obj.publish.title, 'publish.title', false, true);
      text(obj.publish.description, 'publish.description');
      tags(obj.publish.tags, 'publish.tags');
    }
  }
  return { ok: errors.length === 0, errors };
}

export function repairPlan(raw: string): AiPlan | null {
  try {
    let text = raw.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    }
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      // Only extract prose-wrapped JSON after parsing the entire response fails.
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      obj = JSON.parse(text.slice(start, end + 1));
    }
    const v = validatePlan(obj);
    return v.ok ? obj as AiPlan : null;
  } catch {
    return null;
  }
}

export function localRulePlan(command: string): AiPlan {
  const tag = command.match(/[\p{L}\p{N}_-]+/u)?.[0] ?? 'original';
  const bookmarks = Number(command.match(/收藏(?:数)?\s*(\d+)/)?.[1] ?? 0);
  const minBookmarks = Number.isSafeInteger(bookmarks) ? bookmarks : 0;
  return {
    pixivTarget: { tag, limit: 10, minBookmarks, sort: 'popular_desc' },
    video: { title: command.trim().slice(0, 20) || 'Artflow Video', aspectRatio: '16:9', secondsPerImage: 1.5 },
  };
}
