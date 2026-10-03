/**
 * Transition / camera effect recipes (F2-M3) — JSON-described, AI-plannable.
 */
export type TransitionId = 'kenburns-zoom-in' | 'kenburns-pan-left' | 'crossfade' | 'push-left' | 'wipe-right' | 'flash-white' | 'blur-in' | 'zoom-out';

export interface TransitionRecipe {
  id: TransitionId;
  name: string;
  kind: 'kenburns' | 'crossfade' | 'push' | 'wipe' | 'flash' | 'blur' | 'zoom' | 'slide';
  durationMs: number;
  params?: Record<string, number | string>;
}

export const TRANSITIONS: TransitionRecipe[] = [
  { id: 'kenburns-zoom-in', name: 'Ken Burns 推近', kind: 'kenburns', durationMs: 800, params: { from: 1, to: 1.08, pan: 'center' } },
  { id: 'kenburns-pan-left', name: 'Ken Burns 左移', kind: 'kenburns', durationMs: 800, params: { pan: 'left', to: 1.05 } },
  { id: 'crossfade', name: '交叉淡化', kind: 'crossfade', durationMs: 500 },
  { id: 'push-left', name: '左推', kind: 'push', durationMs: 400, params: { direction: 'left' } },
  { id: 'wipe-right', name: '右擦除', kind: 'wipe', durationMs: 450, params: { direction: 'right' } },
  { id: 'flash-white', name: '闪白', kind: 'flash', durationMs: 250, params: { color: '#ffffff' } },
  { id: 'blur-in', name: '模糊进入', kind: 'blur', durationMs: 600, params: { radius: 12 } },
  { id: 'zoom-out', name: '拉远', kind: 'zoom', durationMs: 700, params: { from: 1.1, to: 1 } },
];

export function getTransition(id: string): TransitionRecipe | undefined {
  return TRANSITIONS.find((t) => t.id === id);
}

export function planTransitions(count: number, preferred?: string): TransitionRecipe[] {
  const base = preferred ? getTransition(preferred) : undefined;
  return Array.from({ length: Math.max(0, count - 1) }, (_, i) =>
    base ?? TRANSITIONS[i % TRANSITIONS.length]
  );
}
