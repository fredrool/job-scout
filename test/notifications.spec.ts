import { describe, expect, it } from 'vitest';
import { DigestRenderer } from '../src/notifications.js';
import type { NotificationBatch } from '../src/storage.js';

const batch: NotificationBatch = {
  batchId: 'batch-1',
  userId: 'default',
  status: 'SENDING',
  attempts: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  items: [
    {
      userId: 'default',
      notificationKey: 'job#hash',
      createdAt: '2026-01-01T00:00:00.000Z',
      attempts: 0,
      match: {
        job: {
          canonicalId: 'job',
          companyId: 'Acme & Co',
          provider: 'greenhouse',
          externalId: '1',
          title: 'Senior <Engineer>',
          location: 'Remote',
          description: null,
          sourceUrl: 'https://example.com/jobs/1',
          applyUrl: 'https://example.com/jobs/1/apply',
          updatedAt: null,
          contentHash: 'hash',
        },
        score: 88,
        preliminaryScore: 76,
        breakdown: {
          skills: 25,
          role: 20,
          seniority: 15,
          remote: 8,
          compensation: 5,
          interests: 5,
          legitimacy: 10,
          feedback: 0,
        },
        remoteEligibility: 'POSSIBLE',
        reasons: ['Strong fit'],
        gaps: ['Eligibility unknown'],
        salary: null,
        eligible: true,
        promising: true,
      },
      evaluation: {
        cacheKey: 'cache',
        evaluation: {
          strengths: [],
          weaknesses: [],
          mustHaveGaps: [],
          remoteEligibility: 'POSSIBLE',
          legitimacySignals: [],
          fitScore: 88,
          confidence: 0.7,
          recommendation: 'Verify eligibility',
        },
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        modelId: 'mock',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    },
  ],
};

describe('DigestRenderer', () => {
  it('includes mandatory links, score, uncertainty, and a plain-text full URL', () => {
    const rendered = new DigestRenderer().render(batch, 'America/Toronto');
    expect(rendered.html).toContain('View Job / Apply');
    expect(rendered.html).toContain('Direct application');
    expect(rendered.html).toContain('Eligibility requires verification');
    expect(rendered.html).toContain('88/100');
    expect(rendered.html).not.toContain('<Engineer>');
    expect(rendered.text).toContain('https://example.com/jobs/1');
    expect(rendered.text).toContain('https://example.com/jobs/1/apply');
    expect(rendered.text).toContain('Salary: Unknown');
  });
});
