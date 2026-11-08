import { Injectable } from '@nestjs/common';
import type {
  MatchResult,
  NormalizedJob,
  RemoteEligibility,
  ScoreBreakdown,
  SearchProfile,
  UserFeedback,
} from './domain.js';

const seniorTerms = ['senior', 'staff', 'principal', 'lead', 'architect'];
const unsuitableTerms = ['intern', 'junior', 'entry level', 'new grad'];
const canadaTerms = ['canada', 'canadian', 'quebec', 'québec', 'north america', 'americas'];
const excludedLocationTerms = [
  'united states only',
  'us only',
  'u.s. only',
  'must reside in the us',
];

export function classifyRemoteEligibility(job: NormalizedJob): RemoteEligibility {
  const evidence = `${job.location ?? ''} ${job.description ?? ''}`.toLowerCase();
  if (
    excludedLocationTerms.some((term) => evidence.includes(term)) ||
    (/\b(on[- ]?site|hybrid)\b/.test(evidence) && !/\bremote\b/.test(evidence))
  ) {
    return 'INELIGIBLE';
  }
  if (canadaTerms.some((term) => evidence.includes(term)) && /\bremote\b/.test(evidence)) {
    return 'CONFIRMED';
  }
  return /\bremote\b/.test(evidence) ? 'POSSIBLE' : 'INELIGIBLE';
}

function extractSalary(text: string): string | null {
  const match =
    /(?:CAD|USD|C\$|US\$|\$)\s?\d{2,3}(?:,\d{3})?(?:\s?(?:-|–|to)\s?(?:CAD|USD|C\$|US\$|\$)?\s?\d{2,3}(?:,\d{3})?)?/i.exec(
      text,
    );
  return match?.[0] ?? null;
}

@Injectable()
export class MatchingService {
  evaluate(
    job: NormalizedJob,
    profile: SearchProfile,
    feedback: readonly UserFeedback[] = [],
  ): MatchResult {
    const text = `${job.title} ${job.location ?? ''} ${job.description ?? ''}`.toLowerCase();
    const remoteEligibility = classifyRemoteEligibility(job);
    const reasons: string[] = [];
    const gaps: string[] = [];

    const matchedSkills = profile.skills.filter((skill) => text.includes(skill.name.toLowerCase()));
    const skillPoints = Math.min(30, matchedSkills.length * 5);
    if (matchedSkills.length)
      reasons.push(`Matches ${matchedSkills.map((s) => s.name).join(', ')}`);

    const roleMatch = profile.targetTitles.some((title) => {
      const meaningful = title
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.length > 3);
      return meaningful.some((word) => job.title.toLowerCase().includes(word));
    });
    const senior = seniorTerms.some((term) => job.title.toLowerCase().includes(term));
    const unsuitable = unsuitableTerms.some((term) => job.title.toLowerCase().includes(term));
    const hardExcluded = profile.hardExclusions.some((term) => text.includes(term.toLowerCase()));
    const interestMatches = profile.learningInterests.filter((interest) =>
      text.includes(interest.toLowerCase()),
    ).length;
    const priorRejections = feedback.filter(
      (item) =>
        item.state === 'rejected' && item.reason && text.includes(item.reason.toLowerCase()),
    ).length;

    const breakdown: ScoreBreakdown = {
      skills: skillPoints,
      role: roleMatch ? 20 : 5,
      seniority: senior ? 15 : unsuitable ? 0 : 8,
      remote: remoteEligibility === 'CONFIRMED' ? 15 : remoteEligibility === 'POSSIBLE' ? 8 : 0,
      compensation: extractSalary(text) ? 5 : 2,
      interests: Math.min(5, interestMatches * 2),
      legitimacy: new URL(job.sourceUrl).protocol === 'https:' ? 10 : 0,
      feedback: -Math.min(10, priorRejections * profile.feedbackPreferences.rejectionPenalty),
    };
    if (remoteEligibility === 'POSSIBLE') {
      gaps.push('Canadian/Quebec eligibility requires verification');
    }
    if (!extractSalary(text)) gaps.push('Compensation not disclosed');
    const rawScore =
      breakdown.skills +
      breakdown.role +
      breakdown.seniority +
      breakdown.remote +
      breakdown.compensation +
      breakdown.interests +
      breakdown.legitimacy +
      breakdown.feedback;
    const score = Math.max(0, Math.min(100, rawScore));
    return {
      job,
      score,
      breakdown,
      remoteEligibility,
      reasons,
      gaps,
      salary: extractSalary(text),
      eligible: remoteEligibility !== 'INELIGIBLE' && !unsuitable && !hardExcluded,
    };
  }
}
