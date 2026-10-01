import { AiAgent, mockLlm, PROVIDER_PRESETS, PROMPT_VERSIONS, getPrompt } from '../../ai/agent';
import { validatePlan } from '../../ai/plan-schema';

describe('AiAgent mock scenarios', () => {
  it('ok produces a valid plan and records tokens', async () => {
    const agent = new AiAgent(mockLlm('ok'), { provider: 'mock' });
    const r = await agent.plan('test command');
    expect(validatePlan(r.plan).ok).toBe(true);
    expect(r.tokens.prompt).toBeGreaterThan(0);
    expect(r.tokens.costUsd).toBeGreaterThanOrEqual(0);
    expect(r.steps.some((s) => s.name === 'plan' && s.ok)).toBe(true);
  });

  it('malformed falls back to local rules', async () => {
    const agent = new AiAgent(mockLlm('malformed'));
    const r = await agent.plan('本周鸣潮');
    expect(validatePlan(r.plan).ok).toBe(true);
    expect(r.steps.some((s) => s.name === 'fallback-local')).toBe(true);
  });

  it('truncated triggers revise then fallback', async () => {
    const agent = new AiAgent(mockLlm('truncated'));
    const r = await agent.plan('x');
    expect(validatePlan(r.plan).ok).toBe(true);
    expect(r.steps.some((s) => s.name === 'revise' || s.name === 'fallback-local')).toBe(true);
  });

  it('timeout falls back to local rules', async () => {
    const agent = new AiAgent(mockLlm('timeout'));
    const r = await agent.plan('x');
    expect(validatePlan(r.plan).ok).toBe(true);
    expect(r.provider).toBe('local-rules');
  });

  it('rate-limit falls back', async () => {
    const agent = new AiAgent(mockLlm('rate-limit'));
    const r = await agent.plan('x');
    expect(validatePlan(r.plan).ok).toBe(true);
  });

  it('refusal still yields a plan', async () => {
    const agent = new AiAgent(mockLlm('refusal'));
    const r = await agent.plan('x');
    expect(validatePlan(r.plan).ok).toBe(true);
  });
});

describe('providers and prompts', () => {
  it('has provider presets', () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(5);
    expect(PROVIDER_PRESETS.find((p) => p.id === 'mock')).toBeTruthy();
  });

  it('prompt versions are retrievable', () => {
    expect(PROMPT_VERSIONS.length).toBeGreaterThanOrEqual(2);
    expect(getPrompt('plan-v2')).toContain('pixivTarget');
  });
});
