import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Company } from '../src/domain.js';
import { HttpClient } from '../src/http-client.js';
import {
  AshbyProvider,
  GreenhouseProvider,
  JsonFeedProvider,
  LeverProvider,
} from '../src/providers.js';

class FixtureHttpClient extends HttpClient {
  constructor(private readonly payload: unknown) {
    super();
  }

  override getJson<T>(): Promise<T> {
    return Promise.resolve(this.payload as T);
  }
}

async function fixture(name: string): Promise<unknown> {
  const contents = await readFile(join(process.cwd(), 'test', 'fixtures', name), 'utf8');
  return JSON.parse(contents) as unknown;
}

function hostedCompany(provider: 'greenhouse' | 'lever' | 'ashby'): Company {
  return {
    id: `example-${provider}`,
    name: 'Example Company',
    enabled: true,
    careersUrl:
      provider === 'greenhouse'
        ? 'https://boards.greenhouse.io/example'
        : provider === 'lever'
          ? 'https://jobs.lever.co/example'
          : 'https://jobs.ashbyhq.com/example',
    provider,
    boardToken: 'example',
  };
}

describe('hosted ATS providers', () => {
  it.each([
    ['greenhouse', GreenhouseProvider, 'greenhouse.json', '101'],
    ['lever', LeverProvider, 'lever.json', 'lever-201'],
    ['ashby', AshbyProvider, 'ashby.json', 'ashby-301'],
  ] as const)('maps a %s response', async (kind, Provider, filename, expectedId) => {
    const adapter = new Provider(new FixtureHttpClient(await fixture(filename)));
    const result = await adapter.fetchJobs(hostedCompany(kind));
    const jobs = result.jobs;

    expect(jobs).toHaveLength(1);
    expect(result.complete).toBe(true);
    expect(jobs[0]).toMatchObject({ externalId: expectedId });
    expect(jobs[0]?.applyUrl).toMatch(/^https:/);
  });
});

describe('configurable JSON provider', () => {
  it('maps nested fields from an official feed', async () => {
    const adapter = new JsonFeedProvider(
      new FixtureHttpClient(await fixture('official-feed.json')),
    );
    const result = await adapter.fetchJobs({
      id: 'example-json',
      name: 'Example Feed Company',
      enabled: true,
      careersUrl: 'https://careers.example.com/jobs',
      provider: 'json',
      feedUrl: 'https://careers.example.com/jobs.json',
      feedMapping: {
        jobsPath: 'results',
        id: 'job.id',
        title: 'job.title',
        applyUrl: 'links.apply',
        sourceUrl: 'links.details',
        location: 'office.label',
        description: 'body',
        updatedAt: 'modified',
      },
    });

    expect(result.complete).toBe(true);
    expect(result.jobs).toEqual([
      {
        externalId: '401',
        title: 'Data Engineer',
        applyUrl: 'https://careers.example.com/jobs/401/apply',
        sourceUrl: 'https://careers.example.com/jobs/401',
        location: 'Remote',
        description: 'Build data systems.',
        updatedAt: '2026-01-04T00:00:00Z',
      },
    ]);
  });
});
