import { describe, expect, it, vi } from 'vitest';
import { AshbyProvider, GreenhouseProvider, LeverProvider } from '../src/providers.js';
import type { HttpClient } from '../src/http-client.js';

describe('hosted ATS provider construction', () => {
  it('wires HttpClient the same way DiscoveryModule factories do', async () => {
    const getJson = vi.fn().mockResolvedValue({ jobs: [] });
    const http = { getJson } as unknown as HttpClient;
    const ashby = new AshbyProvider(http);
    await ashby.fetchJobs({
      id: 'nango',
      name: 'Nango',
      enabled: true,
      careersUrl: 'https://jobs.ashbyhq.com/nango',
      provider: 'ashby',
      boardToken: 'nango',
    });
    expect(getJson).toHaveBeenCalledOnce();
    expect(new GreenhouseProvider(http)).toBeInstanceOf(GreenhouseProvider);
    expect(new LeverProvider(http)).toBeInstanceOf(LeverProvider);
  });
});
