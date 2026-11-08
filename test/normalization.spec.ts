import { describe, expect, it } from 'vitest';
import type { Company, ProviderJob } from '../src/domain.js';
import { normalizeJob, SourceUrlVerifier } from '../src/normalization.js';

const company: Company = {
  id: 'example-greenhouse',
  name: 'Example Company',
  enabled: true,
  careersUrl: 'https://boards.greenhouse.io/example',
  provider: 'greenhouse',
  boardToken: 'example',
};

const rawJob: ProviderJob = {
  externalId: ' 123 ',
  title: ' Senior   Engineer ',
  location: ' Remote ',
  description: '<p>Build&nbsp;great <strong>systems</strong>.</p>',
  applyUrl:
    'https://boards.greenhouse.io/example/jobs/123?utm_source=newsletter&department=eng#apply',
  sourceUrl: 'https://boards.greenhouse.io/example/jobs/123?department=eng',
  updatedAt: '2026-01-02T03:04:05Z',
};

describe('normalizeJob', () => {
  it('creates a canonical id and stable content hash', () => {
    const first = normalizeJob(company, rawJob);
    const second = normalizeJob(company, {
      ...rawJob,
      applyUrl: 'https://boards.greenhouse.io/example/jobs/123?department=eng&utm_campaign=other',
    });

    expect(first.canonicalId).toBe('example-greenhouse:greenhouse:123');
    expect(first.title).toBe('Senior Engineer');
    expect(first.description).toBe('Build great systems.');
    expect(first.applyUrl).toBe('https://boards.greenhouse.io/example/jobs/123?department=eng');
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects untrusted and local source hosts', () => {
    const verifier = new SourceUrlVerifier();
    expect(() => verifier.verify('https://malicious.example/jobs/1', company)).toThrow(
      'Unexpected source host',
    );
    expect(() => verifier.verify('https://127.0.0.1/jobs/1', company)).toThrow('Private or local');
  });
});
