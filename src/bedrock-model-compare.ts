import type { AppConfig } from './config.js';
import type { BedrockEvaluator, EvaluationRecord } from './ai.js';
import { estimateBedrockCostUsd, resolveBedrockPricing } from './bedrock-pricing.js';
import type { PersistedEvaluationSnapshot } from './evaluation-persist.js';
import { applyLlmEvaluation, MatchingService } from './matching.js';
import type { RemoteEligibility, SearchProfile, UserFeedback } from './domain.js';
import type { JobStorage } from './storage.js';

export interface ModelCompareOptions {
  limit: number;
  baselineModelId: string;
  compareModelId: string;
  maxCacheScan: number;
}

export interface ModelCompareRow {
  jobKey: string;
  title: string;
  companyId: string;
  baselineModelId: string;
  compareModelId: string;
  baselineFinalScore: number;
  compareFinalScore: number | null;
  scoreDelta: number | null;
  baselineRemote: RemoteEligibility;
  compareRemote: RemoteEligibility | null;
  remoteChanged: boolean;
  baselineCachedAt: string;
  compareLatencyMs: number | null;
  compareParseAttempts: number | null;
  compareInputTokens: number | null;
  compareOutputTokens: number | null;
  compareEstimatedCostUsd: number | null;
  error: string | null;
  invalidJson: boolean;
}

export interface ModelCompareReport {
  baselineModelId: string;
  compareModelId: string;
  scannedCacheEntries: number;
  selected: number;
  compared: number;
  failures: number;
  invalidJsonResponses: number;
  remoteEligibilityChanges: number;
  totalCompareLatencyMs: number;
  totalCompareInputTokens: number;
  totalCompareOutputTokens: number;
  totalCompareCostUsd: number;
  baselinePricing: ReturnType<typeof resolveBedrockPricing>;
  comparePricing: ReturnType<typeof resolveBedrockPricing>;
  rows: ModelCompareRow[];
  readOnly: true;
}

const DEFAULT_COMPARE: ModelCompareOptions = {
  limit: 15,
  baselineModelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  compareModelId: 'us.amazon.nova-micro-v1:0',
  maxCacheScan: 2_000,
};

export function parseModelCompareArgs(argv: readonly string[]): Partial<ModelCompareOptions> {
  const options: Partial<ModelCompareOptions> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--limit') {
      options.limit = parseIntArg(argv[++index], 'limit', 1, 50);
    } else if (token === '--baseline-model') {
      options.baselineModelId = requireArg(argv[++index], 'baseline-model');
    } else if (token === '--compare-model') {
      options.compareModelId = requireArg(argv[++index], 'compare-model');
    } else if (token === '--max-cache-scan') {
      options.maxCacheScan = parseIntArg(argv[++index], 'max-cache-scan', 1, 10_000);
    }
  }
  return options;
}

function requireArg(value: string | undefined, label: string): string {
  if (!value) throw new Error(`--${label} requires a value`);
  return value;
}

