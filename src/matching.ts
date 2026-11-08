import { Injectable } from '@nestjs/common';
import type {
  MatchResult,
  LlmEvaluation,
  NormalizedJob,
  RemoteEligibility,
  ScoreBreakdown,
  SearchProfile,
  UserFeedback,
} from './domain.js';
import {
  hasEngineeringTitleSignal,
  isClearlyUnrelatedEngineeringRole,
  roleAlignmentScore,
} from './role-prefilter.js';

const seniorTerms = ['senior', 'staff', 'principal', 'lead', 'architect'];
const unsuitableTerms = ['intern', 'junior', 'entry level', 'new grad'];
const confirmedCanadaTerms = [
  'remote canada',
  'canada remote',
  'remote - canada',
  'remote — canada',
  'open to candidates in canada',
  'hiring in canada',
];
const compatibleRemoteTerms = [
  'remote north america',
  'remote - north america',
  'remote — north america',
  'remote americas',
  'remote - americas',
  'remote — americas',
  'remote worldwide',
  'remote global',
  'work from anywhere',
];
const usStates =
  'alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming';
const incompatibleRegions =
  'united kingdom|uk|european union|eu|germany|france|spain|italy|netherlands|sweden|norway|denmark|finland|switzerland|australia|new zealand|india';
const proficiencyWeight = { expert: 1, advanced: 0.9, proficient: 0.7, learning: 0.25 };
const transferableGroups = [
  ['typescript', 'javascript', 'node.js', 'nodejs', 'react', 'next.js', 'nestjs'],
  ['java', 'kotlin', 'spring', 'spring boot', 'jvm'],
  ['aws', 'cloud', 'distributed systems', 'microservices', 'platform'],
  ['terraform', 'cdk', 'infrastructure as code', 'ci/cd'],
  ['bedrock', 'llm', 'rag', 'langchain', 'langgraph', 'mcp'],
];

export function classifyRemoteEligibility(job: NormalizedJob): RemoteEligibility {
  const evidence = `${job.location ?? ''} ${job.description ?? ''}`.toLowerCase();
  const explicitlyUsOnly =
    /\b(?:united states|u\.?s\.?|usa)\s*(?:only|residents?\s+only|based\s+only)\b/.test(evidence) ||
    /\b(?:must|need to)\s+(?:reside|live|be based)\s+in\s+(?:the\s+)?(?:united states|u\.?s\.?|usa)\b/.test(
      evidence,
    );
  const stateRestricted = new RegExp(
    `\\b(?:remote(?:\\s*[-—,:]\\s*|\\s+(?:in|from|within)\\s+)|residents?\\s+of\\s+|must\\s+(?:reside|live)\\s+in\\s+)(?:${usStates})(?:\\s+only)?\\b`,
    'i',
  ).test(evidence);
  const otherRegionRestricted = new RegExp(
    `\\b(?:remote(?:\\s*[-—,:]\\s*|\\s+(?:in|from|within)\\s+)|must\\s+(?:reside|live|be based)\\s+in\\s+)(?:the\\s+)?(?:${incompatibleRegions})(?:\\s+only)?\\b`,
    'i',
  ).test(evidence);
  if (explicitlyUsOnly || stateRestricted || otherRegionRestricted) {
    return 'INELIGIBLE';
  }
  const hasRemote = /\b(?:fully\s+)?remote\b|work from anywhere/.test(evidence);
  if (!hasRemote && /\b(on[- ]?site|hybrid)\b/.test(evidence)) return 'INELIGIBLE';
  if (!hasRemote) return 'INELIGIBLE';
  if (confirmedCanadaTerms.some((term) => evidence.includes(term))) {
    return 'CONFIRMED';
  }
  if (compatibleRemoteTerms.some((term) => evidence.includes(term))) return 'POSSIBLE';
  return 'POSSIBLE';
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
    const text =
      `${job.title} ${job.location ?? ''} ${job.description ?? ''} ${job.salaryText ?? ''}`.toLowerCase();
    const remoteEligibility = classifyRemoteEligibility(job);
    const reasons: string[] = [];
    const gaps: string[] = [];

    let skillPoints = 0;
    const productionMatches: string[] = [];
    const learningMatches: string[] = [];
    for (const skill of profile.skills) {
      const skillName = skill.name.toLowerCase();
      if (!text.includes(skillName)) continue;
      const requirement = requirementLevel(text, skillName);
      const requirementWeight =
        requirement === 'required' ? 1.2 : requirement === 'preferred' ? 0.8 : 1;
      const importance =
        skill.importance === 'core' ? 1.15 : skill.importance === 'interest' ? 0.5 : 1;
      skillPoints += 5 * proficiencyWeight[skill.proficiency] * requirementWeight * importance;
      if (skill.proficiency === 'learning') {
        learningMatches.push(skill.name);
        gaps.push(`${skill.name} is learning-stage experience, not production expertise`);
      } else {
        productionMatches.push(`${skill.name}${requirement === 'required' ? ' (required)' : ''}`);
      }
    }
    const transferable = transferableExperience(text, profile);
    skillPoints = Math.min(30, skillPoints + transferable);
    if (productionMatches.length)
      reasons.push(`Production matches: ${productionMatches.join(', ')}`);
    if (learningMatches.length) reasons.push(`Learning interests: ${learningMatches.join(', ')}`);
    if (transferable > 0) reasons.push('Transferable production experience is relevant');

    const unrelatedRole = isClearlyUnrelatedEngineeringRole(job.title);
    const rolePoints = roleAlignmentScore(job.title, profile.targetTitles);
    const engineeringTitle = hasEngineeringTitleSignal(job.title);
    const senior =
      seniorTerms.some((term) => job.title.toLowerCase().includes(term)) && engineeringTitle;
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
      role: rolePoints,
      seniority: senior ? 12 : unsuitable ? 0 : engineeringTitle ? 6 : 0,
      remote: remoteEligibility === 'INELIGIBLE' ? 0 : 15,
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
    let score = Math.max(0, Math.min(100, rawScore));
    const hasSkillEvidence = skillPoints >= 6 || transferable >= 2;
    if (!hasSkillEvidence) {
      score = Math.min(score, 58);
    }
    const eligible =
      remoteEligibility !== 'INELIGIBLE' && !unsuitable && !hardExcluded && !unrelatedRole;
    const promising =
      eligible && score >= 45 && hasSkillEvidence && engineeringTitle && rolePoints >= 8;
    return {
      job,
      score,
      preliminaryScore: score,
      breakdown,
      remoteEligibility,
      reasons,
      gaps,
      salary: extractSalary(text),
      eligible,
      promising,
    };
  }
}

