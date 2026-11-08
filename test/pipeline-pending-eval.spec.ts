import { describe, expect, it, vi } from 'vitest';
import { ScanPipeline } from '../src/pipeline.js';
import { MatchingService } from '../src/matching.js';
import { MemoryJobStorage } from '../src/storage.js';
import type { AppConfig } from '../src/config.js';
import type { DiscoveryService } from '../src/discovery.js';
import type { CompanyRegistry } from '../src/registry.js';
import type { BedrockEvaluator } from '../src/ai.js';
import type { SesNotificationService } from '../src/notifications.js';
import type { SearchProfile } from '../src/domain.js';
import type { MarketplaceDiscoveryService } from '../src/marketplace-discovery.js';

const profile: SearchProfile = {
  version: '1',
  userId: 'default',
  name: 'Profile',
  targetTitles: ['Senior Software Engineer'],
  skills: [
    { name: 'TypeScript', proficiency: 'expert', evidence: 'Production' },
    { name: 'AWS', proficiency: 'expert', evidence: 'Production' },
    { name: 'React', proficiency: 'expert', evidence: 'Production' },
  ],
  workHistorySummary: 'Experienced',
  locations: ['Canada'],
  remoteOnly: true,
  preferredRegions: ['Canada'],
  compensation: { currency: 'CAD' },
  hardExclusions: [],
  learningInterests: ['Bedrock'],
  feedbackPreferences: { rejectionPenalty: 4 },
};

const evaluation = {
  cacheKey: 'cache',
  evaluation: {
    strengths: [],
    weaknesses: [],
    mustHaveGaps: [],
    remoteEligibility: 'CONFIRMED' as const,
    legitimacySignals: [],
    fitScore: 94,
    confidence: 1,
    recommendation: 'Apply',
  },
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0,
  modelId: 'mock',
  createdAt: new Date().toISOString(),
};

function job(id: string) {
  return {
    canonicalId: id,
    dedupeKey: id,
    companyId: 'acme',
    provider: 'greenhouse' as const,
    externalId: id,
    title: 'Senior Software Engineer',
    location: 'Remote Canada',
    description:
      'Build TypeScript services on AWS and collaborate across a product engineering team.',
    applyUrl: `https://example.com/${id}/apply`,
    sourceUrl: `https://example.com/${id}`,
    updatedAt: null,
    contentHash: `hash-${id}`,
  };
}

describe('pending evaluation backlog', () => {
  it('defers promising jobs when the Bedrock cap is reached and evaluates them on the next scan', async () => {
    const values = {
      MAX_RUNTIME_MS: 60_000,
      MAX_REQUESTS_PER_SCAN: 10,
      MAX_JOBS_PER_SCAN: 10,
      MAX_BEDROCK_CALLS_PER_SCAN: 1,
      SCORE_THRESHOLD: 80,
      USER_ID: 'default',
      DIGEST_LIMIT: 25,
      DRY_RUN: true,
      NOTIFICATION_EMAIL: 'alerts@example.com',
    } as AppConfig;
    const storage = new MemoryJobStorage();
    let calls = 0;
    const evaluate = vi.fn().mockImplementation(() => {
      calls += 1;
      return Promise.resolve(evaluation);
    });
    const evaluator = {
      resetRun: vi.fn(),
      hasCapacity: vi.fn(() => calls < values.MAX_BEDROCK_CALLS_PER_SCAN),
      evaluate,
    } as unknown as BedrockEvaluator;

    const discoveryPayload = {
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      sources: [],
      jobs: [job('job-1'), job('job-2')],
    };

    const pipeline = new ScanPipeline(
      { values },
      {
        load: vi.fn().mockResolvedValue({ companies: [] }),
        loadProfile: vi.fn().mockResolvedValue(profile),
      } as unknown as CompanyRegistry,
      {
        discover: vi.fn().mockResolvedValue(discoveryPayload),
      } as unknown as DiscoveryService,
      {
        discover: vi.fn().mockResolvedValue({
          jobs: [],
          sources: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      } as unknown as MarketplaceDiscoveryService,
      new MatchingService(),
      evaluator,
      storage,
      { send: vi.fn() } as unknown as SesNotificationService,
    );

    const first = await pipeline.run();
    expect(first.evaluated).toBe(1);
    expect(first.pendingDeferred).toBe(1);
    expect(
      (await storage.listPendingEvaluations('default', 10)).map((item) => item.jobKey),
    ).toEqual(['job-2']);

    calls = 0;
    const unchangedDiscovery = {
      ...discoveryPayload,
    };

    const secondPipeline = new ScanPipeline(
      { values },
      {
        load: vi.fn().mockResolvedValue({ companies: [] }),
        loadProfile: vi.fn().mockResolvedValue(profile),
      } as unknown as CompanyRegistry,
      {
        discover: vi.fn().mockResolvedValue(unchangedDiscovery),
      } as unknown as DiscoveryService,
      {
        discover: vi.fn().mockResolvedValue({
          jobs: [],
          sources: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      } as unknown as MarketplaceDiscoveryService,
      new MatchingService(),
      evaluator,
      storage,
      { send: vi.fn() } as unknown as SesNotificationService,
    );

    const second = await secondPipeline.run();
    expect(second.pendingProcessed).toBe(1);
    expect(second.evaluated).toBe(1);
    expect(await storage.listPendingEvaluations('default', 10)).toHaveLength(0);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('keeps pending evaluations after transient Bedrock failures', async () => {
    const values = {
      MAX_RUNTIME_MS: 60_000,
      MAX_REQUESTS_PER_SCAN: 10,
      MAX_JOBS_PER_SCAN: 10,
      MAX_BEDROCK_CALLS_PER_SCAN: 5,
      SCORE_THRESHOLD: 80,
      USER_ID: 'default',
      DIGEST_LIMIT: 25,
      DRY_RUN: true,
      NOTIFICATION_EMAIL: 'alerts@example.com',
    } as AppConfig;
    const storage = new MemoryJobStorage();
    const evaluate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Bedrock evaluation failed'))
      .mockResolvedValueOnce(evaluation);

    const pipeline = new ScanPipeline(
      { values },
      {
        load: vi.fn().mockResolvedValue({ companies: [] }),
        loadProfile: vi.fn().mockResolvedValue(profile),
      } as unknown as CompanyRegistry,
      {
        discover: vi.fn().mockResolvedValue({
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          sources: [],
          jobs: [job('job-err')],
        }),
      } as unknown as DiscoveryService,
      {
        discover: vi.fn().mockResolvedValue({
          jobs: [],
          sources: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      } as unknown as MarketplaceDiscoveryService,
      new MatchingService(),
      {
        resetRun: vi.fn(),
        hasCapacity: vi.fn(() => true),
        evaluate,
      } as unknown as BedrockEvaluator,
      storage,
      { send: vi.fn() } as unknown as SesNotificationService,
    );

    const first = await pipeline.run();
    expect(first.evaluated).toBe(0);
    expect(first.pendingDeferred).toBe(1);
    const pending = await storage.listPendingEvaluations('default', 10);
    expect(pending[0]?.attempts).toBe(1);

    const second = await pipeline.run();
    expect(second.pendingProcessed).toBe(1);
    expect(second.evaluated).toBe(1);
  });
});
