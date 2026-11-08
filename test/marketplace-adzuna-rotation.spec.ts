import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../src/http-client.js';
import { jobBoardsSchema } from '../src/marketplace-config.js';
import { AdzunaMarketplaceProvider } from '../src/marketplace-providers.js';

describe('Adzuna marketplace rotation', () => {
  it('advances persisted cursor across polls so each combination is eventually queried', async () => {
    const getJson = vi.fn().mockResolvedValue({ count: 0, results: [] });
    const config = jobBoardsSchema.parse({
      providers: [
        {
          provider: 'adzuna',
          enabled: true,
          pollIntervalMinutes: 240,
          countries: ['ca', 'us'],
          searchQueries: ['Role A', 'Role B'],
          regions: ['Canada'],
          maxPagesPerQuery: 1,
          resultsPerPage: 1,
          maxRequestsPerPoll: 1,
          appIdEnv: 'ADZUNA_APP_ID',
          appKeyEnv: 'ADZUNA_APP_KEY',
        },
      ],
    }).providers[0];
    if (config?.provider !== 'adzuna') throw new Error('Expected Adzuna config');
    const provider = new AdzunaMarketplaceProvider({ getJson } as unknown as HttpClient);
    const credentials = { ADZUNA_APP_ID: 'id', ADZUNA_APP_KEY: 'key' };

    const first = await provider.fetch(config, credentials);
    expect(first.nextAdzunaCursor).toEqual({ combinationIndex: 1, page: 1 });
    const firstUrl = String(getJson.mock.calls[0]?.[0]);
    expect(firstUrl).toContain('/jobs/ca/search/1');
    expect(firstUrl).toContain('what=Role+A');

    if (!first.nextAdzunaCursor) throw new Error('Expected Adzuna cursor after first poll');
    const second = await provider.fetch(config, credentials, {
      adzunaCursor: first.nextAdzunaCursor,
    });
    const secondUrl = String(getJson.mock.calls[1]?.[0]);
    expect(secondUrl).toContain('/jobs/ca/search/1');
    expect(secondUrl).toContain('what=Role+B');
    expect(second.nextAdzunaCursor?.combinationIndex).toBe(2);
  });
});
