import { describe, expect, it } from 'vitest';
import { estimateBedrockCostUsd, resolveBedrockPricing } from '../src/bedrock-pricing.js';

const envFallback = {
  BEDROCK_INPUT_COST_PER_MILLION: 1,
  BEDROCK_OUTPUT_COST_PER_MILLION: 5,
} as const;

describe('bedrock pricing', () => {
  it('uses catalog pricing for Claude Haiku', () => {
    const pricing = resolveBedrockPricing(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      envFallback,
    );
    expect(pricing.pricedAs).toBe('catalog');
    expect(pricing.inputPerMillion).toBe(1);
    expect(pricing.outputPerMillion).toBe(5);
    expect(
      estimateBedrockCostUsd('us.anthropic.claude-haiku-4-5-20251001-v1:0', 1000, 200, envFallback),
    ).toBeCloseTo(0.002);
  });

  it('uses lower catalog pricing for Nova Micro', () => {
    const pricing = resolveBedrockPricing('us.amazon.nova-micro-v1:0', envFallback);
    expect(pricing.pricedAs).toBe('catalog');
    expect(pricing.inputPerMillion).toBe(0.035);
    expect(pricing.outputPerMillion).toBe(0.14);
    const haiku = estimateBedrockCostUsd(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      10_000,
      500,
      envFallback,
    );
    const nova = estimateBedrockCostUsd('us.amazon.nova-micro-v1:0', 10_000, 500, envFallback);
    expect(nova).toBeLessThan(haiku);
  });

  it('falls back to env pricing for unknown model IDs', () => {
    const pricing = resolveBedrockPricing('unknown.model', envFallback);
    expect(pricing.pricedAs).toBe('env-fallback');
    expect(pricing.inputPerMillion).toBe(1);
    expect(pricing.outputPerMillion).toBe(5);
  });
});
