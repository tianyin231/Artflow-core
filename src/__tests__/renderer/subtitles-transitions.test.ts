import { toSrt, toAss, parseSrt, validateSrt, creditCue } from '../../renderer/subtitles';
import { TRANSITIONS, getTransition, planTransitions } from '../../renderer/transitions';
import { detectBpm, clickOnsets, buildBeatGrid, snapCutsToBeats } from '../../renderer/beat';
import { parseSsim, isSeamlessLoop } from '../../renderer/we-loop';

describe('subtitles', () => {
  it('srt roundtrip', () => {
    const cues = [creditCue('Author', '123', 0, 2), { startSec: 2, endSec: 4, text: 'hello' }];
    const srt = toSrt(cues);
    expect(validateSrt(srt).ok).toBe(true);
    const parsed = parseSrt(srt);
    expect(parsed.length).toBe(2);
    expect(parsed[1].text).toBe('hello');
  });

  it('ass has header and dialogue lines', () => {
    const ass = toAss([{ startSec: 0, endSec: 1, text: 'hi' }]);
    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('Dialogue:');
    expect(ass).toContain('Noto Sans CJK SC');
  });
});

describe('transitions', () => {
  it('has at least 8 recipes', () => {
    expect(TRANSITIONS.length).toBeGreaterThanOrEqual(8);
    expect(getTransition('crossfade')?.kind).toBe('crossfade');
  });

  it('planTransitions maps to AI plan', () => {
    const plan = planTransitions(4, 'flash-white');
    expect(plan.length).toBe(3);
    expect(plan[0].id).toBe('flash-white');
  });
});

describe('beat snap', () => {
  it('detects 120 BPM from click track', () => {
    const onsets = clickOnsets(120, 10);
    const bpm = detectBpm(onsets);
    expect(Math.abs(bpm - 120)).toBeLessThanOrEqual(2);
  });

  it('snaps cuts to beats within 40ms', () => {
    const grid = buildBeatGrid(120, 10); // beats every 0.5s
    const { cuts, meanDeviationMs } = snapCutsToBeats([0.02, 0.49, 1.01], grid);
    expect(cuts[0]).toBe(0);
    expect(cuts[1]).toBeCloseTo(0.5, 2);
    expect(meanDeviationMs).toBeLessThanOrEqual(40);
  });
});

describe('WE loop', () => {
  it('parses ssim and checks threshold', () => {
    expect(parseSsim('SSIM Y:0.970000 (10.5) U:0.98')).toBeCloseTo(0.97);
    expect(isSeamlessLoop(0.97)).toBe(true);
    expect(isSeamlessLoop(0.9)).toBe(false);
  });
});
