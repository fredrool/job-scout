import { describe, expect, it } from 'vitest';
import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import {
  collectConverseText,
  extractJsonObject,
  parseConverseEvaluation,
} from '../src/bedrock-response.js';
import { truncateRecommendation } from '../src/domain.js';

const basePayload = {
  strengths: ['Stack match'],
  weaknesses: [],
  mustHaveGaps: [],
  remoteEligibility: 'CONFIRMED',
  legitimacySignals: ['HTTPS listing'],
  fitScore: 88,
  confidence: 0.9,
};

describe('bedrock response parsing', () => {
  it('joins multiple text blocks and parses fenced JSON', () => {
    const payload = JSON.stringify({ ...basePayload, recommendation: 'Apply' });
    const output = {
      stopReason: 'end_turn',
      output: {
        message: {
          content: [{ text: 'Summary:\n' }, { text: `\`\`\`json\n${payload}\n\`\`\`` }],
        },
      },
    } as ConverseCommandOutput;

    expect(collectConverseText(output)).toContain('fitScore');
    const parsed = parseConverseEvaluation(output);
    expect(parsed.evaluation.fitScore).toBe(88);
  });

  it('extracts the first balanced JSON object from surrounding prose', () => {
    const inner = JSON.stringify({ ...basePayload, recommendation: 'Strong fit' });
    const text = `Here is the evaluation:\n${inner}\nThanks.`;
    expect(extractJsonObject(text)).toBe(inner);
    const output = {
      output: { message: { content: [{ text }] } },
    } as ConverseCommandOutput;
    expect(parseConverseEvaluation(output).evaluation.recommendation).toBe('Strong fit');
  });

  it('truncates an overly long recommendation instead of rejecting the evaluation', () => {
    const long = 'x'.repeat(900);
    const output = {
      output: {
        message: {
          content: [
            {
              text: JSON.stringify({
                ...basePayload,
                recommendation: long,
              }),
            },
          ],
        },
      },
    } as ConverseCommandOutput;
    const parsed = parseConverseEvaluation(output);
    expect(parsed.evaluation.recommendation.length).toBe(800);
    expect(parsed.evaluation.recommendation.endsWith('...')).toBe(true);
    expect(truncateRecommendation(long)).toBe(parsed.evaluation.recommendation);
  });
});
