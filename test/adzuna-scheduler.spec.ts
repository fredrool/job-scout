import { describe, expect, it } from 'vitest';
import { buildAdzunaCombinations, planAdzunaRequests } from '../src/adzuna-scheduler.js';
import { jobBoardsSchema } from '../src/marketplace-config.js';

describe('Adzuna scheduler', () => {
  it('round-robins country and query combinations within the request budget', () => {
    const config = jobBoardsSchema.parse({
      providers: [
        {
          provider: 'adzuna',
          enabled: true,
          pollIntervalMinutes: 240,
          countries: ['ca', 'us'],
          searchQueries: ['Engineer A', 'Engineer B'],
          regions: ['Canada'],
          maxPagesPerQuery: 3,
          resultsPerPage: 1,
          maxRequestsPerPoll: 2,
          appIdEnv: 'ADZUNA_APP_ID',
          appKeyEnv: 'ADZUNA_APP_KEY',
        },
      ],
    }).providers[0];
    if (config?.provider !== 'adzuna') throw new Error('Expected Adzuna config');

    const combinations = buildAdzunaCombinations(config.countries, config.searchQueries);
    expect(combinations).toEqual([
      { country: 'ca', query: 'Engineer A' },
      { country: 'ca', query: 'Engineer B' },
      { country: 'us', query: 'Engineer A' },
      { country: 'us', query: 'Engineer B' },
    ]);

    const first = planAdzunaRequests(config);
    expect(first.requests).toEqual([
      { country: 'ca', query: 'Engineer A', page: 1 },
      { country: 'ca', query: 'Engineer A', page: 2 },
    ]);

    const second = planAdzunaRequests(config, first.nextCursor);
    expect(second.requests[0]).toEqual({ country: 'ca', query: 'Engineer A', page: 3 });
    expect(second.requests[1]).toEqual({ country: 'ca', query: 'Engineer B', page: 1 });
  });
});
