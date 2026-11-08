import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import type { EvaluationRecord } from '../src/ai.js';
import { evaluationCacheKey } from '../src/evaluation-cache-key.js';
import { listEvaluatedJobsForReview, parseJobsReviewArgs } from '../src/jobs-review.js';
import { MemoryJobStorage } from '../src/storage.js';
import { MatchingService } from '../src/matching.js';
import type { MatchResult, NormalizedJob, SearchProfile } from '../src/domain.js';

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
  USER_ID: 'default',
  BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
} as AppConfig;

function job(id: string, title: string): NormalizedJob {
  return {
    canonicalId: id,
    dedupeKey: id,
    companyId: 'acme',
    provider: 'greenhouse',
    externalId: id,
    title,
    location: 'Remote — Canada',
    description: 'TypeScript, React, and AWS platform work.',
    applyUrl: `https://example.com/${id}/apply`,
    sourceUrl: `https://example.com/${id}`,
    updatedAt: null,
    contentHash: `hash-${id}`,
  };
}

const evaluation: EvaluationRecord = {
  cacheKey: 'cache',
  evaluation: {
    strengths: ['TypeScript'],
    weaknesses: [],
    mustHaveGaps: [],
    remoteEligibility: 'CONFIRMED',
    legitimacySignals: [],
    fitScore: 90,
    confidence: 0.9,
    recommendation: 'Strong fit — apply if Canada engagement is confirmed.',
  },
  inputTokens: 1,
  outputTokens: 1,
  estimatedCostUsd: 0,
  modelId: 'mock',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function matchFor(jobEntity: NormalizedJob, score: number): MatchResult {
  return {
    job: jobEntity,
    score,
    preliminaryScore: 70,
    breakdown: {
      skills: 20,
      role: 20,
      seniority: 10,
      remote: 15,
      compensation: 2,
      interests: 0,
      legitimacy: 10,
      feedback: 0,
    },
    remoteEligibility: 'CONFIRMED',
    reasons: [],
    gaps: [],
    salary: null,
    eligible: true,
    promising: true,
  };
}

describe('jobs review', () => {
  it('parses CLI review flags', () => {
    expect(parseJobsReviewArgs(['--min-score', '60', '--limit', '20', '--eligible-only'])).toEqual({
      minScore: 60,
      limit: 20,
      eligibleOnly: true,
      maxActiveJobs: 500,
      diagnostic: false,
      maxEvaluationCacheEntries: 2_000,
    });
  });

  it('sorts evaluated jobs by final score descending and applies filters', async () => {
    const storage = new MemoryJobStorage();
    const low = job('low', 'Senior Software Engineer');
    const high = job('high', 'Staff Software Engineer');
    await storage.upsertJob(low);
    await storage.upsertJob(high);
    const persist = {
      userId: 'default',
      contentHash: low.contentHash,
      profileVersion: profile.version,
      modelId: config.BEDROCK_MODEL_ID,
    };
    await storage.putEvaluation(
      { ...evaluation, cacheKey: evaluationCacheKey(low, profile, config.BEDROCK_MODEL_ID) },
      { ...persist, jobKey: low.dedupeKey ?? low.canonicalId },
    );
    await storage.putEvaluation(
      {
        ...evaluation,
        cacheKey: evaluationCacheKey(high, profile, config.BEDROCK_MODEL_ID),
        evaluation: { ...evaluation.evaluation, fitScore: 96, recommendation: 'Top pick.' },
      },
      { ...persist, jobKey: high.dedupeKey ?? high.canonicalId, contentHash: high.contentHash },
    );
    await storage.queue(matchFor(high, 92), evaluation, 'default');
    await storage.queue(matchFor(low, 55), evaluation, 'default');

    const result = await listEvaluatedJobsForReview(storage, profile, config, {
      minScore: 60,
      limit: 10,
      eligibleOnly: false,
      maxActiveJobs: 50,
      diagnostic: false,
      maxEvaluationCacheEntries: 500,
    });

    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect(result.rows[0]?.finalScore).toBeGreaterThanOrEqual(result.rows.at(-1)?.finalScore ?? 0);
    expect(result.rows.every((row) => row.finalScore >= 60)).toBe(true);
    expect(result.rows[0]?.title.length).toBeGreaterThan(0);
    expect(result.rows[0]?.recommendation.length).toBeGreaterThan(0);
    expect(result.rows[0]?.jobUrl).toMatch(/^https:\/\//);
  });

  it('joins active jobs with cached evaluations via evaluation cache keys', async () => {
    const storage = new MemoryJobStorage();
    const cachedOnly = job('cached', 'Senior Backend Engineer');
    await storage.upsertJob(cachedOnly);
    const cacheKey = evaluationCacheKey(cachedOnly, profile, config.BEDROCK_MODEL_ID);
    await storage.putEvaluation(
      { ...evaluation, cacheKey },
      {
        userId: 'default',
        jobKey: 'cached',
        contentHash: cachedOnly.contentHash,
        profileVersion: profile.version,
        modelId: config.BEDROCK_MODEL_ID,
      },
    );

    const result = await listEvaluatedJobsForReview(
      storage,
      profile,
      config,
      {
        minScore: 0,
        limit: 5,
        eligibleOnly: false,
        maxActiveJobs: 20,
        diagnostic: false,
        maxEvaluationCacheEntries: 100,
      },
      new MatchingService(),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.jobKey).toBe('cached');
    expect(result.rows[0]?.finalScore).toBeGreaterThan(0);
  });
});
