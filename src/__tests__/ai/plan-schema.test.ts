import { validatePlan, repairPlan, localRulePlan } from '../../ai/plan-schema';

describe('AI plan schema', () => {
  it('validates a good plan', () => {
    expect(validatePlan({ pixivTarget: { tag: 'x' }, video: { title: 't' } }).ok).toBe(true);
  });
  it('rejects missing fields', () => {
    expect(validatePlan({}).ok).toBe(false);
    expect(validatePlan({ pixivTarget: {}, video: {} }).ok).toBe(false);
  });
  it('repairs markdown-fenced JSON', () => {
    const plan = repairPlan('```json\n{"pixivTarget":{"tag":"a"},"video":{"title":"t"}}\n```');
    expect(plan?.pixivTarget.tag).toBe('a');
  });
  it('returns null on garbage', () => {
    expect(repairPlan('not json at all')).toBeNull();
  });
  it('local rule fallback produces valid plan', () => {
    const plan = localRulePlan('本周鸣潮 收藏数500+');
    expect(validatePlan(plan).ok).toBe(true);
    expect(plan.pixivTarget.tag).toBeTruthy();
  });

  it.each([
    [], null, { pixivTarget: [], video: [] },
    { pixivTarget: { tag: {} }, video: { title: true } },
    { pixivTarget: { tag: ' ' }, video: { title: ' ' } },
    { pixivTarget: { tag: 'x', limit: -1 }, video: { title: 't' } },
    { pixivTarget: { tag: 'x', minBookmarks: 1.5 }, video: { title: 't' } },
    { pixivTarget: { tag: 'x' }, video: { title: 't', secondsPerImage: -2 } },
    { pixivTarget: { tag: 'x' }, video: { title: 't', bpm: Infinity } },
    { pixivTarget: { tag: 'x' }, video: { title: 't', aspectRatio: '2:1' } },
    { pixivTarget: { tag: 'x' }, video: { title: 't', tags: [12] } },
    { pixivTarget: { tag: 'x' }, video: { title: 't' }, publish: { tags: 'x' } },
  ])('rejects malformed or unusable plan %#', (input) => {
    expect(validatePlan(input).ok).toBe(false);
  });

  it('does not extract a plan out of a valid JSON array', () => {
    expect(repairPlan('[{"pixivTarget":{"tag":"x"},"video":{"title":"t"}}]')).toBeNull();
  });

  it('preserves Japanese tags and requested bookmark thresholds in local fallback', () => {
    const plan = localRulePlan('初音ミク 收藏数550+ 卡点视频');
    expect(plan.pixivTarget).toMatchObject({ tag: '初音ミク', minBookmarks: 550 });
    expect(validatePlan(plan).ok).toBe(true);
    expect(validatePlan(localRulePlan('   ')).ok).toBe(true);
  });
});
