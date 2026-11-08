import { describe, expect, it } from 'vitest';
import { MemoryJobStorage } from '../src/storage.js';
import type { EvaluationRecord } from '../src/ai.js';
import type { MatchResult } from '../src/domain.js';

const evaluation: EvaluationRecord = {
  cacheKey: 'cache',
  evaluation: {
    strengths: [],
    weaknesses: [],
    mustHaveGaps: [],
    remoteEligibility: 'CONFIRMED',
    legitimacySignals: [],
    confidence: 1,
    recommendation: 'Apply',
  },
  inputTokens: 1,
  outputTokens: 1,
  estimatedCostUsd: 0,
  modelId: 'mock',
  createdAt: new Date(0).toISOString(),
};

function match(id: string): MatchResult {
  return {
    job: {
      canonicalId: id,
      companyId: 'acme',
      provider: 'lever',
      externalId: id,
      title: 'Senior Engineer',
      location: 'Remote Canada',
      description: 'TypeScript AWS',
      applyUrl: `https://example.com/${id}`,
      sourceUrl: `https://example.com/${id}`,
      updatedAt: null,
      contentHash: `hash-${id}`,
    },
    score: 90,
    breakdown: {
      skills: 30,
      role: 20,
      seniority: 15,
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
  };
}

describe('notification queue', () => {
  it('deduplicates versions and retains overflow for later batches', async () => {
    const storage = new MemoryJobStorage();
    expect(await storage.queue(match('1'), evaluation, 'default')).toBe(true);
    expect(await storage.queue(match('1'), evaluation, 'default')).toBe(false);
    expect(await storage.queue(match('2'), evaluation, 'default')).toBe(true);
    const first = await storage.claimBatch('default', 1);
    expect(first?.items).toHaveLength(1);
    if (!first) throw new Error('Expected first notification batch');
    await storage.completeBatch(first, 'ses-1');
    const second = await storage.claimBatch('default', 1);
    expect(second?.items).toHaveLength(1);
    expect(second?.items[0]?.match.job.canonicalId).toBe('2');
  });

  it('prevents overlapping leases', async () => {
    const storage = new MemoryJobStorage();
    expect(await storage.acquireLease('one', 60)).toBe(true);
    expect(await storage.acquireLease('two', 60)).toBe(false);
    await storage.releaseLease('one');
    expect(await storage.acquireLease('two', 60)).toBe(true);
  });

  it('expires missing jobs and recognizes a reopened listing', async () => {
    const storage = new MemoryJobStorage();
    const job = match('reopened').job;
    expect((await storage.upsertJob(job)).isNew).toBe(true);
    expect(await storage.markMissingExpired('acme', [])).toBe(1);
    const reopened = await storage.upsertJob(job);
    expect(reopened.isNew).toBe(false);
    expect(await storage.markMissingExpired('acme', [job.canonicalId])).toBe(0);
  });
});
