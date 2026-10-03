import {
  totalDurationMs,
  buildConcatList,
  expectedFrameCount,
} from '../../renderer/ugoira';
import { COVER_TEMPLATES, getCoverTemplate, validateCoverTemplate } from '../../renderer/templates';
import { RENDER_PRESETS, presetForPlatform } from '../../renderer/presets';

describe('ugoira timing', () => {
  it('sums frame delays', () => {
    const frames = [
      { file: 'a.png', delayMs: 100 },
      { file: 'b.png', delayMs: 200 },
    ];
    expect(totalDurationMs(frames)).toBe(300);
    expect(expectedFrameCount(frames)).toBe(2);
  });

  it('builds concat list with durations', () => {
    const list = buildConcatList([{ file: '/tmp/a.png', delayMs: 500 }]);
    expect(list).toContain('/tmp/a.png');
    expect(list).toContain('duration 0.500');
  });
});

describe('cover templates', () => {
  it('has at least 6 templates with valid sizes', () => {
    expect(COVER_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    for (const t of COVER_TEMPLATES) {
      expect(validateCoverTemplate(t)).toEqual([]);
      expect(t.width).toBeGreaterThan(0);
      expect(t.height).toBeGreaterThan(0);
    }
  });

  it('lookup by id', () => {
    expect(getCoverTemplate('youtube-720p')?.width).toBe(1280);
  });
});

describe('render presets', () => {
  it('covers required platforms', () => {
    expect(presetForPlatform('bilibili')?.height).toBe(1080);
    expect(presetForPlatform('wallpaper-engine-package')?.loopSeamless).toBe(true);
    expect(RENDER_PRESETS.length).toBeGreaterThanOrEqual(5);
  });
});
