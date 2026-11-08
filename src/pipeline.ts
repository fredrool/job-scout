import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from './config.js';
import { DiscoveryService } from './discovery.js';
import { BedrockEvaluator } from './ai.js';
import { applyLlmEvaluation, MatchingService } from './matching.js';
import { CompanyRegistry } from './registry.js';
import type { JobStorage } from './storage.js';
import { SesNotificationService } from './notifications.js';

export interface ScanSummary {
  runId: string;
  discovered: number;
  evaluated: number;
  queued: number;
  emailed: number;
  skippedBecauseLocked: boolean;
  sourceFailures: number;
  dryRun: boolean;
}

@Injectable()
export class ScanPipeline {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(CompanyRegistry) private readonly registry: CompanyRegistry,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
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
      const discovery = await this.discovery.discover({
        companies: registry.companies.slice(0, this.config.values.MAX_REQUESTS_PER_SCAN),
      });
      summary.discovered = discovery.jobs.length;
      summary.sourceFailures = discovery.sources.filter((source) => !source.healthy).length;
      for (const discoveredJob of discovery.jobs.slice(0, this.config.values.MAX_JOBS_PER_SCAN)) {
        if (Date.now() >= deadline) break;
        const now = new Date().toISOString();
        const job = {
          ...discoveredJob,
          firstSeenAt: now,
          lastSeenAt: now,
          sourcePublishedAt: discoveredJob.updatedAt,
        };
        const change = await this.storage.upsertJob(job);
        if (!change.isNew && !change.materiallyChanged) continue;
        const match = this.matching.evaluate(job, profile, feedback);
        if (!match.promising) continue;
        try {
          const evaluation = await this.evaluator.evaluate(match, profile);
          summary.evaluated += 1;
          const finalMatch = applyLlmEvaluation(match, evaluation.evaluation);
          if (!finalMatch.eligible || finalMatch.score < this.config.values.SCORE_THRESHOLD) {
            continue;
          }
          if (await this.storage.queue(finalMatch, evaluation, this.config.values.USER_ID)) {
            summary.queued += 1;
          }
        } catch (error) {
          if (error instanceof Error && error.message === 'Per-scan Bedrock call cap reached') {
            break;
          }
          console.error(
            JSON.stringify({
              level: 'error',
              runId,
              event: 'evaluation_failed',
              error: String(error),
            }),
          );
        }
      }

      for (const source of discovery.sources.filter((item) => item.healthy && item.complete)) {
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
}
