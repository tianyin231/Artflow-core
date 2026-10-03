/**
 * Multi-step AI planning agent (F2-M5): plan → self-critique → revise.
 */
import { AiPlan, localRulePlan, repairPlan, validatePlan } from './plan-schema';

export interface AgentResult {
  plan: AiPlan;
  steps: { name: string; ok: boolean; note?: string }[];
  tokens: { prompt: number; completion: number; costUsd: number };
  provider: string;
}

export interface LlmClient {
  complete(prompt: string, opts?: { json?: boolean }): Promise<{ text: string; promptTokens: number; completionTokens: number }>;
}

export const PROVIDER_PRESETS = [
  { id: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'mimo', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro' },
  { id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3' },
  { id: 'mock', baseUrl: 'http://127.0.0.1:3302/v1', model: 'mock' },
] as const;

/** Prompt template registry with versions. */
export const PROMPT_VERSIONS = [
  {
    id: 'plan-v1',
    version: '1.0.0',
    body: 'You are a video planning assistant. Output JSON with pixivTarget and video.',
  },
  {
    id: 'plan-v2',
    version: '2.0.0',
    body: 'Plan a Pixiv→video workflow. JSON schema: pixivTarget{tag,limit,minBookmarks,sort}, video{title,aspectRatio,secondsPerImage,bpm}, publish{title,tags}.',
  },
] as const;

export function getPrompt(id: string): string {
  return PROMPT_VERSIONS.find((p) => p.id === id)?.body ?? PROMPT_VERSIONS[0].body;
}

/** Pricing per 1K tokens (USD) — configurable. */
export const DEFAULT_PRICE_PER_1K = { input: 0.0005, output: 0.0015 };

export class AiAgent {
  constructor(
    private readonly llm: LlmClient,
    private readonly opts: { promptId?: string; price?: typeof DEFAULT_PRICE_PER_1K; provider?: string } = {}
  ) {}

  async plan(command: string): Promise<AgentResult> {
    const steps: AgentResult['steps'] = [];
    const price = this.opts.price ?? DEFAULT_PRICE_PER_1K;
    let promptTokens = 0;
    let completionTokens = 0;

    // Step 1: plan
    const prompt = `${getPrompt(this.opts.promptId ?? 'plan-v2')}\n\nUser: ${command}`;
    let raw = '';
    let requestFailed = false;
    try {
      const r1 = await this.llm.complete(prompt, { json: true });
      raw = r1.text;
      promptTokens += r1.promptTokens;
      completionTokens += r1.completionTokens;
      steps.push({ name: 'plan', ok: true });
    } catch (e) {
      steps.push({ name: 'plan', ok: false, note: String(e) });
      requestFailed = true;
    }

    // Step 2: validate / repair
    let plan = requestFailed ? null : repairPlan(raw);
    if (plan) steps.push({ name: 'validate', ok: true });
    else if (!requestFailed) {
      steps.push({ name: 'validate', ok: false, note: 'repair failed' });
      // Step 3: self-critique + revise once
      try {
        const r2 = await this.llm.complete(
          `${getPrompt(this.opts.promptId ?? 'plan-v2')}\nUser: ${command}\nThe previous JSON was invalid. Fix it.\n${raw}\n\nReturn only valid JSON.`,
          { json: true }
        );
        promptTokens += r2.promptTokens;
        completionTokens += r2.completionTokens;
        plan = repairPlan(r2.text);
        steps.push({ name: 'revise', ok: Boolean(plan) });
      } catch (e) {
        steps.push({ name: 'revise', ok: false, note: String(e) });
      }
    }

    const usedLocalRules = !plan;
    if (!plan) {
      plan = localRulePlan(command);
      steps.push({ name: 'fallback-local', ok: true });
    }

    // Step 4: self-critique (optional check)
    const v = validatePlan(plan);
    steps.push({ name: 'critique', ok: v.ok, note: v.errors.join(';') || undefined });

    const costUsd =
      (promptTokens / 1000) * price.input + (completionTokens / 1000) * price.output;
    return {
      plan,
      steps,
      tokens: { prompt: promptTokens, completion: completionTokens, costUsd: Math.round(costUsd * 1e6) / 1e6 },
      provider: usedLocalRules ? 'local-rules' : this.opts.provider ?? 'mock',
    };
  }
}

/** Mock LLM scenarios for tests. */
export type MockScenario = 'ok' | 'malformed' | 'truncated' | 'timeout' | 'rate-limit' | 'refusal';

export function mockLlm(scenario: MockScenario): LlmClient {
  return {
    async complete(prompt: string) {
      const promptTokens = Math.ceil(prompt.length / 4);
      switch (scenario) {
        case 'ok':
          return {
            text: JSON.stringify({ pixivTarget: { tag: 'mock', limit: 5 }, video: { title: 'Mock Video', aspectRatio: '16:9' } }),
            promptTokens,
            completionTokens: 40,
          };
        case 'malformed':
          return { text: 'not json at all', promptTokens, completionTokens: 5 };
        case 'truncated':
          return { text: '{"pixivTarget":{"tag":"x"', promptTokens, completionTokens: 10 };
        case 'timeout':
          throw new Error('timeout');
        case 'rate-limit':
          throw new Error('429 rate limited retry-after: 1');
        case 'refusal':
          return { text: 'I cannot help with that.', promptTokens, completionTokens: 8 };
        default:
          throw new Error('unknown scenario');
      }
    },
  };
}
