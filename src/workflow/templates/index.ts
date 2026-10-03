/**
 * Workflow template engine (F2-M6) — compile template → execution plan.
 */
export interface TemplateNode {
  id: string;
  kind: 'source' | 'filter' | 'review' | 'ai-plan' | 'cover' | 'render' | 'publish' | 'notify';
  params?: Record<string, unknown>;
}

export interface WorkflowTemplate {
  version: 'workflow-template.v1';
  id: string;
  name: string;
  nodes: TemplateNode[];
  edges: { from: string; to: string }[];
  variables?: Record<string, string>;
}

export function validateTemplate(t: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const nonempty = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
  if (!record(t)) return { ok: false, errors: ['not an object'] };
  const o = t;
  if (o.version !== 'workflow-template.v1') errors.push('bad version');
  if (!nonempty(o.id)) errors.push('missing id');
  if (!nonempty(o.name)) errors.push('missing name');
  if (!Array.isArray(o.nodes) || o.nodes.length === 0) errors.push('nodes required');
  if (!Array.isArray(o.edges)) errors.push('edges required');
  if (o.variables !== undefined && (!record(o.variables) || Object.values(o.variables).some((value) => typeof value !== 'string'))) {
    errors.push('variables must be an object of strings');
  }
  const ids = new Set<string>();
  const kinds = ['source', 'filter', 'review', 'ai-plan', 'cover', 'render', 'publish', 'notify'];
  for (const node of Array.isArray(o.nodes) ? o.nodes : []) {
    if (!record(node) || !nonempty(node.id)) {
      errors.push('node id required');
      continue;
    }
    if (ids.has(node.id)) errors.push(`duplicate node ${node.id}`);
    ids.add(node.id);
    if (typeof node.kind !== 'string' || !kinds.includes(node.kind)) errors.push(`node ${node.id} has invalid kind`);
    if (node.params !== undefined && !record(node.params)) errors.push(`node ${node.id} params must be an object`);
  }
  const adj = new Map<string, string[]>();
  const indeg = new Map([...ids].map((id) => [id, 0]));
  for (const edge of Array.isArray(o.edges) ? o.edges : []) {
    if (!record(edge) || !nonempty(edge.from) || !nonempty(edge.to)) {
      errors.push('edge from and to required');
      continue;
    }
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      errors.push(`edge ${edge.from}->${edge.to} dangling`);
      continue;
    }
    adj.set(edge.from, [...(adj.get(edge.from) || []), edge.to]);
    indeg.set(edge.to, indeg.get(edge.to)! + 1);
  }
  const queue = [...indeg].filter(([, degree]) => degree === 0).map(([id]) => id);
  for (let index = 0; index < queue.length; index++) {
    for (const id of adj.get(queue[index]) || []) {
      indeg.set(id, indeg.get(id)! - 1);
      if (indeg.get(id) === 0) queue.push(id);
    }
  }
  if (queue.length !== ids.size) errors.push('cycle detected');
  return { ok: errors.length === 0, errors };
}

export function applyVars(tpl: WorkflowTemplate, vars: Record<string, string>): WorkflowTemplate {
  const values = { ...tpl.variables, ...vars };
  const sub = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => Object.hasOwn(values, k) ? values[k] : `{{${k}}}`);
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') return sub(value);
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, fill(nested)]));
    }
    return value;
  };
  return {
    ...tpl,
    name: sub(tpl.name),
    nodes: tpl.nodes.map((n) => ({
      ...n,
      params: fill(n.params || {}) as Record<string, unknown>,
    })),
  };
}

export function compile(tpl: WorkflowTemplate, vars: Record<string, string> = {}): { order: string[]; errors: string[] } {
  const v = validateTemplate(tpl);
  if (!v.ok) return { order: [], errors: v.errors };
  const filled = applyVars(tpl, vars);
  const order: string[] = [];
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of filled.nodes) indeg.set(n.id, 0);
  for (const e of filled.edges) {
    adj.set(e.from, [...(adj.get(e.from) || []), e.to]);
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  }
  const q = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  while (q.length) {
    const id = q.shift()!;
    order.push(id);
    for (const n of adj.get(id) || []) {
      indeg.set(n, (indeg.get(n) || 1) - 1);
      if ((indeg.get(n) || 0) === 0) q.push(n);
    }
  }
  return { order, errors: order.length === filled.nodes.length ? [] : ['cycle or disconnected'] };
}

export function roundTrip(t: WorkflowTemplate): WorkflowTemplate {
  return JSON.parse(JSON.stringify(t)) as WorkflowTemplate;
}

