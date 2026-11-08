import { z } from 'zod';

export const companyProviderKindSchema = z.enum(['greenhouse', 'lever', 'ashby', 'json']);
export const marketplaceProviderKindSchema = z.enum(['adzuna', 'remotive', 'jooble']);
export const providerKindSchema = z.union([
  companyProviderKindSchema,
  marketplaceProviderKindSchema,
]);
export type ProviderKind = z.infer<typeof providerKindSchema>;
export type CompanyProviderKind = z.infer<typeof companyProviderKindSchema>;
export type MarketplaceProviderKind = z.infer<typeof marketplaceProviderKindSchema>;

export const jsonFeedMappingSchema = z
  .object({
    jobsPath: z.string().min(1).optional(),
    id: z.string().min(1),
    title: z.string().min(1),
    applyUrl: z.string().min(1),
    sourceUrl: z.string().min(1).optional(),
    location: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    updatedAt: z.string().min(1).optional(),
  })
  .strict();
export type JsonFeedMapping = z.infer<typeof jsonFeedMappingSchema>;

export const companySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1),
    enabled: z.boolean().default(false),
    careersUrl: z.url().startsWith('https://'),
    provider: companyProviderKindSchema,
    boardToken: z.string().min(1).optional(),
    feedUrl: z.url().startsWith('https://').optional(),
    feedMapping: jsonFeedMappingSchema.optional(),
  })
  .strict()
  .superRefine((company, context) => {
    if (company.provider === 'json' && (!company.feedUrl || !company.feedMapping)) {
      context.addIssue({
        code: 'custom',
        path: ['feedUrl'],
        message: 'feedUrl and feedMapping are required for JSON providers',
      });
    }
    if (company.provider !== 'json' && !company.boardToken) {
      context.addIssue({
        code: 'custom',
        path: ['boardToken'],
        message: 'boardToken is required for hosted ATS providers',
      });
    }
  });
export type Company = z.infer<typeof companySchema>;

export const registrySchema = z.object({ companies: z.array(companySchema) }).strict();
export type CompanyRegistryDocument = z.infer<typeof registrySchema>;

export const profileSchema = z
  .object({
    version: z.string().min(1).default('1'),
    userId: z.string().min(1).default('default'),
    name: z.string().min(1),
    targetTitles: z.array(z.string().min(1)).min(1),
    skills: z
      .array(
        z.object({
          name: z.string().min(1),
          proficiency: z.enum(['expert', 'advanced', 'proficient', 'learning']),
          evidence: z.string().min(1),
          importance: z.enum(['core', 'supporting', 'interest']).optional(),
        }),
      )
      .default([]),
    workHistorySummary: z.string().default(''),
    locations: z.array(z.string().min(1)).default([]),
    remoteOnly: z.boolean().default(false),
    preferredRegions: z.array(z.string()).default(['Quebec', 'Canada']),
    compensation: z
      .object({
        currency: z.string().default('CAD'),
        minimum: z.number().nonnegative().optional(),
        preferred: z.number().nonnegative().optional(),
      })
      .default({ currency: 'CAD' }),
    hardExclusions: z.array(z.string()).default([]),
    learningInterests: z.array(z.string()).default([]),
    feedbackPreferences: z
      .object({
        rejectionPenalty: z.number().min(0).max(20).default(4),
      })
      .default({ rejectionPenalty: 4 }),
  })
  .strict();
export type SearchProfile = z.infer<typeof profileSchema>;

export interface ProviderJob {
  externalId: string;
  title: string;
  location?: string;
  description?: string;
  applyUrl: string;
  sourceUrl?: string;
  updatedAt?: string;
}

export interface NormalizedJob {
  canonicalId: string;
  companyId: string;
  provider: ProviderKind;
  externalId: string;
  title: string;
  location: string | null;
  description: string | null;
  applyUrl: string;
  sourceUrl: string;
  updatedAt: string | null;
  contentHash: string;
  dedupeKey?: string;
  companyName?: string;
  sourceName?: string;
  sourceKind?: 'EMPLOYER' | 'MARKETPLACE';
  sourceUrls?: {
    provider: ProviderKind;
    url: string;
    kind: 'ORIGINAL' | 'APPLICATION' | 'AGGREGATOR';
  }[];
  salaryText?: string | null;
  firstSeenAt?: string;
  lastSeenAt?: string;
  sourcePublishedAt?: string | null;
  status?: 'ACTIVE' | 'EXPIRED' | 'REOPENED';
}

export interface SourceHealth {
  companyId: string;
  provider: ProviderKind;
  healthy: boolean;
  complete: boolean;
  authoritativeForExpiration?: boolean;
  status?: 'FETCHED' | 'SKIPPED_INTERVAL' | 'SKIPPED_MOCK' | 'MISSING_CREDENTIALS' | 'FAILED';
  requestsMade?: number;
  checkedAt: string;
  latencyMs: number;
  jobsFound?: number;
  error?: string;
  httpStatus?: number;
}

export interface DiscoveryResult {
  jobs: NormalizedJob[];
  sources: SourceHealth[];
  startedAt: string;
  completedAt: string;
}

export const discoveryCandidateSchema = z
  .object({
    companyName: z.string().min(1),
    careersUrl: z.url().startsWith('https://'),
    provider: providerKindSchema.optional(),
    boardToken: z.string().min(1).optional(),
    feedUrl: z.url().startsWith('https://').optional(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.string().min(1)),
  })
  .strict();
export type DiscoveryCandidate = z.infer<typeof discoveryCandidateSchema>;

export const remoteEligibilitySchema = z.enum(['CONFIRMED', 'POSSIBLE', 'INELIGIBLE']);
export type RemoteEligibility = z.infer<typeof remoteEligibilitySchema>;

export interface ScoreBreakdown {
  skills: number;
  role: number;
  seniority: number;
  remote: number;
  compensation: number;
  interests: number;
  legitimacy: number;
  feedback: number;
}

export interface MatchResult {
  job: NormalizedJob;
  score: number;
  preliminaryScore: number;
  breakdown: ScoreBreakdown;
  remoteEligibility: RemoteEligibility;
  reasons: string[];
  gaps: string[];
  salary: string | null;
  eligible: boolean;
  promising: boolean;
}

const RECOMMENDATION_MAX = 800;

export const llmEvaluationSchema = z
  .object({
    strengths: z.array(z.string()),
    weaknesses: z.array(z.string()),
    mustHaveGaps: z.array(z.string()),
    remoteEligibility: remoteEligibilitySchema,
    legitimacySignals: z.array(z.string()),
    fitScore: z.number().min(0).max(100),
    confidence: z.number().min(0).max(1),
    recommendation: z.preprocess(
      (value) => truncateRecommendation(value),
      z.string().min(1).max(RECOMMENDATION_MAX),
    ),
  })
  .strict();
export type LlmEvaluation = z.infer<typeof llmEvaluationSchema>;

export function truncateRecommendation(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length <= RECOMMENDATION_MAX) return value;
  return `${value.slice(0, RECOMMENDATION_MAX - 3)}...`;
}

export function coerceLlmEvaluation(
  input: unknown,
): { ok: true; evaluation: LlmEvaluation } | { ok: false; error: string } {
  const parsed = llmEvaluationSchema.safeParse(input);
  if (parsed.success) return { ok: true, evaluation: parsed.data };
  return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') };
}

export type FeedbackState =
  'interested' | 'applied' | 'rejected' | 'interviewing' | 'offered' | 'closed';

export interface UserFeedback {
  userId: string;
  canonicalId: string;
  state: FeedbackState;
  reason?: string;
  updatedAt: string;
}