export function applyLlmEvaluation(match: MatchResult, evaluation: LlmEvaluation): MatchResult {
  const remoteEligibility =
    match.remoteEligibility === 'INELIGIBLE' || evaluation.remoteEligibility === 'INELIGIBLE'
      ? 'INELIGIBLE'
      : match.remoteEligibility === 'CONFIRMED' && evaluation.remoteEligibility === 'CONFIRMED'
        ? 'CONFIRMED'
        : 'POSSIBLE';
  const gapPenalty = Math.min(20, evaluation.mustHaveGaps.length * 6);
  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round(match.preliminaryScore * 0.4 + evaluation.fitScore * 0.6 - gapPenalty),
    ),
  );
  return {
    ...match,
    score,
    remoteEligibility,
    reasons: [...new Set([...match.reasons, ...evaluation.strengths])],
    gaps: [...new Set([...match.gaps, ...evaluation.mustHaveGaps, ...evaluation.weaknesses])],
    eligible: match.eligible && remoteEligibility !== 'INELIGIBLE',
  };
}

function requirementLevel(text: string, skill: string): 'required' | 'preferred' | 'mentioned' {
  const index = text.indexOf(skill);
  const context = text.slice(Math.max(0, index - 100), index + skill.length + 100);
  if (/\b(required|must have|minimum|need to have|you have)\b/.test(context)) return 'required';
  if (/\b(preferred|nice to have|bonus|ideally)\b/.test(context)) return 'preferred';
  return 'mentioned';
}

function transferableExperience(text: string, profile: SearchProfile): number {
  let points = 0;
  for (const group of transferableGroups) {
    const jobNeedsGroup = group.some((term) => text.includes(term));
    const productionEvidence = profile.skills.some(
      (skill) =>
        skill.proficiency !== 'learning' &&
        group.some((term) => skill.name.toLowerCase().includes(term)),
    );
    if (jobNeedsGroup && productionEvidence) points += 2;
  }
  return Math.min(6, points);
}
