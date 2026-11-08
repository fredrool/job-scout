import { describe, expect, it } from 'vitest';
import { applyLlmEvaluation, classifyRemoteEligibility, MatchingService } from '../src/matching.js';
import type { LlmEvaluation, NormalizedJob, SearchProfile } from '../src/domain.js';

const profile: SearchProfile = {
  version: '1',
  userId: 'default',
  name: 'Test profile',
  targetTitles: ['Senior Software Engineer'],
  skills: [
    { name: 'TypeScript', proficiency: 'expert', evidence: 'Production' },
    { name: 'AWS', proficiency: 'advanced', evidence: 'Production' },
    { name: 'React', proficiency: 'expert', evidence: 'Production' },
    { name: 'Bedrock', proficiency: 'learning', evidence: 'Personal applied AI projects' },
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

  it('handles compatible international wording and conflicting restrictions', () => {
    expect(classifyRemoteEligibility(job({ location: 'Remote — Americas' }))).toBe('POSSIBLE');
    expect(classifyRemoteEligibility(job({ location: 'Remote Global' }))).toBe('POSSIBLE');
    expect(
      classifyRemoteEligibility(
        job({
          location: 'Remote',
          description: 'European company; contractor arrangement possible',
        }),
      ),
    ).toBe('POSSIBLE');
    expect(
      classifyRemoteEligibility(
        job({
          location: 'Remote — Worldwide',
          description: 'Applicants must reside in the US.',
        }),
      ),
    ).toBe('INELIGIBLE');
    expect(
      classifyRemoteEligibility(
        job({ location: 'Remote', description: 'Candidates must reside in California.' }),
      ),
    ).toBe('INELIGIBLE');
    expect(classifyRemoteEligibility(job({ location: 'Remote — Germany' }))).toBe('INELIGIBLE');
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

  it('keeps a realistic transferable platform role for Bedrock evaluation below 80', () => {
    const result = new MatchingService().evaluate(
      job({
        title: 'Senior Platform Engineer',
        location: 'Remote',
        description:
          'Build cloud platforms and distributed systems. Kubernetes and Go are required. AWS and infrastructure as code experience are preferred. We hire internationally through contractor arrangements where available.',
      }),
      profile,
    );
    expect(result.remoteEligibility).toBe('POSSIBLE');
    expect(result.score).toBeLessThan(80);
    expect(result.promising).toBe(true);
    expect(result.gaps).toContain('Canadian/Quebec eligibility requires verification');
  });

  it('does not present learning-stage AI skills as production expertise', () => {
    const result = new MatchingService().evaluate(
      job({
        title: 'Applied AI Engineer',
        location: 'Remote Global',
        description:
          'Required: five years of production LLM systems and Bedrock. Preferred: TypeScript and AWS.',
      }),
      profile,
    );
    expect(result.reasons.join(' ')).toContain('Learning interests: Bedrock');
    expect(result.reasons.join(' ')).not.toContain('Production matches: Bedrock');
    expect(result.gaps).toContain('Bedrock is learning-stage experience, not production expertise');
    expect(result.promising).toBe(true);
  });

  it('combines Bedrock fit with the preliminary score without penalizing ambiguity alone', () => {
    const preliminary = new MatchingService().evaluate(
      job({
        title: 'Senior Product Engineer',
        location: 'Remote',
        description: 'Build a TypeScript and React product on AWS.',
      }),
      profile,
    );
    const evaluation: LlmEvaluation = {
      strengths: ['Strong transferable product engineering experience'],
      weaknesses: [],
      mustHaveGaps: [],
      remoteEligibility: 'POSSIBLE',
      legitimacySignals: ['Official ATS posting'],
      fitScore: 94,
      confidence: 0.85,
      recommendation: 'Verify Canadian engagement and apply.',
    };
    const final = applyLlmEvaluation(preliminary, evaluation);
    expect(final.score).toBeGreaterThan(preliminary.preliminaryScore);
    expect(final.remoteEligibility).toBe('POSSIBLE');
    expect(final.eligible).toBe(true);
  });
});
