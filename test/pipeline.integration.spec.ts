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

describe('ScanPipeline integration', () => {
  it('isolates source failure, queues a qualifying job, and sends one batch', async () => {
    const values = {
      MAX_RUNTIME_MS: 60_000,
      MAX_REQUESTS_PER_SCAN: 10,
      MAX_JOBS_PER_SCAN: 10,
      SCORE_THRESHOLD: 80,
      USER_ID: 'default',
      DIGEST_LIMIT: 25,
      DRY_RUN: false,
      NOTIFICATION_EMAIL: 'alerts@example.com',
    } as AppConfig;
    const registry = {
      load: vi.fn().mockResolvedValue({ companies: [] }),
      loadProfile: vi.fn().mockResolvedValue(profile),
    } as unknown as CompanyRegistry;
    const discovery = {
      discover: vi.fn().mockResolvedValue({
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        sources: [
          {
            companyId: 'broken',
            provider: 'lever',
            healthy: false,
            complete: false,
            checkedAt: new Date().toISOString(),
            latencyMs: 1,
          },
        ],
        jobs: [
          {
            canonicalId: 'job-1',
            companyId: 'acme',
            provider: 'greenhouse',
            externalId: '1',
            title: 'Senior Software Engineer',
            location: 'Remote Canada',
            description:
              'Build TypeScript services on AWS and collaborate across a product engineering team.',
            applyUrl: 'https://example.com/job-1/apply',
            sourceUrl: 'https://example.com/job-1',
            updatedAt: null,
            contentHash: 'hash-1',
          },
        ],
      }),
    } as unknown as DiscoveryService;
    const evaluate = vi.fn().mockResolvedValue({
      cacheKey: 'cache',
      evaluation: {
        strengths: [],
        weaknesses: [],
        mustHaveGaps: [],
        remoteEligibility: 'CONFIRMED',
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
    });
    const evaluator = {
      resetRun: vi.fn(),
      evaluate,
    } as unknown as BedrockEvaluator;
    const send = vi.fn().mockResolvedValue('ses-id');
    const pipeline = new ScanPipeline(
      { values },
      registry,
      discovery,
      new MatchingService(),
      evaluator,
      new MemoryJobStorage(),
      { send } as unknown as SesNotificationService,
    );
    const result = await pipeline.run();
    expect(result.sourceFailures).toBe(1);
    expect(evaluate).toHaveBeenCalledOnce();
    expect(result.queued).toBe(1);
    expect(result.emailed).toBe(1);
    expect(send).toHaveBeenCalledWith(expect.anything(), 'alerts@example.com');
  });

  it('does not expire jobs after an incomplete provider result', async () => {
    const values = {
      MAX_RUNTIME_MS: 60_000,
      MAX_REQUESTS_PER_SCAN: 10,
      MAX_JOBS_PER_SCAN: 10,
      SCORE_THRESHOLD: 80,
      USER_ID: 'default',
      DIGEST_LIMIT: 25,
      DRY_RUN: true,
      NOTIFICATION_EMAIL: 'alerts@example.com',
    } as AppConfig;
    const storage = new MemoryJobStorage();
    const expire = vi.spyOn(storage, 'markMissingExpired');
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
          jobs: [],
          sources: [
            {
              companyId: 'truncated-source',
              provider: 'greenhouse',
              healthy: true,
              complete: false,
              checkedAt: new Date().toISOString(),
              latencyMs: 10,
              jobsFound: 100,
            },
          ],
        }),
      } as unknown as DiscoveryService,
      new MatchingService(),
      { resetRun: vi.fn(), evaluate: vi.fn() } as unknown as BedrockEvaluator,
      storage,
      { send: vi.fn() } as unknown as SesNotificationService,
    );

    await pipeline.run();

    expect(expire).not.toHaveBeenCalled();
  });
});
