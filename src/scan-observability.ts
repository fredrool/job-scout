import type { NormalizedJob, SourceHealth } from './domain.js';
import { HttpError } from './http-client.js';

export type LogSink = (payload: Record<string, unknown>) => void;

export const defaultLogSink: LogSink = (payload) => {
  console.log(JSON.stringify(payload));
};

export class ScanLogger {
  constructor(
    private readonly runId: string,
    private readonly sink: LogSink = defaultLogSink,
  ) {}

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.emit('info', event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.emit('warn', event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.emit('error', event, fields);
  }

  private emit(level: string, event: string, fields: Record<string, unknown>): void {
    this.sink({ level, runId: this.runId, event, ...fields });
  }
}

export function sanitizeDiscoveryError(error: unknown): {
  message: string;
  httpStatus?: number;
} {
  if (error instanceof HttpError) {
    return {
      message: sanitizeText(error.message),
      ...(error.status !== undefined ? { httpStatus: error.status } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const fromText = extractHttpStatus(message);
  return {
    message: sanitizeText(message),
    ...(fromText !== undefined ? { httpStatus: fromText } : {}),
  };
}

export function sanitizeText(value: string): string {
  return value
    .replace(/(?:api[_-]?key|app[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi, '[redacted]')
    .slice(0, 500);
}

export function extractHttpStatus(message: string): number | undefined {
  const match = /\b(?:HTTP\s+)?(\d{3})\b/.exec(message);
  if (!match?.[1]) return undefined;
  const code = Number(match[1]);
  return code >= 100 && code <= 599 ? code : undefined;
}

export function safeJobUrl(job: Pick<NormalizedJob, 'sourceUrl' | 'applyUrl'>): string | undefined {
  const candidate = job.sourceUrl || job.applyUrl;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:') return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function logDiscoverySource(
  logger: ScanLogger,
  source: SourceHealth,
  phase: 'company' | 'marketplace',
): void {
  const failed = !source.healthy && source.status === 'FAILED';
  const payload: Record<string, unknown> = {
    phase,
    boardId: source.companyId,
    provider: source.provider,
    status: source.status ?? (source.healthy ? 'FETCHED' : 'FAILED'),
    healthy: source.healthy,
    jobsFound: source.jobsFound ?? 0,
    latencyMs: source.latencyMs,
    complete: source.complete,
    ...(source.requestsMade !== undefined ? { requestsMade: source.requestsMade } : {}),
  };
  if (source.error) payload.error = sanitizeText(source.error);
  if (source.httpStatus !== undefined) payload.httpStatus = source.httpStatus;
  if (failed) logger.warn('discovery_source', payload);
  else logger.info('discovery_source', payload);
}

export function accumulateSourceFailures(sources: readonly SourceHealth[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const source of sources) {
    if (source.healthy) continue;
    counts[source.provider] = (counts[source.provider] ?? 0) + 1;
  }
  return counts;
}

export type EvaluationDecision =
  'queued' | 'already_queued' | 'below_threshold' | 'ineligible' | 'deferred' | 'failed';

export function logJobEvaluation(
  logger: ScanLogger,
  fields: {
    job: NormalizedJob;
    jobKey: string;
    origin: 'fresh' | 'pending_retry';
    preliminaryScore: number;
    finalScore: number;
    eligible: boolean;
    remoteEligibility: string;
    decision: EvaluationDecision;
    scoreThreshold: number;
  },
): void {
  logger.info('job_evaluated', {
    jobKey: fields.jobKey,
    title: fields.job.title,
    companyId: fields.job.companyId,
    source: fields.job.sourceName ?? fields.job.provider,
    provider: fields.job.provider,
    ...(safeJobUrl(fields.job) ? { jobUrl: safeJobUrl(fields.job) } : {}),
    evaluationOrigin: fields.origin,
    preliminaryScore: fields.preliminaryScore,
    finalScore: fields.finalScore,
    remoteEligibility: fields.remoteEligibility,
    eligible: fields.eligible,
    decision: fields.decision,
    scoreThreshold: fields.scoreThreshold,
  });
}

export interface ScanMetricDefinitions {
  discovered: string;
  evaluated: string;
  queued: string;
  emailed: string;
}

export const SCAN_METRIC_DEFINITIONS: ScanMetricDefinitions = {
  discovered:
    'Distinct jobs returned from company boards and marketplaces before per-job processing caps.',
  evaluated: 'Promising jobs that completed a Bedrock evaluation (includes cache hits).',
  queued: 'Qualifying jobs newly written to the notification queue this run.',
  emailed: 'Queued jobs actually sent via SES in this run (zero when DRY_RUN is true).',
};
