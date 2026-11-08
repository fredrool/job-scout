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

describe('scan pipeline observability', () => {
  it('emits structured discovery, evaluation, and completion events', async () => {
    const events: Record<string, unknown>[] = [];
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
          sources: [
            {
              companyId: 'acme',
              provider: 'greenhouse',
              healthy: true,
              complete: true,
              status: 'FETCHED',
              checkedAt: new Date().toISOString(),
              latencyMs: 10,
              jobsFound: 1,
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
              description: 'TypeScript AWS production work.',
              applyUrl: 'https://example.com/apply',
              sourceUrl: 'https://example.com/job',
              updatedAt: null,
              contentHash: 'hash-1',
            },
          ],
        }),
      } as unknown as DiscoveryService,
      {
        discover: vi.fn().mockResolvedValue({
          jobs: [],
          sources: [
            {
              companyId: 'marketplace:adzuna',
              provider: 'adzuna',
              healthy: false,
              complete: false,
              status: 'FAILED',
              checkedAt: new Date().toISOString(),
              latencyMs: 20,
              jobsFound: 0,
              error: 'HTTP 502',
              httpStatus: 502,
            },
          ],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      } as unknown as MarketplaceDiscoveryService,
      new MatchingService(),
      {
        resetRun: vi.fn(),
        hasCapacity: vi.fn(() => true),
        getRunStats: vi.fn(() => ({
          apiCalls: 1,
          cacheHits: 0,
          inputTokens: 100,
          outputTokens: 40,
          estimatedCostUsd: 0.0003,
          parseRetries: 0,
        })),
        evaluate: vi.fn().mockResolvedValue({
          cacheKey: 'cache',
          evaluation: {
            strengths: [],
            weaknesses: [],
            mustHaveGaps: [],
            remoteEligibility: 'CONFIRMED',
            legitimacySignals: [],
            fitScore: 92,
            confidence: 0.9,
            recommendation: 'Apply',
          },
          inputTokens: 100,
          outputTokens: 40,
          estimatedCostUsd: 0.0003,
          modelId: 'mock',
          createdAt: new Date().toISOString(),
        }),
      } as unknown as BedrockEvaluator,
      new MemoryJobStorage(),
      { send: vi.fn() } as unknown as SesNotificationService,
      (payload) => events.push(payload),
    );

    const summary = await pipeline.run();

    expect(events.some((event) => event.event === 'scan_started')).toBe(true);
    expect(
      events.some((event) => event.event === 'discovery_source' && event.phase === 'company'),
    ).toBe(true);
    expect(
      events.some((event) => event.event === 'job_evaluated' && event.decision === 'queued'),
    ).toBe(true);
    expect(events.some((event) => event.event === 'scan_completed')).toBe(true);
    expect(summary.scoredAtOrAboveThreshold).toBe(1);
    expect(summary.sourceFailuresByProvider.adzuna).toBe(1);
    expect(summary.dryRunEmailSuppressed).toBe(true);
    expect(summary.qualifyingWouldHaveEmailed).toBe(1);
    expect(summary.scanDurationMs).toBeGreaterThanOrEqual(0);
    expect(summary.bedrockInputTokens).toBe(100);
  });
});
