import { describe, expect, it, vi } from 'vitest';
import type { BedrockEvaluator, EvaluationRecord } from '../src/ai.js';
import { compareBedrockModels, selectBaselineEvaluations } from '../src/bedrock-model-compare.js';
import type { AppConfig } from '../src/config.js';
import type { SearchProfile } from '../src/domain.js';
import { MemoryJobStorage } from '../src/storage.js';
import { MatchingService } from '../src/matching.js';

const profile: SearchProfile = {
  version: '1',
  userId: 'default',
  name: 'Profile',
  targetTitles: ['Senior Software Engineer'],
  skills: [{ name: 'TypeScript', proficiency: 'expert', evidence: 'Production' }],
  workHistorySummary: 'Experienced',
  locations: ['Canada'],
  remoteOnly: true,
  preferredRegions: ['Canada'],
  compensation: { currency: 'CAD' },
  hardExclusions: [],
  learningInterests: [],
  feedbackPreferences: { rejectionPenalty: 4 },
};

const config = {
  BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  BEDROCK_INPUT_COST_PER_MILLION: 1,
  BEDROCK_OUTPUT_COST_PER_MILLION: 5,
} as AppConfig;

const baselineRecord: EvaluationRecord = {
  cacheKey: 'baseline',
  evaluation: {
    strengths: ['TypeScript'],
    weaknesses: [],
    mustHaveGaps: [],
    remoteEligibility: 'CONFIRMED',
    legitimacySignals: [],
    fitScore: 88,
    confidence: 0.9,
    recommendation: 'Strong fit.',
  },
  inputTokens: 900,
  outputTokens: 120,
  estimatedCostUsd: 0.0015,
  modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  createdAt: '2026-03-01T00:00:00.000Z',
};

describe('bedrock model compare', () => {
  it('selects cached Haiku evaluations for baseline comparison', () => {
    const map = new Map([
      [
        'a',
        {
          cacheKey: 'a',
          record: baselineRecord,
          jobKey: 'job-a',
        },
      ],
      [
        'b',
        {
          cacheKey: 'b',
          record: { ...baselineRecord, modelId: 'us.amazon.nova-micro-v1:0' },
          jobKey: 'job-b',
        },
      ],
    ]);
    const selected = selectBaselineEvaluations(
      map,
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      10,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.jobKey).toBe('job-a');
  });

  it('compares without writing cache or queue records', async () => {
    const storage = new MemoryJobStorage();
    const putEvaluation = vi.spyOn(storage, 'putEvaluation');
    const queue = vi.spyOn(storage, 'queue');
    await storage.upsertJob({
      canonicalId: 'job-a',
      dedupeKey: 'job-a',
      companyId: 'acme',
      provider: 'greenhouse',
      externalId: '1',
      title: 'Senior Engineer',
      location: 'Remote — Canada',
      description: 'TypeScript and AWS',
      applyUrl: 'https://example.com/apply',
      sourceUrl: 'https://example.com/job',
      updatedAt: null,
      contentHash: 'hash-a',
    });
    await storage.putEvaluation(baselineRecord, {
      userId: 'default',
      jobKey: 'job-a',
      contentHash: 'hash-a',
      profileVersion: profile.version,
      modelId: baselineRecord.modelId,
    });
    putEvaluation.mockClear();

    const evaluateProbe = vi.fn().mockResolvedValue({
      record: {
        ...baselineRecord,
        modelId: 'us.amazon.nova-micro-v1:0',
        evaluation: { ...baselineRecord.evaluation, fitScore: 80, remoteEligibility: 'POSSIBLE' },
        inputTokens: 400,
        outputTokens: 90,
        estimatedCostUsd: 0.000026,
      },
      latencyMs: 320,
      parseAttempts: 1,
      apiCalls: 1,
    });
    const evaluator = { evaluateProbe } as unknown as BedrockEvaluator;

    const report = await compareBedrockModels(
      storage,
      profile,
      config,
      evaluator,
      { limit: 5, compareModelId: 'us.amazon.nova-micro-v1:0' },
      new MatchingService(),
    );

    expect(report.readOnly).toBe(true);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.remoteChanged).toBe(true);
    expect(report.remoteEligibilityChanges).toBe(1);
    expect(evaluateProbe).toHaveBeenCalledOnce();
    expect(putEvaluation).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });

  it('records invalid JSON failures without mutating storage', async () => {
    const storage = new MemoryJobStorage();
    await storage.upsertJob({
      canonicalId: 'job-a',
      dedupeKey: 'job-a',
      companyId: 'acme',
      provider: 'greenhouse',
      externalId: '1',
      title: 'Senior Engineer',
      location: 'Remote — Canada',
      description: 'TypeScript and AWS',
      applyUrl: 'https://example.com/apply',
      sourceUrl: 'https://example.com/job',
      updatedAt: null,
      contentHash: 'hash-a',
    });
    await storage.putEvaluation(baselineRecord, {
      userId: 'default',
      jobKey: 'job-a',
      contentHash: 'hash-a',
      profileVersion: profile.version,
      modelId: baselineRecord.modelId,
    });

    const evaluator = {
      evaluateProbe: vi.fn().mockRejectedValue(new Error('Bedrock returned invalid JSON')),
    } as unknown as BedrockEvaluator;

    const report = await compareBedrockModels(storage, profile, config, evaluator, { limit: 3 });

    expect(report.failures).toBe(1);
    expect(report.invalidJsonResponses).toBe(1);
    expect(report.rows[0]?.compareFinalScore).toBeNull();
  });
});
