import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { registrySchema, type Company } from '../src/domain.js';
import { AshbyProvider } from '../src/providers.js';
import type { HttpClient } from '../src/http-client.js';

async function configuredAshbyBoards(): Promise<Company[]> {
  const raw = await readFile(join(process.cwd(), 'config', 'companies.yaml'), 'utf8');
  const document = registrySchema.parse(parse(raw));
  return document.companies.filter(
    (company) => company.enabled && company.provider === 'ashby' && company.boardToken,
  );
}

describe('configured Ashby boards', () => {
  it('registers every enabled Ashby company from companies.yaml', async () => {
    const boards = await configuredAshbyBoards();
    expect(boards.map((board) => board.id).sort()).toEqual([
      'ashby',
      'linear',
      'nango',
      'plotly',
      'reflow',
    ]);
  });

  it('fetches each configured Ashby board with an injected HttpClient', async () => {
    const boards = await configuredAshbyBoards();
    for (const company of boards) {
      const token = company.boardToken ?? company.id;
      const getJson = vi.fn().mockResolvedValue({
        jobs: [
          {
            id: `${company.id}-1`,
            title: 'Senior Software Engineer',
            location: 'Remote — Canada',
            jobUrl: `https://jobs.ashbyhq.com/${token}/role-1`,
            applyUrl: `https://jobs.ashbyhq.com/${token}/role-1/application`,
            descriptionHtml: '<p>TypeScript platform work</p>',
          },
        ],
      });
      const provider = new AshbyProvider({ getJson } as unknown as HttpClient);
      const result = await provider.fetchJobs(company);

      expect(getJson).toHaveBeenCalledOnce();
      const url = String(getJson.mock.calls[0]?.[0]);
      expect(url).toBe(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company.boardToken ?? '')}`,
      );
      expect(result.complete).toBe(true);
      expect(result.jobs[0]?.externalId).toBe(`${company.id}-1`);
    }
    expect(boards).toHaveLength(5);
  });
});