function parseIntArg(value: string | undefined, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${String(min)} and ${String(max)}`);
  }
  return parsed;
}

export function resolveModelCompareOptions(
  config: AppConfig,
  partial: Partial<ModelCompareOptions> = {},
): ModelCompareOptions {
  return {
    ...DEFAULT_COMPARE,
    baselineModelId: config.BEDROCK_MODEL_ID,
    compareModelId: 'us.amazon.nova-micro-v1:0',
    ...partial,
  };
}

export function selectBaselineEvaluations(
  cacheMap: Map<string, PersistedEvaluationSnapshot>,
  baselineModelId: string,
  limit: number,
): PersistedEvaluationSnapshot[] {
  return [...cacheMap.values()]
    .filter((snapshot) => matchesBaselineModel(snapshot.record, baselineModelId))
    .sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt))
    .slice(0, limit);
}

function matchesBaselineModel(record: EvaluationRecord, baselineModelId: string): boolean {
  if (record.modelId === baselineModelId) return true;
  if (record.modelId.includes('haiku') && baselineModelId.includes('haiku')) return true;
  return false;
}

export async function compareBedrockModels(
  storage: JobStorage,
  profile: SearchProfile,
  config: AppConfig,
  evaluator: BedrockEvaluator,
  partialOptions: Partial<ModelCompareOptions> = {},
  matching: MatchingService = new MatchingService(),
  feedback: readonly UserFeedback[] = [],
): Promise<ModelCompareReport> {
  const options = resolveModelCompareOptions(config, partialOptions);
  const cacheMap = await storage.buildEvaluationCacheMap(options.maxCacheScan);
  const selected = selectBaselineEvaluations(cacheMap, options.baselineModelId, options.limit);

  const rows: ModelCompareRow[] = [];
  let failures = 0;
  let invalidJsonResponses = 0;
  let remoteEligibilityChanges = 0;
  let totalCompareLatencyMs = 0;
  let totalCompareInputTokens = 0;
  let totalCompareOutputTokens = 0;
  let totalCompareCostUsd = 0;

  for (const snapshot of selected) {
    const jobKey = snapshot.jobKey;
    if (!jobKey) continue;
    const job = await storage.getJobByKey(jobKey);
    if (!job) continue;

    const preliminary = matching.evaluate(job, profile, feedback);
    const baselineMatch = applyLlmEvaluation(preliminary, snapshot.record.evaluation);
    const rowBase: Omit<
      ModelCompareRow,
      | 'compareFinalScore'
      | 'scoreDelta'
      | 'compareRemote'
      | 'remoteChanged'
      | 'compareLatencyMs'
      | 'compareParseAttempts'
      | 'compareInputTokens'
      | 'compareOutputTokens'
      | 'compareEstimatedCostUsd'
      | 'error'
      | 'invalidJson'
    > = {
      jobKey,
      title: job.title,
      companyId: job.companyId,
      baselineModelId: snapshot.record.modelId,
      compareModelId: options.compareModelId,
      baselineFinalScore: baselineMatch.score,
      baselineRemote: baselineMatch.remoteEligibility,
      baselineCachedAt: snapshot.record.createdAt,
    };

    try {
      const probe = await evaluator.evaluateProbe(preliminary, profile, options.compareModelId);
      const compareMatch = applyLlmEvaluation(preliminary, probe.record.evaluation);
      const remoteChanged = compareMatch.remoteEligibility !== baselineMatch.remoteEligibility;
      if (remoteChanged) remoteEligibilityChanges += 1;
      totalCompareLatencyMs += probe.latencyMs;
      totalCompareInputTokens += probe.record.inputTokens;
      totalCompareOutputTokens += probe.record.outputTokens;
      totalCompareCostUsd += probe.record.estimatedCostUsd;

      rows.push({
        ...rowBase,
        compareFinalScore: compareMatch.score,
        scoreDelta: compareMatch.score - baselineMatch.score,
        compareRemote: compareMatch.remoteEligibility,
        remoteChanged,
        compareLatencyMs: probe.latencyMs,
        compareParseAttempts: probe.parseAttempts,
        compareInputTokens: probe.record.inputTokens,
        compareOutputTokens: probe.record.outputTokens,
        compareEstimatedCostUsd: probe.record.estimatedCostUsd,
        error: null,
        invalidJson: false,
      });
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      const invalidJson = /invalid JSON|no JSON object|no text response|schema/i.test(message);
      if (invalidJson) invalidJsonResponses += 1;
      rows.push({
        ...rowBase,
        compareFinalScore: null,
        scoreDelta: null,
        compareRemote: null,
        remoteChanged: false,
        compareLatencyMs: null,
        compareParseAttempts: null,
        compareInputTokens: null,
        compareOutputTokens: null,
        compareEstimatedCostUsd: null,
        error: message.slice(0, 500),
        invalidJson,
      });
    }
  }

  return {
    baselineModelId: options.baselineModelId,
    compareModelId: options.compareModelId,
    scannedCacheEntries: cacheMap.size,
    selected: selected.length,
    compared: rows.length,
    failures,
    invalidJsonResponses,
    remoteEligibilityChanges,
    totalCompareLatencyMs,
    totalCompareInputTokens,
    totalCompareOutputTokens,
    totalCompareCostUsd,
    baselinePricing: resolveBedrockPricing(options.baselineModelId, config),
    comparePricing: resolveBedrockPricing(options.compareModelId, config),
    rows,
    readOnly: true,
  };
}

export function formatModelCompareTable(report: ModelCompareReport): string {
  if (!report.rows.length) {
    return 'No cached baseline evaluations matched the selection criteria.';
  }
  const headers = [
    'Job',
    'Baseline',
    'Compare',
    'Delta',
    'Remote (B→C)',
    'Latency ms',
    'Cost USD',
    'Error',
  ];
  const lines = report.rows.map((row) =>
    [
      truncate(row.title, 36),
      row.compareFinalScore === null
        ? String(row.baselineFinalScore)
        : String(row.baselineFinalScore),
      row.compareFinalScore === null ? '—' : String(row.compareFinalScore),
      row.scoreDelta === null ? '—' : String(row.scoreDelta),
      `${row.baselineRemote}→${row.compareRemote ?? '—'}`,
      row.compareLatencyMs === null ? '—' : String(row.compareLatencyMs),
      row.compareEstimatedCostUsd === null ? '—' : row.compareEstimatedCostUsd.toFixed(6),
      row.error ? truncate(row.error, 40) : '',
    ].join(' | '),
  );
  return [headers.join(' | '), ...lines].join('\n');
}

export function summarizeCachedBaselineCost(
  snapshots: readonly PersistedEvaluationSnapshot[],
  config: AppConfig,
  baselineModelId: string,
): number {
  return snapshots.reduce(
    (total, snapshot) =>
      total +
      estimateBedrockCostUsd(
        snapshot.record.modelId || baselineModelId,
        snapshot.record.inputTokens,
        snapshot.record.outputTokens,
        config,
      ),
    0,
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
