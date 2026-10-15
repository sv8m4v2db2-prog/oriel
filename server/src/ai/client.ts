// Anthropic client creation, injectable so that tests (and the demo mode) never reach the network.
import Anthropic from '@anthropic-ai/sdk';
import { createFakeFetch, demoBrain, type FakeBrain } from './fake.js';
import { isFakeMode } from './settings.js';

export type AiClientFactory = (apiKey: string) => Anthropic;

let override: AiClientFactory | null = null;

/** Replaces the client factory (tests); `null` restores the default. */
export function setAiClientFactory(factory: AiClientFactory | null): void {
  override = factory;
}

/** A new client per run, with the configured key. */
export function createAiClient(apiKey: string): Anthropic {
  if (override) return override(apiKey);
  if (isFakeMode()) {
    // Simulated thinking time per turn so the interface shows the run in progress (0 = instant).
    const delayMs = Math.max(0, Number(process.env.ORIEL_AI_FAKE_DELAY_MS ?? 800) || 0);
    const brain: FakeBrain = delayMs ? async (req) => (await new Promise((r) => setTimeout(r, delayMs)), demoBrain(req)) : demoBrain;
    return new Anthropic({ apiKey: apiKey || 'demo', fetch: createFakeFetch(brain), maxRetries: 0 });
  }
  return new Anthropic({ apiKey });
}
