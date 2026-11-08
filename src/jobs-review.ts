import type { AppConfig } from './config.js';
import type { EvaluationRecord } from './ai.js';
import { evaluationCacheKey } from './evaluation-cache-key.js';
import type { PersistedEvaluationSnapshot } from './evaluation-persist.js';
import { applyLlmEvaluation, MatchingService } from './matching.js';
import type { MatchResult, NormalizedJob, SearchProfile, UserFeedback } from './domain.js';
import { DynamoJobStorage, MemoryJobStorage, type JobStorage } from './storage.js';
import { safeJobUrl } from './scan-observability.js';

export interface JobsReviewOptions {
  minScore: number;
  limit: number;
  eligibleOnly: boolean;
  maxActiveJobs: number;
  diagnostic: boolean;
  maxEvaluationCacheEntries: number;
}

export interface EvaluatedJobReviewRow {
  jobKey: string;
  finalScore: number;
  preliminaryScore: number;
  title: string;
  companyId: string;
  source: string;
  remoteEligibility: string;
  eligible: boolean;
  recommendation: string;
  jobUrl?: string;
  evaluatedAt: string;
}

export interface JobsReviewDiagnostics {
  awsRegion: string;
  dynamodbTableName: string;
  userId: string;
  profileVersion: string;
  bedrockModelId: string;
  mockMode: boolean;
  storageBackend: 'dynamodb' | 'memory';
  inspected: {
    scoredNotifications: number;
    indexedEvaluations: number;
    activeJobs: number;
    evaluationCacheEntries: number;
    activeJobsWithCacheHit: number;
    activeJobsWithCacheMiss: number;
  };
  hints: string[];
}

export interface JobsReviewResult {
  rows: EvaluatedJobReviewRow[];
  diagnostics?: JobsReviewDiagnostics;
}

const DEFAULT_REVIEW: JobsReviewOptions = {
  minScore: 0,
  limit: 20,
  eligibleOnly: false,
  maxActiveJobs: 500,
  diagnostic: false,
  maxEvaluationCacheEntries: 2_000,
};

export function parseJobsReviewArgs(argv: readonly string[]): JobsReviewOptions {
  const options: JobsReviewOptions = { ...DEFAULT_REVIEW };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--min-score') {
      options.minScore = parseBoundedInt(argv[++index], 'min-score', 0, 100);
    } else if (token === '--limit') {
      options.limit = parseBoundedInt(argv[++index], 'limit', 1, 500);
    } else if (token === '--eligible-only') {
      options.eligibleOnly = true;
    } else if (token === '--max-active-jobs') {
      options.maxActiveJobs = parseBoundedInt(argv[++index], 'max-active-jobs', 1, 10_000);
    } else if (token === '--diagnostic') {
      options.diagnostic = true;
    } else if (token === '--max-eval-cache') {
      options.maxEvaluationCacheEntries = parseBoundedInt(
        argv[++index],
        'max-eval-cache',
        1,
        10_000,
      );
    }
  }
  return options;
}

