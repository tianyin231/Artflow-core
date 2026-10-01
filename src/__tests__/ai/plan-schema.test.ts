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
});
