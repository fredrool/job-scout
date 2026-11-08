import { describe, expect, it, vi } from 'vitest';
import type { NormalizedJob } from '../src/domain.js';
import { jobBoardsSchema, type JobBoardsRegistry } from '../src/marketplace-config.js';
import { deduplicateJobs, MarketplaceDiscoveryService } from '../src/marketplace-discovery.js';
import type { MarketplaceProvider } from '../src/marketplace-providers.js';
import { MemoryJobStorage } from '../src/storage.js';

function job(
  provider: 'adzuna' | 'remotive' | 'greenhouse',
  kind: 'MARKETPLACE' | 'EMPLOYER',
): NormalizedJob {
  const url =
    kind === 'EMPLOYER'
      ? 'https://boards.greenhouse.io/acme/jobs/123'
      : `https://example.com/${provider}/123`;
  return {
    canonicalId: `${provider}:123`,
    dedupeKey: 'same-role',
    companyId: 'acme',
    companyName: 'Acme',
    provider,
    externalId: '123',
    title: 'Senior Software Engineer',
    location: 'Remote Canada',
    description: 'Build TypeScript services on AWS.',
    sourceUrl: url,
    applyUrl: url,
    sourceName: provider,
    sourceKind: kind,
    sourceUrls: [
      {
        provider,
        url,
        kind: kind === 'EMPLOYER' ? 'ORIGINAL' : 'AGGREGATOR',
      },
    ],
    updatedAt: null,
    contentHash: `hash-${provider}`,
  };
}

describe('marketplace discovery', () => {
  it('prefers an employer posting while preserving every marketplace URL', () => {
    const result = deduplicateJobs([
      job('adzuna', 'MARKETPLACE'),
      job('remotive', 'MARKETPLACE'),
      job('greenhouse', 'EMPLOYER'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.provider).toBe('greenhouse');
    expect(result[0]?.sourceKind).toBe('EMPLOYER');
    expect(result[0]?.sourceUrls).toHaveLength(3);
  });

  it('honors persisted polling intervals and isolates provider failures', async () => {
    const config = jobBoardsSchema.parse({
      providers: [
        {
          provider: 'remotive',
          enabled: true,
          pollIntervalMinutes: 360,
          category: 'software-dev',
          attributionRequired: true,
          regions: ['Worldwide'],
          searchQueries: ['Senior Software Engineer'],
          maxPagesPerQuery: 1,
          resultsPerPage: 100,
          maxRequestsPerPoll: 1,
        },
        {
          provider: 'adzuna',
          enabled: true,
          pollIntervalMinutes: 240,
          appIdEnv: 'TEST_ADZUNA_ID',
          appKeyEnv: 'TEST_ADZUNA_KEY',
          countries: ['ca'],
          regions: ['Canada'],
          searchQueries: ['Senior Software Engineer'],
          maxPagesPerQuery: 1,
          resultsPerPage: 20,
          maxRequestsPerPoll: 1,
        },
      ],
    });
    const storage = new MemoryJobStorage();
    await storage.putProviderState({
      provider: 'remotive',
      lastFetchAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      status: 'SUCCESS',
      requestsMade: 1,
    });
    const remotiveFetch = vi.fn();
    const adzunaFetch = vi.fn().mockRejectedValue(new Error('quota exceeded'));
    process.env.TEST_ADZUNA_ID = 'id';
    process.env.TEST_ADZUNA_KEY = 'key';
    const service = new MarketplaceDiscoveryService(
      [
        { kind: 'remotive', fetch: remotiveFetch },
        { kind: 'adzuna', fetch: adzunaFetch },
      ] as unknown as MarketplaceProvider[],
      { load: vi.fn().mockResolvedValue(config) } as unknown as JobBoardsRegistry,
      storage,
    );

    const result = await service.discover();

    expect(remotiveFetch).not.toHaveBeenCalled();
    expect(adzunaFetch).toHaveBeenCalledOnce();
    expect(result.sources.map((source) => source.status)).toEqual(['SKIPPED_INTERVAL', 'FAILED']);
    expect(result.jobs).toEqual([]);
    delete process.env.TEST_ADZUNA_ID;
    delete process.env.TEST_ADZUNA_KEY;
  });
});