function parseBoundedInt(
  value: string | undefined,
  label: string,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${String(min)} and ${String(max)}`);
  }
  return parsed;
}

export async function listEvaluatedJobsForReview(
  storage: JobStorage,
  profile: SearchProfile,
  config: AppConfig,
  options: JobsReviewOptions = DEFAULT_REVIEW,
  matching: MatchingService = new MatchingService(),
  feedback: readonly UserFeedback[] = [],
): Promise<JobsReviewResult> {
  const byJobKey = new Map<string, EvaluatedJobReviewRow>();
  const hints: string[] = [];
  let activeJobsWithCacheHit = 0;
  let activeJobsWithCacheMiss = 0;

  if (config.MOCK_MODE && storage instanceof MemoryJobStorage) {
    hints.push(
      'MOCK_MODE=true uses in-memory storage with no Lambda data. jobs:review binds to DynamoDB automatically; set DYNAMODB_TABLE_NAME and AWS credentials to the deployed table.',
    );
  }

  const notifications = await storage.listScoredNotifications(config.USER_ID, options.limit * 4);
  for (const item of notifications) {
    const row = rowFromMatch(item.match, item.evaluation, item.createdAt);
    byJobKey.set(row.jobKey, row);
  }

  const indexed = await storage.listIndexedEvaluations(config.USER_ID, options.limit * 8);
  for (const snapshot of indexed) {
    if (!snapshot.jobKey || byJobKey.has(snapshot.jobKey)) continue;
    const job = await storage.getJobByKey(snapshot.jobKey);
    if (!job) continue;
    const row = rowFromEvaluationSnapshot(job, snapshot, profile, matching, feedback);
    byJobKey.set(row.jobKey, row);
  }

  const cacheMap = await storage.buildEvaluationCacheMap(options.maxEvaluationCacheEntries);
  const activeJobs = await storage.listActiveJobs(options.maxActiveJobs);
  for (const job of activeJobs) {
    const jobKey = job.dedupeKey ?? job.canonicalId;
    if (byJobKey.has(jobKey)) continue;
    const snapshot = findSnapshotForJob(job, profile, config, cacheMap);
    const evaluation =
      snapshot?.record ?? (await resolveEvaluationRecord(storage, job, profile, config, cacheMap));
    if (!evaluation) {
      activeJobsWithCacheMiss += 1;
      continue;
    }
    activeJobsWithCacheHit += 1;
    const preliminary = matching.evaluate(job, profile, feedback);
    const row = rowFromMatch(
      applyLlmEvaluation(preliminary, evaluation.evaluation),
      evaluation,
      evaluation.createdAt,
    );
    byJobKey.set(row.jobKey, row);
  }

  const rows = [...byJobKey.values()]
    .filter((row) => row.finalScore >= options.minScore)
    .filter((row) => (options.eligibleOnly ? row.eligible : true))
    .sort((left, right) => right.finalScore - left.finalScore)
    .slice(0, options.limit);

  if (
    !rows.length &&
    notifications.length === 0 &&
    cacheMap.size === 0 &&
    activeJobs.length === 0
  ) {
    hints.push(
      'No DynamoDB rows were found for scored notifications, evaluation cache (EVAL#), or active jobs (GSI1 JOBSTATUS#ACTIVE). Confirm DYNAMODB_TABLE_NAME, AWS_REGION, and USER_ID match the Lambda environment.',
    );
  } else if (!rows.length && cacheMap.size > 0 && activeJobsWithCacheMiss === activeJobs.length) {
    hints.push(
      'Evaluation cache entries exist but no active job matched cache keys. Align PROFILE_PATH version and BEDROCK_MODEL_ID with Lambda, or rerun evaluation after updating profile.',
    );
  } else if (!rows.length && notifications.length === 0 && cacheMap.size > 0) {
    hints.push(
      'Scores below SCORE_THRESHOLD are not written to GSI3 SCORE#; review reads EVAL# cache and GSI3 EVALREVIEW# when present.',
    );
  }

  const diagnostics: JobsReviewDiagnostics | undefined = options.diagnostic
    ? {
        awsRegion: config.AWS_REGION,
        dynamodbTableName: config.DYNAMODB_TABLE_NAME,
        userId: config.USER_ID,
        profileVersion: profile.version,
        bedrockModelId: config.BEDROCK_MODEL_ID,
        mockMode: config.MOCK_MODE,
        storageBackend: storage instanceof DynamoJobStorage ? 'dynamodb' : 'memory',
        inspected: {
          scoredNotifications: notifications.length,
          indexedEvaluations: indexed.length,
          activeJobs: activeJobs.length,
          evaluationCacheEntries: cacheMap.size,
          activeJobsWithCacheHit,
          activeJobsWithCacheMiss,
        },
        hints,
      }
    : undefined;

  return { rows, ...(diagnostics ? { diagnostics } : {}) };
}

function rowFromEvaluationSnapshot(
  job: NormalizedJob,
  snapshot: PersistedEvaluationSnapshot,
  profile: SearchProfile,
  matching: MatchingService,
  feedback: readonly UserFeedback[],
): EvaluatedJobReviewRow {
  const preliminary = matching.evaluate(job, profile, feedback);
  const row = rowFromMatch(
    applyLlmEvaluation(preliminary, snapshot.record.evaluation),
    snapshot.record,
    snapshot.record.createdAt,
  );
  return row;
}

function findSnapshotForJob(
  job: NormalizedJob,
  profile: SearchProfile,
  config: AppConfig,
  cacheMap: Map<string, PersistedEvaluationSnapshot>,
): PersistedEvaluationSnapshot | undefined {
  const jobKey = job.dedupeKey ?? job.canonicalId;
  for (const snapshot of cacheMap.values()) {
    if (snapshot.jobKey === jobKey) return snapshot;
  }
  for (const key of evaluationKeysForJob(job, profile, config)) {
    const snapshot = cacheMap.get(key);
    if (snapshot) return snapshot;
  }
  return undefined;
}

async function resolveEvaluationRecord(
  storage: JobStorage,
  job: NormalizedJob,
  profile: SearchProfile,
  config: AppConfig,
  cacheMap: Map<string, PersistedEvaluationSnapshot>,
): Promise<EvaluationRecord | undefined> {
  const snapshot = findSnapshotForJob(job, profile, config, cacheMap);
  const keyCandidates = snapshot
    ? evaluationKeysForJob(job, profile, config, snapshot)
    : evaluationKeysForJob(job, profile, config);
  for (const key of keyCandidates) {
    const cached = cacheMap.get(key)?.record ?? (await storage.getEvaluation(key));
    if (cached) return cached;
  }
  return snapshot?.record;
}

export function evaluationKeysForJob(
  job: NormalizedJob,
  profile: SearchProfile,
  config: AppConfig,
  snapshot?: PersistedEvaluationSnapshot,
): string[] {
  const keys = new Set<string>();
  keys.add(evaluationCacheKey(job, profile, config.BEDROCK_MODEL_ID));
  if (snapshot?.contentHash && snapshot.profileVersion && snapshot.modelId) {
    keys.add(
      evaluationCacheKey(
        { contentHash: snapshot.contentHash },
        { version: snapshot.profileVersion },
        snapshot.modelId,
      ),
    );
  }
  if (snapshot?.contentHash) {
    keys.add(
      evaluationCacheKey({ contentHash: snapshot.contentHash }, profile, config.BEDROCK_MODEL_ID),
    );
  }
  return [...keys];
}

function rowFromMatch(
  match: MatchResult,
  evaluation: EvaluationRecord,
  evaluatedAt: string,
): EvaluatedJobReviewRow {
  const jobKey = match.job.dedupeKey ?? match.job.canonicalId;
  const jobUrl = safeJobUrl(match.job);
  return {
    jobKey,
    finalScore: match.score,
    preliminaryScore: match.preliminaryScore,
    title: match.job.title,
    companyId: match.job.companyId,
    source: match.job.sourceName ?? match.job.provider,
    remoteEligibility: match.remoteEligibility,
    eligible: match.eligible,
    recommendation: evaluation.evaluation.recommendation,
    evaluatedAt,
    ...(jobUrl ? { jobUrl } : {}),
  };
}

export function formatJobsReviewTable(rows: readonly EvaluatedJobReviewRow[]): string {
  if (!rows.length) return 'No evaluated jobs matched the filters.';
  const headers = [
    'Score',
    'Title',
    'Company',
    'Source',
    'Remote',
    'Eligible',
    'Recommendation',
    'URL',
  ];
  const lines = rows.map((row) =>
    [
      String(row.finalScore),
      row.title,
      row.companyId,
      row.source,
      row.remoteEligibility,
      row.eligible ? 'yes' : 'no',
      truncate(row.recommendation, 80),
      row.jobUrl ?? '',
    ].join(' | '),
  );
  return [headers.join(' | '), ...lines].join('\n');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
