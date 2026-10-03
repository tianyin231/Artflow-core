/**
 * Subtitle generation: SRT / ASS (F2-M3).
 */
export interface SubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}

function fmtSrt(t: number): string {
  const ticks = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ticks / 3_600_000);
  const m = Math.floor(ticks / 60_000) % 60;
  const s = Math.floor(ticks / 1000) % 60;
  const ms = ticks % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function fmtAss(t: number): string {
  const ticks = Math.max(0, Math.round(t * 100));
  const h = Math.floor(ticks / 360_000);
  const m = Math.floor(ticks / 6000) % 60;
  const s = Math.floor(ticks / 100) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ticks % 100).padStart(2, '0')}`;
}

export function toSrt(cues: SubtitleCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${fmtSrt(c.startSec)} --> ${fmtSrt(c.endSec)}\n${c.text}\n`)
    .join('\n');
}

export function toAss(cues: SubtitleCue[], title = 'Artflow'): string {
  const header = [
    '[Script Info]',
    `Title: ${title.replace(/[\r\n]/g, ' ')}`,
    'ScriptType: v4.00+',
    'PlayResX: 1920',
    'PlayResY: 1080',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Noto Sans CJK SC,48,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,40,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
  const events = cues
    .map((c) => `Dialogue: 0,${fmtAss(c.startSec)},${fmtAss(c.endSec)},Default,,0,0,0,,${c.text.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\r?\n/g, '\\N')}`)
    .join('\n');
  return `${header}\n${events}\n`;
}

export function parseSrt(srt: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = srt.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.trim().split('\n');
    if (lines.length < 2) continue;
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const [a, bb] = timeLine.split('-->').map((x) => x.trim());
    const parse = (s: string) => {
      const m = s.match(/^(\d+):([0-5]\d):([0-5]\d)[.,](\d{3})$/);
      if (!m) return NaN;
      return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
    };
    cues.push({ startSec: parse(a), endSec: parse(bb), text: lines.slice(lines.indexOf(timeLine) + 1).join('\n') });
  }
  return cues;
}

export function validateSrt(srt: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const cues = parseSrt(srt);
  if (cues.length === 0) errors.push('no cues');
  for (const c of cues) {
    if (!Number.isFinite(c.startSec) || !Number.isFinite(c.endSec)) errors.push('invalid timestamp');
    if (c.endSec < c.startSec) errors.push(`end before start: ${c.text.slice(0, 20)}`);
    if (!c.text.trim()) errors.push('empty text');
  }
  return { ok: errors.length === 0, errors };
}

export function creditCue(author: string, pixivId: string, startSec = 0, endSec = 3): SubtitleCue {
  return { startSec, endSec, text: `${author} · pixiv ${pixivId}` };
}
