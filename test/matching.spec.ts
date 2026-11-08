import { describe, expect, it } from 'vitest';
import { classifyRemoteEligibility, MatchingService } from '../src/matching.js';
import type { NormalizedJob, SearchProfile } from '../src/domain.js';

const profile: SearchProfile = {
  version: '1',
  userId: 'default',
  name: 'Test profile',
  targetTitles: ['Senior Software Engineer'],
  skills: [
    { name: 'TypeScript', proficiency: 'expert', evidence: 'Production' },
    { name: 'AWS', proficiency: 'advanced', evidence: 'Production' },
    { name: 'React', proficiency: 'expert', evidence: 'Production' },
  ],
  workHistorySummary: 'Experienced engineer',
  locations: ['Quebec', 'Canada'],
  remoteOnly: true,
  preferredRegions: ['Canada'],
  compensation: { currency: 'CAD' },
  hardExclusions: ['security clearance required'],
  learningInterests: ['Bedrock'],
  feedbackPreferences: { rejectionPenalty: 4 },
};

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    canonicalId: 'greenhouse:acme:1',
    companyId: 'acme',
    provider: 'greenhouse',
    externalId: '1',
    title: 'Senior Software Engineer',
    location: 'Remote — Canada',
    description: 'Build TypeScript, React, and AWS systems. Salary CAD 180,000.',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    updatedAt: null,
    contentHash: 'hash',
    ...overrides,
  };
}

describe('remote eligibility', () => {
  it('confirms explicit Canadian remote eligibility', () => {
    expect(classifyRemoteEligibility(job())).toBe('CONFIRMED');
  });

  it('marks remote-only ambiguity as possible', () => {
    expect(
      classifyRemoteEligibility(job({ location: 'Remote', description: 'Work remotely' })),
    ).toBe('POSSIBLE');
  });

  it('rejects US-only and mandatory hybrid roles', () => {
    expect(classifyRemoteEligibility(job({ location: 'Remote — United States only' }))).toBe(
      'INELIGIBLE',
    );
    expect(classifyRemoteEligibility(job({ location: 'Hybrid Montreal', description: '' }))).toBe(
      'INELIGIBLE',
    );
  });
});

describe('MatchingService', () => {
  it('produces an explainable weighted score without inventing unknowns', () => {
    const result = new MatchingService().evaluate(job(), profile);
    expect(result.eligible).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.salary).toContain('180,000');
    expect(
      result.breakdown.skills +
        result.breakdown.role +
        result.breakdown.seniority +
        result.breakdown.remote +
        result.breakdown.compensation +
        result.breakdown.interests +
        result.breakdown.legitimacy +
        result.breakdown.feedback,
    ).toBe(result.score);
  });

  it('excludes junior jobs and records missing salary', () => {
    const result = new MatchingService().evaluate(
      job({ title: 'Junior Engineer', description: 'Remote across Canada' }),
      profile,
    );
    expect(result.eligible).toBe(false);
    expect(result.salary).toBeNull();
    expect(result.gaps).toContain('Compensation not disclosed');
  });
});
