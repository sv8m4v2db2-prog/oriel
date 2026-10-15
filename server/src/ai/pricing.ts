// Token accounting and cost computation (USD) for brief runs.
import { AI_MODELS, type AiModelPricing, type AiTokenUsage } from '@oriel/shared';

/**
 * USD per million tokens. The selectable models come from the shared table; the others are the
 * models a server-side refusal fallback may hand a turn to (priced at their own rates).
 */
const PRICES: Record<string, AiModelPricing> = {
  ...Object.fromEntries(AI_MODELS.map((m) => [m.id, m.pricing])),
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
};

export function priceOf(model: string | null | undefined, fallbackModel: string): AiModelPricing {
  return (model ? PRICES[model] : undefined) ?? PRICES[fallbackModel] ?? PRICES['claude-opus-5-5']!;
}

export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Cost in USD of one block of usage at a model's rates. */
export function usageCost(usage: UsageLike, pricing: AiModelPricing): number {
  return (
    ((usage.input_tokens ?? 0) * pricing.input +
      (usage.output_tokens ?? 0) * pricing.output +
      (usage.cache_creation_input_tokens ?? 0) * pricing.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * pricing.cacheRead) /
    1_000_000
  );
}

interface IterationLike extends UsageLike {
  type: string;
  model?: string | null;
}

export interface MessageLike {
  model?: string | null;
  usage: UsageLike & { iterations?: IterationLike[] | null };
}

/**
 * Cost of one API response. When the server reports per-iteration usage (e.g. a refusal fallback
 * served the turn on another model), each sampling iteration is priced at its own model's rates;
 * otherwise the top-level usage is priced at the model that answered.
 */
export function messageCost(message: MessageLike, requestedModel: string): number {
  const iterations = (message.usage.iterations ?? []).filter((i) => i.type === 'message' || i.type === 'fallback_message');
  if (iterations.length > 0) {
    return iterations.reduce((sum, it) => sum + usageCost(it, priceOf(it.model, requestedModel)), 0);
  }
  return usageCost(message.usage, priceOf(message.model, requestedModel));
}

/** Mutable accumulator shared by the agent loop and the run bookkeeping (kept on failure too). */
export class RunAccounting {
  usage: AiTokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  costUsd = 0;
  turns = 0;

  constructor(readonly model: string) {}

  add(message: MessageLike): void {
    const u = message.usage;
    this.usage.inputTokens += u.input_tokens ?? 0;
    this.usage.outputTokens += u.output_tokens ?? 0;
    this.usage.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
    this.usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    this.costUsd += messageCost(message, this.model);
    this.turns += 1;
  }
}

/** Rounds a USD amount for storage (micro-dollars). */
export const roundUsd = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;
