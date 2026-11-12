import type { AppConfig } from './config.js';

/** USD per million tokens — verify against current AWS Bedrock pricing pages. */
export const BEDROCK_MODEL_PRICING_USD_PER_MILLION: Readonly<
  Record<string, { readonly input: number; readonly output: number }>
> = {
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { input: 1, output: 5 },
  'anthropic.claude-haiku-4-5-20251001-v1:0': { input: 1, output: 5 },
  'us.amazon.nova-micro-v1:0': { input: 0.035, output: 0.14 },
  'amazon.nova-micro-v1:0': { input: 0.035, output: 0.14 },
};

export function resolveBedrockPricing(
  modelId: string,
  config: Pick<AppConfig, 'BEDROCK_INPUT_COST_PER_MILLION' | 'BEDROCK_OUTPUT_COST_PER_MILLION'>,
): { inputPerMillion: number; outputPerMillion: number; pricedAs: 'catalog' | 'env-fallback' } {
  const catalog = BEDROCK_MODEL_PRICING_USD_PER_MILLION[modelId];
  if (catalog) {
    return {
      inputPerMillion: catalog.input,
      outputPerMillion: catalog.output,
      pricedAs: 'catalog',
    };
  }
  return {
    inputPerMillion: config.BEDROCK_INPUT_COST_PER_MILLION,
    outputPerMillion: config.BEDROCK_OUTPUT_COST_PER_MILLION,
    pricedAs: 'env-fallback',
  };
}

export function estimateBedrockCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  config: Pick<AppConfig, 'BEDROCK_INPUT_COST_PER_MILLION' | 'BEDROCK_OUTPUT_COST_PER_MILLION'>,
): number {
  const pricing = resolveBedrockPricing(modelId, config);
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}