/** Built-in templates (≥8). */
export const BUILTIN_TEMPLATES: WorkflowTemplate[] = [
  {
    version: 'workflow-template.v1',
    id: 'wuthering-weekly',
    name: '鸣潮周榜卡点',
    nodes: [
      { id: 'src', kind: 'source', params: { tag: '鳴潮', minBookmarks: 5000 } },
      { id: 'flt', kind: 'filter' },
      { id: 'rev', kind: 'review' },
      { id: 'ai', kind: 'ai-plan' },
      { id: 'cov', kind: 'cover' },
      { id: 'rnd', kind: 'render', params: { preset: 'bilibili-1080p' } },
      { id: 'pub', kind: 'publish', params: { platforms: ['bilibili', 'local-export'] } },
    ],
    edges: [
      { from: 'src', to: 'flt' },
      { from: 'flt', to: 'rev' },
      { from: 'rev', to: 'ai' },
      { from: 'ai', to: 'cov' },
      { from: 'cov', to: 'rnd' },
      { from: 'rnd', to: 'pub' },
    ],
  },
  {
    version: 'workflow-template.v1',
    id: 'miku-soft',
    name: '初音柔和图集',
    nodes: [
      { id: 'src', kind: 'source', params: { tag: '初音ミク' } },
      { id: 'flt', kind: 'filter' },
      { id: 'rnd', kind: 'render', params: { preset: 'youtube-4k' } },
      { id: 'pub', kind: 'publish', params: { platforms: ['youtube'] } },
    ],
    edges: [
      { from: 'src', to: 'flt' },
      { from: 'flt', to: 'rnd' },
      { from: 'rnd', to: 'pub' },
    ],
  },
  {
    version: 'workflow-template.v1',
    id: 'we-loop',
    name: 'Wallpaper Engine 循环壁纸',
    nodes: [
      { id: 'src', kind: 'source', params: { tag: '风景' } },
      { id: 'rnd', kind: 'render', params: { preset: 'we-loop' } },
      { id: 'pub', kind: 'publish', params: { platforms: ['wallpaper-engine-package'] } },
    ],
    edges: [
      { from: 'src', to: 'rnd' },
      { from: 'rnd', to: 'pub' },
    ],
  },
  {
    version: 'workflow-template.v1',
    id: 'yt-shorts',
    name: 'YouTube Shorts 竖屏',
    nodes: [
      { id: 'src', kind: 'source', params: { tag: 'Anime' } },
      { id: 'rnd', kind: 'render', params: { preset: 'douyin-1080x1920' } },
      { id: 'pub', kind: 'publish', params: { platforms: ['youtube'] } },
    ],
    edges: [
      { from: 'src', to: 'rnd' },
      { from: 'rnd', to: 'pub' },
    ],
  },
  {
    version: 'workflow-template.v1',
    id: 'local-export-only',
    name: '本地导出',
    nodes: [
      { id: 'src', kind: 'source' },
      { id: 'pub', kind: 'publish', params: { platforms: ['local-export'] } },
    ],
    edges: [{ from: 'src', to: 'pub' }],
  },
  {
    version: 'workflow-template.v1',
    id: 'xhs-portrait',
    name: '小红书竖版导出',
    nodes: [
      { id: 'src', kind: 'source', params: { tag: '{{tag}}' } },
      { id: 'rnd', kind: 'render', params: { preset: 'xiaohongshu-1080x1920' } },
      { id: 'pub', kind: 'publish', params: { platforms: ['xiaohongshu'] } },
    ],
    edges: [
      { from: 'src', to: 'rnd' },
      { from: 'rnd', to: 'pub' },
    ],
  },
  {
    version: 'workflow-template.v1',
    id: 'tg-notify',
    name: 'Telegram 通知',
    nodes: [
      { id: 'src', kind: 'source' },
      { id: 'rnd', kind: 'render' },
      { id: 'pub', kind: 'publish', params: { platforms: ['telegram'] } },
      { id: 'ntf', kind: 'notify' },
    ],
    edges: [
      { from: 'src', to: 'rnd' },
      { from: 'rnd', to: 'pub' },
      { from: 'pub', to: 'ntf' },
    ],
  },
  {
    version: 'workflow-template.v1',
    id: 'ai-first',
    name: 'AI 优先规划',
    nodes: [
      { id: 'ai', kind: 'ai-plan' },
      { id: 'src', kind: 'source', params: { tag: '{{tag}}', minBookmarks: '{{min}}' } },
      { id: 'rev', kind: 'review' },
      { id: 'rnd', kind: 'render' },
      { id: 'pub', kind: 'publish', params: { platforms: ['local-export'] } },
    ],
    edges: [
      { from: 'ai', to: 'src' },
      { from: 'src', to: 'rev' },
      { from: 'rev', to: 'rnd' },
      { from: 'rnd', to: 'pub' },
    ],
  },
];
