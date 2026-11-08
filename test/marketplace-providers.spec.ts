import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../src/http-client.js';
import { jobBoardsSchema } from '../src/marketplace-config.js';
import {
  AdzunaMarketplaceProvider,
  JoobleMarketplaceProvider,
  RemotiveMarketplaceProvider,
} from '../src/marketplace-providers.js';

const common = {
  enabled: true,
  pollIntervalMinutes: 240,
  searchQueries: ['Senior Software Engineer'],
  regions: ['Canada'],
  maxPagesPerQuery: 2,
  resultsPerPage: 1,
  maxRequestsPerPoll: 2,
};

describe('marketplace providers', () => {
  it('paginates Adzuna and labels aggregator-only links accurately', async () => {
    const getJson = vi
      .fn()
      .mockResolvedValueOnce({
        count: 2,
        results: [
          {
            id: 'a1',
            title: 'Senior Software Engineer',
            description: 'Remote product engineering in Canada',
            redirect_url: 'https://www.adzuna.ca/details/a1',
            company: { display_name: 'Acme Inc.' },
            location: { display_name: 'Remote Canada' },
          },
        ],
      })
      .mockResolvedValueOnce({
        count: 2,
        results: [
          {
            id: 'a2',
            title: 'Staff Software Engineer',
            redirect_url: 'https://www.adzuna.ca/details/a2',
            company: { display_name: 'Beta Corp' },
            location: { display_name: 'Remote' },
          },
        ],
      });
    const config = jobBoardsSchema.parse({
      providers: [
        {
          ...common,
          provider: 'adzuna',
          countries: ['ca'],
          appIdEnv: 'ADZUNA_APP_ID',
          appKeyEnv: 'ADZUNA_APP_KEY',
        },
      ],
    }).providers[0];
    if (config?.provider !== 'adzuna') throw new Error('Expected Adzuna config');
    const provider = new AdzunaMarketplaceProvider({ getJson } as unknown as HttpClient);

    const result = await provider.fetch(config, {
      ADZUNA_APP_ID: 'id',
      ADZUNA_APP_KEY: 'key',
    });

    expect(getJson).toHaveBeenCalledTimes(2);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs[0]).toMatchObject({
      sourceName: 'Adzuna',
      sourceKind: 'MARKETPLACE',
      sourceUrl: 'https://www.adzuna.ca/details/a1',
      applyUrl: 'https://www.adzuna.ca/details/a1',
    });
    expect(result.attribution).toBe('Jobs by Adzuna');
  });

  it('fetches Remotive once and filters role families locally', async () => {
    const getJson = vi.fn().mockResolvedValue({
      'job-count': 2,
      jobs: [
        {
          id: 1,
          url: 'https://remotive.com/remote-jobs/software-dev/senior-react-engineer-1',
          title: 'Senior React Engineer',
          company_name: 'Remote Co',
          candidate_required_location: 'Worldwide',
          description: 'Build React products.',
        },
        {
          id: 2,
          url: 'https://remotive.com/remote-jobs/customer-support/support-2',
          title: 'Customer Support Representative',
          company_name: 'Support Co',
          description: 'Answer customer questions.',
        },
      ],
    });
    const config = jobBoardsSchema.parse({
      providers: [
        {
          ...common,
          provider: 'remotive',
          pollIntervalMinutes: 360,
          searchQueries: ['Senior Software Engineer', 'Senior React Frontend Engineer'],
          category: 'software-dev',
          attributionRequired: true,
          maxRequestsPerPoll: 1,
        },
      ],
    }).providers[0];
    if (config?.provider !== 'remotive') throw new Error('Expected Remotive config');
    const provider = new RemotiveMarketplaceProvider({ getJson } as unknown as HttpClient);

    const result = await provider.fetch(config);

    expect(getJson).toHaveBeenCalledOnce();
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.sourceName).toBe('Remotive');
    expect(result.attribution).toBe('Jobs by Remotive');
  });

  it('implements quota-bounded Jooble POST pagination while remaining configurable', async () => {
    const postJson = vi
      .fn()
      .mockResolvedValueOnce({
        totalCount: 2,
        jobs: [
          {
            id: 1,
            title: 'Senior Backend Engineer',
            location: 'Canada',
            link: 'https://jooble.org/desc/1',
            company: 'Acme',
          },
        ],
      })
      .mockResolvedValueOnce({
        totalCount: 2,
        jobs: [
          {
            id: 2,
            title: 'Senior Platform Engineer',
            location: 'Remote',
            link: 'https://jooble.org/desc/2',
            company: 'Beta',
          },
        ],
      });
    const config = jobBoardsSchema.parse({
      providers: [
        {
          ...common,
          provider: 'jooble',
          enabled: false,
          pollIntervalMinutes: 1440,
          apiKeyEnv: 'JOOBLE_API_KEY',
          endpoint: 'https://jooble.org/api',
          lifetimeRequestQuota: 500,
        },
      ],
    }).providers[0];
    if (config?.provider !== 'jooble') throw new Error('Expected Jooble config');
    const provider = new JoobleMarketplaceProvider({ postJson } as unknown as HttpClient);

    const result = await provider.fetch(config, { JOOBLE_API_KEY: 'key' });

    expect(postJson).toHaveBeenCalledTimes(2);
    expect(result.requestsMade).toBe(2);
    expect(result.jobs).toHaveLength(2);
  });
});
