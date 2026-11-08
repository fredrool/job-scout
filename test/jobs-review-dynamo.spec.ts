import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import type { EvaluationRecord } from '../src/ai.js';
import { evaluationCacheKey } from '../src/evaluation-cache-key.js';
import { evaluationKeysForJob, listEvaluatedJobsForReview } from '../src/jobs-review.js';
import { MemoryJobStorage } from '../src/storage.js';
import { MatchingService } from '../src/matching.js';
import type { NormalizedJob, SearchProfile } from '../src/domain.js';

const profileV2: SearchProfile = {
  version: '2',
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
  USER_ID: 'prod-user',
  BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  MOCK_MODE: false,
  DYNAMODB_TABLE_NAME: 'job-scout-prod',
  AWS_REGION: 'us-east-1',
} as AppConfig;

function realisticJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    canonicalId: 'askable:senior-engineer',
    dedupeKey: 'askable:senior-engineer',
    companyId: 'askable',
    provider: 'greenhouse',
    externalId: '123',
    title: 'Senior Software Engineer',
    location: 'Remote — Canada',
    description: 'TypeScript platform work for distributed systems.',
    applyUrl: 'https://jobs.askable.com/o/senior-engineer',
    sourceUrl: 'https://jobs.askable.com/o/senior-engineer',
    updatedAt: '2026-03-01T12:00:00.000Z',
    contentHash: 'a1b2c3d4e5',
    ...overrides,
  };
}

const evaluationRecord = (cacheKey: string, fitScore: number): EvaluationRecord => ({
  cacheKey,
  evaluation: {
    strengths: ['TypeScript'],
    weaknesses: [],
    mustHaveGaps: [],
    remoteEligibility: 'CONFIRMED',
    legitimacySignals: ['HTTPS careers site'],
    fitScore,
    confidence: 0.88,
    recommendation: 'Strong match for senior IC role.',
  },
  inputTokens: 1200,
  outputTokens: 220,
  estimatedCostUsd: 0.002,
  modelId: config.BEDROCK_MODEL_ID,
  createdAt: '2026-03-02T04:15:00.000Z',
});

/** Dynamo-shaped EVAL# item (PK/SK/GSI attributes as Lambda persists them). */
function dynamoEvalItem(job: NormalizedJob, profileVersion: string) {
  const cacheKey = evaluationCacheKey(job, { version: profileVersion }, config.BEDROCK_MODEL_ID);
  const record = evaluationRecord(cacheKey, 88);
  return {
    PK: `EVAL#${cacheKey}`,
    SK: 'EVALUATION',
    record,
    jobKey: job.dedupeKey,
    contentHash: job.contentHash,
    profileVersion,
    modelId: config.BEDROCK_MODEL_ID,
    GSI3PK: `EVALREVIEW#${config.USER_ID}`,
    GSI3SK: `${record.createdAt}#${job.dedupeKey ?? job.canonicalId}`,
  };
}

describe('jobs review dynamo persistence shapes', () => {
  it('resolves cache keys when local profile version differs from Lambda evaluation', () => {
    const job = realisticJob();
    const lambdaItem = dynamoEvalItem(job, '1');
    const keys = evaluationKeysForJob(job, profileV2, config, {
      cacheKey: lambdaItem.record.cacheKey,
      record: lambdaItem.record,
      jobKey: job.dedupeKey ?? job.canonicalId,
      contentHash: job.contentHash,
      profileVersion: '1',
      modelId: config.BEDROCK_MODEL_ID,
    });
    expect(keys).toContain(lambdaItem.record.cacheKey);
  });

  it('lists sub-threshold evaluations via EVALREVIEW index and active job join', async () => {
    const storage = new MemoryJobStorage();
    const job = realisticJob();
    const lambdaItem = dynamoEvalItem(job, '1');

    await storage.upsertJob(job);
    await storage.putEvaluation(lambdaItem.record, {
      userId: config.USER_ID,
      jobKey: job.dedupeKey ?? job.canonicalId,
      contentHash: job.contentHash,
      profileVersion: '1',
      modelId: config.BEDROCK_MODEL_ID,
    });

    const result = await listEvaluatedJobsForReview(
      storage,
      profileV2,
      config,
      {
        minScore: 60,
        limit: 10,
        eligibleOnly: false,
        maxActiveJobs: 100,
        diagnostic: true,
        maxEvaluationCacheEntries: 50,
      },
      new MatchingService(),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.title).toBe(job.title);
    expect(result.rows[0]?.finalScore).toBeGreaterThanOrEqual(60);
    expect(result.diagnostics?.inspected.indexedEvaluations).toBe(1);
    expect(result.diagnostics?.storageBackend).toBe('memory');
    expect(result.diagnostics?.dynamodbTableName).toBe('job-scout-prod');
  });

  it('does not match GSI3 SCORE# alone for jobs below notification threshold', async () => {
    const storage = new MemoryJobStorage();
    const job = realisticJob({ dedupeKey: 'fluence:backend', canonicalId: 'fluence:backend' });
    const cacheKey = evaluationCacheKey(job, { version: '1' }, config.BEDROCK_MODEL_ID);
    await storage.upsertJob(job);
    await storage.putEvaluation(evaluationRecord(cacheKey, 70), {
      userId: config.USER_ID,
      jobKey: job.dedupeKey ?? job.canonicalId,
      contentHash: job.contentHash,
      profileVersion: '1',
      modelId: config.BEDROCK_MODEL_ID,
    });

    const withoutQueue = await listEvaluatedJobsForReview(storage, profileV2, config, {
      minScore: 60,
      limit: 5,
      eligibleOnly: false,
      maxActiveJobs: 50,
      diagnostic: false,
      maxEvaluationCacheEntries: 50,
    });
    expect(withoutQueue.rows).toHaveLength(1);
    expect(withoutQueue.rows[0]?.finalScore).toBeGreaterThanOrEqual(60);
  });
});
