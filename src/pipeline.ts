import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from './config.js';
import { DiscoveryService } from './discovery.js';
import { BedrockEvaluator } from './ai.js';
import { applyLlmEvaluation, MatchingService } from './matching.js';
import { CompanyRegistry } from './registry.js';
import type { JobStorage } from './storage.js';
import { SesNotificationService } from './notifications.js';
import { deduplicateJobs, MarketplaceDiscoveryService } from './marketplace-discovery.js';
import type { NormalizedJob, SearchProfile, UserFeedback } from './domain.js';
import type { EvaluationRecord } from './ai.js';

export interface ScanSummary {
  runId: string;
  discovered: number;
  evaluated: number;
  queued: number;
  emailed: number;
  skippedBecauseLocked: boolean;
  sourceFailures: number;
  dryRun: boolean;
  pendingDeferred: number;
  pendingProcessed: number;
}

type EvaluationStopReason = 'continue' | 'bedrock_cap' | 'deadline' | 'evaluation_failed';

@Injectable()
export class ScanPipeline {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(CompanyRegistry) private readonly registry: CompanyRegistry,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MarketplaceDiscoveryService)
    private readonly marketplaceDiscovery: MarketplaceDiscoveryService,
    @Inject(MatchingService) private readonly matching: MatchingService,
    @Inject(BedrockEvaluator) private readonly evaluator: BedrockEvaluator,
    @Inject('JOB_STORAGE') private readonly storage: JobStorage,
    @Inject(SesNotificationService) private readonly notifications: SesNotificationService,
  ) {}

  async run(): Promise<ScanSummary> {
    const runId = randomUUID();
    const summary: ScanSummary = {
      runId,
      discovered: 0,
      evaluated: 0,
      queued: 0,
      emailed: 0,
      skippedBecauseLocked: false,
      sourceFailures: 0,
      dryRun: this.config.values.DRY_RUN,
      pendingDeferred: 0,
      pendingProcessed: 0,
    };
    const leaseSeconds = Math.ceil(this.config.values.MAX_RUNTIME_MS / 1000) + 30;
    if (!(await this.storage.acquireLease(runId, leaseSeconds))) {
      summary.skippedBecauseLocked = true;
      return summary;
    }
    const deadline = Date.now() + this.config.values.MAX_RUNTIME_MS;
    try {
      this.evaluator.resetRun();
      const [registry, profile, feedback] = await Promise.all([
        this.registry.load(),
        this.registry.loadProfile(),
        this.storage.feedback(this.config.values.USER_ID),
      ]);
      const [marketplaceDiscovery, companyDiscovery] = await Promise.all([
        this.marketplaceDiscovery.discover(),
        this.discovery.discover({
          companies: registry.companies.slice(0, this.config.values.MAX_REQUESTS_PER_SCAN),
        }),
      ]);
      const discovery = {
        jobs: deduplicateJobs([...marketplaceDiscovery.jobs, ...companyDiscovery.jobs]),
        sources: [...marketplaceDiscovery.sources, ...companyDiscovery.sources],
      };
      summary.discovered = discovery.jobs.length;
      summary.sourceFailures = discovery.sources.filter((source) => !source.healthy).length;

      const promisingCandidates: NormalizedJob[] = [];
      for (const discoveredJob of discovery.jobs.slice(0, this.config.values.MAX_JOBS_PER_SCAN)) {
        const now = new Date().toISOString();
        const job = {
          ...discoveredJob,
          firstSeenAt: now,
          lastSeenAt: now,
          sourcePublishedAt: discoveredJob.updatedAt,
        };
        const change = await this.storage.upsertJob(job);
        if (!change.isNew && !change.materiallyChanged) continue;
        const match = this.matching.evaluate(change.job, profile, feedback);
        if (match.promising) promisingCandidates.push(change.job);
      }

      const pendingStop = await this.drainPendingEvaluations(
        runId,
        profile,
        feedback,
        summary,
        deadline,
      );
      if (pendingStop === 'continue') {
        await this.evaluatePromisingJobs(
          runId,
          promisingCandidates,
          profile,
          feedback,
          summary,
          deadline,
        );
      } else {
        await this.deferJobs(runId, promisingCandidates, profile.version, pendingStop, summary);
      }

      for (const source of discovery.sources.filter(
        (item) => item.healthy && item.complete && item.authoritativeForExpiration,
      )) {
        const seen = discovery.jobs
          .filter((job) => job.companyId === source.companyId)
          .map((job) => job.canonicalId);
        await this.storage.markMissingExpired(source.companyId, seen);
      }

      if (this.config.values.DRY_RUN) return summary;
      const batch = await this.storage.claimBatch(
        this.config.values.USER_ID,
        this.config.values.DIGEST_LIMIT,
      );
      if (!batch) return summary;
      try {
        const messageId = await this.notifications.send(
          batch,
          this.config.values.NOTIFICATION_EMAIL,
        );
        await this.storage.completeBatch(batch, messageId);
        summary.emailed = batch.items.length;
      } catch (error) {
        await this.storage.failBatch(batch, error instanceof Error ? error.message : String(error));
        throw error;
      }
      return summary;
    } finally {
      await this.storage.releaseLease(runId);
    }
  }

  private async drainPendingEvaluations(
    runId: string,
    profile: SearchProfile,
    feedback: UserFeedback[],
    summary: ScanSummary,
    deadline: number,
  ): Promise<EvaluationStopReason> {
    const pending = await this.storage.listPendingEvaluations(this.config.values.USER_ID, 500);
    for (const item of pending) {
      if (Date.now() >= deadline) return 'deadline';
      if (!this.evaluator.hasCapacity()) return 'bedrock_cap';
      const jobKey = item.job.dedupeKey ?? item.job.canonicalId;
      const match = this.matching.evaluate(item.job, profile, feedback);
      if (!match.promising) {
        await this.storage.removePendingEvaluation(this.config.values.USER_ID, jobKey);
        continue;
      }
      const outcome = await this.evaluateMatch(runId, match, profile, summary, {
        deferOnError: false,
      });
      if (outcome === 'bedrock_cap') return 'bedrock_cap';
      if (outcome === 'deadline') return 'deadline';
      if (outcome === 'evaluation_failed') continue;
      await this.storage.removePendingEvaluation(this.config.values.USER_ID, jobKey);
      summary.pendingProcessed += 1;
    }
    return 'continue';
  }

  private async evaluatePromisingJobs(
    runId: string,
    jobs: readonly NormalizedJob[],
    profile: SearchProfile,
    feedback: UserFeedback[],
    summary: ScanSummary,
    deadline: number,
  ): Promise<void> {
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      if (!job) break;
      if (Date.now() >= deadline) {
        await this.deferRemaining(jobs, index, profile.version, 'runtime_deadline', summary);
        return;
      }
      if (!this.evaluator.hasCapacity()) {
        await this.deferRemaining(jobs, index, profile.version, 'bedrock_cap', summary);
        return;
      }
      const match = this.matching.evaluate(job, profile, feedback);
      if (!match.promising) continue;
      const outcome = await this.evaluateMatch(runId, match, profile, summary);
      if (outcome === 'bedrock_cap') {
        await this.deferRemaining(jobs, index, profile.version, 'bedrock_cap', summary);
        return;
      }
      if (outcome === 'deadline') {
        await this.deferRemaining(jobs, index, profile.version, 'runtime_deadline', summary);
        return;
      }
    }
  }

  private async evaluateMatch(
    runId: string,
    match: ReturnType<MatchingService['evaluate']>,
    profile: SearchProfile,
    summary: ScanSummary,
    options: { deferOnError?: boolean } = {},
  ): Promise<EvaluationStopReason> {
    try {
      const evaluation = await this.evaluator.evaluate(match, profile);
      summary.evaluated += 1;
      await this.queueIfQualifying(match, evaluation, summary);
      return 'continue';
    } catch (error) {
      if (error instanceof Error && error.message === 'Per-scan Bedrock call cap reached') {
        return 'bedrock_cap';
      }
      const message = error instanceof Error ? error.message : String(error);
      const jobKey = match.job.dedupeKey ?? match.job.canonicalId;
      if (options.deferOnError !== false) {
        await this.enqueueDeferred(
          match.job,
          profile.version,
          'evaluation_error',
          summary,
          message,
        );
      } else {
        await this.storage.recordPendingEvaluationFailure(
          this.config.values.USER_ID,
          jobKey,
          message,
        );
      }
      console.error(
        JSON.stringify({
          level: 'error',
          runId,
          event: 'evaluation_failed',
          jobKey,
          error: message,
        }),
      );
      return 'evaluation_failed';
    }
  }

  private async queueIfQualifying(
    match: ReturnType<MatchingService['evaluate']>,
    evaluation: EvaluationRecord,
    summary: ScanSummary,
  ): Promise<void> {
    const finalMatch = applyLlmEvaluation(match, evaluation.evaluation);
    if (!finalMatch.eligible || finalMatch.score < this.config.values.SCORE_THRESHOLD) return;
    if (await this.storage.queue(finalMatch, evaluation, this.config.values.USER_ID)) {
      summary.queued += 1;
    }
  }

  private async deferJobs(
    runId: string,
    jobs: readonly NormalizedJob[],
    profileVersion: string,
    reason: EvaluationStopReason,
    summary: ScanSummary,
  ): Promise<void> {
    const label = reason === 'bedrock_cap' ? 'bedrock_cap' : 'runtime_deadline';
    for (const job of jobs) {
      await this.enqueueDeferred(job, profileVersion, label, summary);
    }
    if (jobs.length) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          runId,
          event: 'evaluation_deferred',
          reason: label,
          count: jobs.length,
        }),
      );
    }
  }

  private async enqueueDeferred(
    job: NormalizedJob,
    profileVersion: string,
    reason: string,
    summary: ScanSummary,
    failureError?: string,
  ): Promise<void> {
    await this.storage.enqueuePendingEvaluation(
      this.config.values.USER_ID,
      job,
      profileVersion,
      reason,
      failureError,
    );
    summary.pendingDeferred += 1;
  }

  private async deferRemaining(
    jobs: readonly NormalizedJob[],
    startIndex: number,
    profileVersion: string,
    reason: string,
    summary: ScanSummary,
  ): Promise<void> {
    for (const job of jobs.slice(startIndex)) {
      await this.enqueueDeferred(job, profileVersion, reason, summary);
    }
  }
}
