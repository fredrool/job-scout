import { describe, expect, it } from 'vitest';
import { MatchingService } from '../src/matching.js';
import { isClearlyUnrelatedEngineeringRole, roleAlignmentScore } from '../src/role-prefilter.js';
import type { NormalizedJob, SearchProfile } from '../src/domain.js';

const profile: SearchProfile = {
  version: '1',
  userId: 'default',
  name: 'Test profile',
  targetTitles: ['Senior Software Engineer', 'Senior Full-Stack Engineer'],
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
  hardExclusions: [],
  learningInterests: [],
  feedbackPreferences: { rejectionPenalty: 4 },
};

function job(
  title: string,
  description: string,
  location = 'Remote — North America',
): NormalizedJob {
  return {
    canonicalId: 'job-1',
    companyId: 'acme',
    provider: 'greenhouse',
    externalId: '1',
    title,
    location,
    description,
    applyUrl: 'https://example.com/apply',
    sourceUrl: 'https://example.com/job',
    updatedAt: null,
    contentHash: 'hash',
  };
}

describe('role prefilter', () => {
  it('flags clearly unrelated titles', () => {
    expect(isClearlyUnrelatedEngineeringRole('Senior Account Executive')).toBe(true);
    expect(isClearlyUnrelatedEngineeringRole('Customer Support Specialist')).toBe(true);
    expect(isClearlyUnrelatedEngineeringRole('Senior Software Engineer')).toBe(false);
  });

  it('requires engineering-specific title overlap instead of generic senior tokens', () => {
    expect(roleAlignmentScore('Senior Account Executive', profile.targetTitles)).toBe(0);
    expect(
      roleAlignmentScore('Senior Software Engineer', profile.targetTitles),
    ).toBeGreaterThanOrEqual(12);
  });
});

describe('prefilter and score calibration', () => {
  it('excludes unrelated roles before Bedrock evaluation', () => {
    const result = new MatchingService().evaluate(
      job('Senior Copywriter', 'Remote worldwide. Write marketing copy for the product team.'),
      profile,
    );
    expect(result.promising).toBe(false);
    expect(result.eligible).toBe(false);
  });

  it('does not inflate scores for generic senior engineer titles without stack evidence', () => {
    const result = new MatchingService().evaluate(
      job(
        'Senior Full-Stack Engineer',
        'We are hiring a senior engineer to join our team. Great culture and benefits.',
        'Remote — Americas',
      ),
      profile,
    );
    expect(result.promising).toBe(false);
    expect(result.score).toBeLessThan(70);
    expect(result.remoteEligibility).toBe('POSSIBLE');
  });

  it('still promotes strong stack matches for realistic remote regions', () => {
    const result = new MatchingService().evaluate(
      job(
        'Senior Software Engineer',
        'Build TypeScript, React, and AWS services. Remote North America.',
        'Remote — Worldwide',
      ),
      profile,
    );
    expect(result.remoteEligibility).toBe('POSSIBLE');
    expect(result.promising).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(70);
  });
});
