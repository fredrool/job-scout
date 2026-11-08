import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AdzunaSearchCursor } from './adzuna-scheduler.js';
import type { EvaluationCache, EvaluationRecord } from './ai.js';
import type {
  EvaluationPersistContext,
  PersistedEvaluationSnapshot,
} from './evaluation-persist.js';
import type {
  MarketplaceProviderKind,
  MatchResult,
  NormalizedJob,
  UserFeedback,
} from './domain.js';

export interface PendingEvaluation {
  userId: string;
  jobKey: string;
  profileVersion: string;
  job: NormalizedJob;
  createdAt: string;
  attempts: number;
  lastError?: string;
  reason?: string;
}

export interface PendingNotification {
  userId: string;
  notificationKey: string;
  match: MatchResult;
  evaluation: EvaluationRecord;
  createdAt: string;
  attempts: number;
}

export interface NotificationBatch {
  batchId: string;
  userId: string;
  status: 'SENDING' | 'SENT' | 'FAILED';
  items: PendingNotification[];
  attempts: number;
  createdAt: string;
}

export interface ProviderState {
  provider: MarketplaceProviderKind;
  lastFetchAt: string;
  lastSuccessAt?: string;
  status: 'SUCCESS' | 'FAILED';
  requestsMade: number;
  error?: string;
  adzunaCursor?: AdzunaSearchCursor;
}

export interface JobStorage extends EvaluationCache {
  acquireLease(owner: string, ttlSeconds: number): Promise<boolean>;
  releaseLease(owner: string): Promise<void>;
  upsertJob(
    job: NormalizedJob,
  ): Promise<{ isNew: boolean; materiallyChanged: boolean; job: NormalizedJob }>;
  markMissingExpired(companyId: string, seenCanonicalIds: readonly string[]): Promise<number>;
  queue(match: MatchResult, evaluation: EvaluationRecord, userId: string): Promise<boolean>;
  claimBatch(userId: string, limit: number): Promise<NotificationBatch | undefined>;
  completeBatch(batch: NotificationBatch, sesMessageId: string): Promise<void>;
  failBatch(batch: NotificationBatch, reason: string): Promise<void>;
  feedback(userId: string): Promise<UserFeedback[]>;
  putFeedback(value: UserFeedback): Promise<void>;
  getProviderState(provider: MarketplaceProviderKind): Promise<ProviderState | undefined>;
  putProviderState(state: ProviderState): Promise<void>;
  enqueuePendingEvaluation(
    userId: string,
    job: NormalizedJob,
    profileVersion: string,
    reason?: string,
    failureError?: string,
  ): Promise<void>;
  listPendingEvaluations(userId: string, limit: number): Promise<PendingEvaluation[]>;
  removePendingEvaluation(userId: string, jobKey: string): Promise<void>;
  recordPendingEvaluationFailure(userId: string, jobKey: string, error: string): Promise<void>;
  listActiveJobs(limit: number): Promise<NormalizedJob[]>;
  listScoredNotifications(userId: string, limit: number): Promise<ScoredNotificationSnapshot[]>;
  listIndexedEvaluations(userId: string, limit: number): Promise<PersistedEvaluationSnapshot[]>;
  buildEvaluationCacheMap(maxItems: number): Promise<Map<string, PersistedEvaluationSnapshot>>;
  getJobByKey(jobKey: string): Promise<NormalizedJob | undefined>;
}

export function createReviewJobStorage(tableName: string): DynamoJobStorage {
  return new DynamoJobStorage(tableName);
}

export interface ScoredNotificationSnapshot {
  notificationKey: string;
  match: MatchResult;
  evaluation: EvaluationRecord;
  createdAt: string;
}

@Injectable()
export class DynamoJobStorage implements JobStorage {
  private readonly document: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client: DynamoDBClient = new DynamoDBClient({}),
    documentClient?: DynamoDBDocumentClient,
  ) {
    this.document =
      documentClient ??
      DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  async acquireLease(owner: string, ttlSeconds: number): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    try {
      await this.document.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { PK: 'LOCK#SCAN', SK: 'LOCK', owner, expiresAt: now + ttlSeconds },
          ConditionExpression: 'attribute_not_exists(PK) OR expiresAt < :now',
          ExpressionAttributeValues: { ':now': now },
        }),
      );
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }

  async releaseLease(owner: string): Promise<void> {
    try {
      await this.document.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { PK: 'LOCK#SCAN', SK: 'LOCK' },
          ConditionExpression: '#owner = :owner',
          ExpressionAttributeNames: { '#owner': 'owner' },
          ExpressionAttributeValues: { ':owner': owner },
        }),
      );
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
    }
  }

  async upsertJob(
    job: NormalizedJob,
  ): Promise<{ isNew: boolean; materiallyChanged: boolean; job: NormalizedJob }> {
    const key = { PK: `JOB#${job.dedupeKey ?? job.canonicalId}`, SK: 'JOB' };
    const prior = await this.document.send(new GetCommand({ TableName: this.tableName, Key: key }));
    const previous = prior.Item as (Partial<NormalizedJob> & { status?: string }) | undefined;
    const mergedJob = previous ? mergeJobEvidence(previous, job) : job;
    const now = new Date().toISOString();
    const reopened = previous?.status === 'EXPIRED';
    await this.document.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...key,
          ...mergedJob,
          firstSeenAt: (prior.Item?.firstSeenAt as string | undefined) ?? now,
          lastSeenAt: now,
          status: reopened ? 'REOPENED' : 'ACTIVE',
          GSI1PK: 'JOBSTATUS#ACTIVE',
          GSI1SK: now,
          GSI2PK: `COMPANY#${mergedJob.companyId}`,
          GSI2SK: `${(prior.Item?.firstSeenAt as string | undefined) ?? now}#${mergedJob.canonicalId}`,
        },
      }),
    );
    return {
      isNew: !previous,
      materiallyChanged: Boolean(previous && isMaterialJobChange(previous, mergedJob)),
      job: mergedJob,
    };
  }

  async markMissingExpired(
    companyId: string,
    seenCanonicalIds: readonly string[],
  ): Promise<number> {
    const seen = new Set(seenCanonicalIds);
    const items = await this.queryAll({
      TableName: this.tableName,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :company',
      ExpressionAttributeValues: { ':company': `COMPANY#${companyId}` },
    });
    let expired = 0;
    for (const item of items) {
      const canonicalId = item.canonicalId as string;
      if (seen.has(canonicalId) || item.status === 'EXPIRED') continue;
      await this.document.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: item.PK as string, SK: item.SK as string },
          UpdateExpression: 'SET #status = :expired, GSI1PK = :statusKey, GSI1SK = :changedAt',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':expired': 'EXPIRED',
            ':statusKey': 'JOBSTATUS#EXPIRED',
            ':changedAt': new Date().toISOString(),
          },
        }),
      );
      expired += 1;
    }
    return expired;
  }

  async queue(match: MatchResult, evaluation: EvaluationRecord, userId: string): Promise<boolean> {
    const notificationKey = `${match.job.dedupeKey ?? match.job.canonicalId}#${match.job.contentHash}`;
    const now = new Date().toISOString();
    try {
      await this.document.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            PK: `NOTIFY#${userId}`,
            SK: notificationKey,
            entityType: 'NOTIFICATION',
            userId,
            notificationKey,
            match,
            evaluation,
            status: 'PENDING',
            attempts: 0,
            createdAt: now,
            GSI1PK: `PENDING#${userId}`,
            GSI1SK: now,
            GSI3PK: `SCORE#${userId}`,
            GSI3SK: `${String(match.score).padStart(3, '0')}#${now}`,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }

  async claimBatch(userId: string, limit: number): Promise<NotificationBatch | undefined> {
    await this.recoverExpiredClaims(userId);
    const candidates = (await this.queryAll(
      {
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pending',
        ExpressionAttributeValues: { ':pending': `PENDING#${userId}` },
      },
      limit,
    )) as unknown as PendingNotification[];
    if (!candidates.length) return undefined;
    const batchId = randomUUID();
    const items: PendingNotification[] = [];
    for (const candidate of candidates) {
      try {
        await this.document.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { PK: `NOTIFY#${userId}`, SK: candidate.notificationKey },
            UpdateExpression:
              'SET #status = :sending, batchId = :batchId, attempts = attempts + :one, GSI1PK = :claimed, GSI1SK = :claimExpiry',
            ConditionExpression: '#status = :pending',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':sending': 'SENDING',
              ':pending': 'PENDING',
              ':batchId': batchId,
              ':one': 1,
              ':claimed': `CLAIMED#${userId}`,
              ':claimExpiry': new Date(Date.now() + 10 * 60_000).toISOString(),
            },
          }),
        );
        items.push(candidate);
      } catch (error) {
        if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      }
    }
    if (!items.length) return undefined;
    const batch: NotificationBatch = {
      batchId,
      userId,
      status: 'SENDING',
      items,
      attempts: 1,
      createdAt: new Date().toISOString(),
    };
    await this.document.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { PK: `BATCH#${userId}`, SK: batchId, ...batch },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    return batch;
  }

  async completeBatch(batch: NotificationBatch, sesMessageId: string): Promise<void> {
    for (const item of batch.items) {
      await this.updateNotification(batch.userId, item.notificationKey, 'SENT', {
        sesMessageId,
        sentAt: new Date().toISOString(),
      });
    }
    await this.updateBatch(batch, 'SENT', { sesMessageId, sentAt: new Date().toISOString() });
  }

  async failBatch(batch: NotificationBatch, reason: string): Promise<void> {
    for (const item of batch.items) {
      await this.document.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: `NOTIFY#${batch.userId}`, SK: item.notificationKey },
          UpdateExpression:
            'SET #status = :pending, lastError = :reason, GSI1PK = :gpk, GSI1SK = :gsk REMOVE batchId',
          ConditionExpression: 'batchId = :batchId',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':pending': 'PENDING',
            ':reason': reason.slice(0, 500),
            ':gpk': `PENDING#${batch.userId}`,
            ':gsk': item.createdAt,
            ':batchId': batch.batchId,
          },
        }),
      );
    }
    await this.updateBatch(batch, 'FAILED', { lastError: reason.slice(0, 500) });
  }

  async getEvaluation(key: string): Promise<EvaluationRecord | undefined> {
    const result = await this.document.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `EVAL#${key}`, SK: 'EVALUATION' },
      }),
    );
    return result.Item?.record as EvaluationRecord | undefined;
  }

  async putEvaluation(record: EvaluationRecord, context?: EvaluationPersistContext): Promise<void> {
    await this.document.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `EVAL#${record.cacheKey}`,
          SK: 'EVALUATION',
          record,
          ...(context
            ? {
                jobKey: context.jobKey,
                contentHash: context.contentHash,
                profileVersion: context.profileVersion,
                modelId: context.modelId,
                GSI3PK: `EVALREVIEW#${context.userId}`,
                GSI3SK: `${record.createdAt}#${context.jobKey}`,
              }
            : {}),
        },
      }),
    );
  }

  async feedback(userId: string): Promise<UserFeedback[]> {
    const items = await this.queryAll({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `FEEDBACK#${userId}` },
    });
    return items.map((item) => item.value as UserFeedback);
  }

  async putFeedback(value: UserFeedback): Promise<void> {
    await this.document.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `FEEDBACK#${value.userId}`,
          SK: value.canonicalId,
          value,
        },
      }),
    );
  }

  async getProviderState(provider: MarketplaceProviderKind): Promise<ProviderState | undefined> {
    const result = await this.document.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `SOURCE#MARKETPLACE#${provider}`, SK: 'STATE' },
      }),
    );
    return result.Item?.state as ProviderState | undefined;
  }

  async putProviderState(state: ProviderState): Promise<void> {
    await this.document.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `SOURCE#MARKETPLACE#${state.provider}`,
          SK: 'STATE',
          state,
          GSI1PK: 'SOURCEHEALTH',
          GSI1SK: `${state.status}#${state.lastFetchAt}`,
        },
      }),
    );
  }

  async enqueuePendingEvaluation(
    userId: string,
    job: NormalizedJob,
    profileVersion: string,
    reason?: string,
    failureError?: string,
  ): Promise<void> {
    const jobKey = job.dedupeKey ?? job.canonicalId;
    const now = new Date().toISOString();
    const existing = await this.document.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `EVALPENDING#${userId}`, SK: jobKey },
      }),
    );
    const prior = existing.Item as PendingEvaluation | undefined;
    const attempts = (prior?.attempts ?? 0) + (failureError ? 1 : 0);
    await this.document.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `EVALPENDING#${userId}`,
          SK: jobKey,
          userId,
          jobKey,
          profileVersion,
          job,
          createdAt: prior?.createdAt ?? now,
          attempts,
          ...(reason ? { reason } : {}),
          ...(failureError ? { lastError: failureError.slice(0, 500) } : {}),
          GSI1PK: `EVALPENDING#${userId}`,
          GSI1SK: prior?.createdAt ?? now,
        },
      }),
    );
  }

  async listPendingEvaluations(userId: string, limit: number): Promise<PendingEvaluation[]> {
    const items = await this.queryAll(
      {
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pending',
        ExpressionAttributeValues: { ':pending': `EVALPENDING#${userId}` },
      },
      limit,
    );
    return items.map((item) => ({
      userId: item.userId as string,
      jobKey: item.jobKey as string,
      profileVersion: item.profileVersion as string,
      job: item.job as NormalizedJob,
      createdAt: item.createdAt as string,
      attempts: (item.attempts as number | undefined) ?? 0,
      ...(item.lastError ? { lastError: item.lastError as string } : {}),
      ...(item.reason ? { reason: item.reason as string } : {}),
    }));
  }

  async removePendingEvaluation(userId: string, jobKey: string): Promise<void> {
    await this.document.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { PK: `EVALPENDING#${userId}`, SK: jobKey },
      }),
    );
  }

  async listActiveJobs(limit: number): Promise<NormalizedJob[]> {
    const items = await this.queryAll(
      {
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :active',
        ExpressionAttributeValues: { ':active': 'JOBSTATUS#ACTIVE' },
      },
      limit,
    );
    return items.map((item) => itemToNormalizedJob(item));
  }

  async getJobByKey(jobKey: string): Promise<NormalizedJob | undefined> {
    const result = await this.document.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `JOB#${jobKey}`, SK: 'JOB' },
      }),
    );
    const item = result.Item;
    if (!item || item.status === 'EXPIRED') return undefined;
    return itemToNormalizedJob(item);
  }

  async listIndexedEvaluations(
    userId: string,
    limit: number,
  ): Promise<PersistedEvaluationSnapshot[]> {
    const items = await this.queryAll(
      {
        TableName: this.tableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'GSI3PK = :review',
        ExpressionAttributeValues: { ':review': `EVALREVIEW#${userId}` },
        ScanIndexForward: false,
      },
      limit,
    );
    return items.map((item) => snapshotFromEvaluationItem(item));
  }

  async buildEvaluationCacheMap(
    maxItems: number,
  ): Promise<Map<string, PersistedEvaluationSnapshot>> {
    const map = new Map<string, PersistedEvaluationSnapshot>();
    let exclusiveStartKey: Record<string, unknown> | undefined;
    while (map.size < maxItems) {
      const result = await this.document.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: 'begins_with(PK, :prefix) AND SK = :sk',
          ExpressionAttributeValues: { ':prefix': 'EVAL#', ':sk': 'EVALUATION' },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          Limit: Math.min(100, Math.max(1, maxItems - map.size)),
        }),
      );
      for (const item of (result.Items ?? []) as Record<string, unknown>[]) {
        const snapshot = snapshotFromEvaluationItem(item);
        map.set(snapshot.cacheKey, snapshot);
        if (map.size >= maxItems) break;
      }
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (!exclusiveStartKey) break;
    }
    return map;
  }

  async listScoredNotifications(
    userId: string,
    limit: number,
  ): Promise<ScoredNotificationSnapshot[]> {
    const items = await this.queryAll(
      {
        TableName: this.tableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'GSI3PK = :score',
        ExpressionAttributeValues: { ':score': `SCORE#${userId}` },
        ScanIndexForward: false,
      },
      limit,
    );
    return items.map((item) => ({
      notificationKey: item.notificationKey as string,
      match: item.match as MatchResult,
      evaluation: item.evaluation as EvaluationRecord,
      createdAt: (item.createdAt as string | undefined) ?? new Date(0).toISOString(),
    }));
  }

  async recordPendingEvaluationFailure(
    userId: string,
    jobKey: string,
    error: string,
  ): Promise<void> {
    try {
      await this.document.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: `EVALPENDING#${userId}`, SK: jobKey },
          UpdateExpression:
            'SET attempts = if_not_exists(attempts, :zero) + :one, lastError = :error',
          ConditionExpression: 'attribute_exists(#job)',
          ExpressionAttributeNames: { '#job': 'job' },
          ExpressionAttributeValues: {
            ':zero': 0,
            ':one': 1,
            ':error': error.slice(0, 500),
          },
        }),
      );
    } catch (caught) {
      if ((caught as { name?: string }).name === 'ConditionalCheckFailedException') return;
      throw caught;
    }
  }

  private async queryAll(
    input: QueryCommandInput,
    maximumItems?: number,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: QueryCommandInput['ExclusiveStartKey'];
    do {
      const remaining =
        maximumItems === undefined ? undefined : Math.max(1, maximumItems - items.length);
      const result = await this.document.send(
        new QueryCommand({
          ...input,
          ...(remaining === undefined ? {} : { Limit: remaining }),
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      items.push(...((result.Items ?? []) as Record<string, unknown>[]));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey && (maximumItems === undefined || items.length < maximumItems));
    return maximumItems === undefined ? items : items.slice(0, maximumItems);
  }

  private async updateNotification(
    userId: string,
    notificationKey: string,
    status: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.document.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: `NOTIFY#${userId}`, SK: notificationKey },
        UpdateExpression: 'SET #status = :status, result = :result REMOVE batchId, GSI1PK, GSI1SK',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status, ':result': extra },
      }),
    );
  }

  private async updateBatch(
    batch: NotificationBatch,
    status: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.document.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: `BATCH#${batch.userId}`, SK: batch.batchId },
        UpdateExpression: 'SET #status = :status, result = :result',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status, ':result': extra },
      }),
    );
  }

  private async recoverExpiredClaims(userId: string): Promise<void> {
    const now = new Date().toISOString();
    const items = await this.queryAll({
      TableName: this.tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :claimed AND GSI1SK <= :now',
      ExpressionAttributeValues: { ':claimed': `CLAIMED#${userId}`, ':now': now },
    });
    for (const item of items) {
      await this.document.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: item.PK as string, SK: item.SK as string },
          UpdateExpression:
            'SET #status = :pending, GSI1PK = :pendingKey, GSI1SK = :createdAt REMOVE batchId',
          ConditionExpression: '#status = :sending AND GSI1SK <= :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':pending': 'PENDING',
            ':sending': 'SENDING',
            ':pendingKey': `PENDING#${userId}`,
            ':createdAt': (item.createdAt as string | undefined) ?? now,
            ':now': now,
          },
        }),
      );
    }
  }
}

export class MemoryJobStorage implements JobStorage {
  private lease: { owner: string; expiresAt: number } | undefined;
  private readonly evaluations = new Map<string, EvaluationRecord>();
  private readonly evaluationIndex = new Map<string, PersistedEvaluationSnapshot>();
  private readonly jobs = new Map<
    string,
    {
      job: NormalizedJob;
      companyId: string;
      status: 'ACTIVE' | 'EXPIRED' | 'REOPENED';
    }
  >();
  private readonly pending = new Map<string, PendingNotification>();
  private readonly feedbackItems: UserFeedback[] = [];
  private readonly providerStates = new Map<MarketplaceProviderKind, ProviderState>();
  private readonly pendingEvaluations = new Map<string, PendingEvaluation>();

  private pendingEvalKey(userId: string, jobKey: string): string {
    return `${userId}#${jobKey}`;
  }

  acquireLease(owner: string, ttlSeconds: number): Promise<boolean> {
    if (this.lease && this.lease.expiresAt > Date.now()) return Promise.resolve(false);
    this.lease = { owner, expiresAt: Date.now() + ttlSeconds * 1000 };
    return Promise.resolve(true);
  }
  releaseLease(owner: string): Promise<void> {
    if (this.lease?.owner === owner) this.lease = undefined;
    return Promise.resolve();
  }
  upsertJob(
    job: NormalizedJob,
  ): Promise<{ isNew: boolean; materiallyChanged: boolean; job: NormalizedJob }> {
    const key = job.dedupeKey ?? job.canonicalId;
    const prior = this.jobs.get(key);
    const mergedJob = prior ? mergeJobEvidence(prior.job, job) : job;
    this.jobs.set(key, {
      job: mergedJob,
      companyId: mergedJob.companyId,
      status: prior?.status === 'EXPIRED' ? 'REOPENED' : 'ACTIVE',
    });
    return Promise.resolve({
      isNew: !prior,
      materiallyChanged: Boolean(prior && isMaterialJobChange(prior.job, mergedJob)),
      job: mergedJob,
    });
  }
  markMissingExpired(companyId: string, seenCanonicalIds: readonly string[]): Promise<number> {
    const seen = new Set(seenCanonicalIds);
    let expired = 0;
    for (const [id, job] of this.jobs) {
      if (job.companyId === companyId && !seen.has(id) && job.status !== 'EXPIRED') {
        this.jobs.set(id, { ...job, status: 'EXPIRED' });
        expired += 1;
      }
    }
    return Promise.resolve(expired);
  }
  queue(match: MatchResult, evaluation: EvaluationRecord, userId: string): Promise<boolean> {
    const notificationKey = `${match.job.dedupeKey ?? match.job.canonicalId}#${match.job.contentHash}`;
    if (this.pending.has(notificationKey)) return Promise.resolve(false);
    this.pending.set(notificationKey, {
      userId,
      notificationKey,
      match,
      evaluation,
      createdAt: new Date().toISOString(),
      attempts: 0,
    });
    return Promise.resolve(true);
  }
  claimBatch(userId: string, limit: number): Promise<NotificationBatch | undefined> {
    const items = [...this.pending.values()]
      .filter((item) => item.userId === userId)
      .slice(0, limit);
    if (!items.length) return Promise.resolve(undefined);
    return Promise.resolve({
      batchId: randomUUID(),
      userId,
      status: 'SENDING',
      items,
      attempts: 1,
      createdAt: new Date().toISOString(),
    });
  }
  completeBatch(batch: NotificationBatch, sesMessageId: string): Promise<void> {
    if (!sesMessageId) return Promise.reject(new Error('SES message ID is required'));
    batch.items.forEach((item) => this.pending.delete(item.notificationKey));
    return Promise.resolve();
  }
  failBatch(): Promise<void> {
    return Promise.resolve();
  }
  getEvaluation(key: string): Promise<EvaluationRecord | undefined> {
    return Promise.resolve(this.evaluations.get(key));
  }
  putEvaluation(record: EvaluationRecord, context?: EvaluationPersistContext): Promise<void> {
    this.evaluations.set(record.cacheKey, record);
    if (context) {
      this.evaluationIndex.set(`${context.userId}#${context.jobKey}`, {
        cacheKey: record.cacheKey,
        record,
        jobKey: context.jobKey,
        contentHash: context.contentHash,
        profileVersion: context.profileVersion,
        modelId: context.modelId,
      });
    }
    return Promise.resolve();
  }
  feedback(userId: string): Promise<UserFeedback[]> {
    return Promise.resolve(this.feedbackItems.filter((item) => item.userId === userId));
  }
  putFeedback(value: UserFeedback): Promise<void> {
    this.feedbackItems.push(value);
    return Promise.resolve();
  }
  getProviderState(provider: MarketplaceProviderKind): Promise<ProviderState | undefined> {
    return Promise.resolve(this.providerStates.get(provider));
  }
  putProviderState(state: ProviderState): Promise<void> {
    this.providerStates.set(state.provider, state);
    return Promise.resolve();
  }
  enqueuePendingEvaluation(
    userId: string,
    job: NormalizedJob,
    profileVersion: string,
    reason?: string,
    failureError?: string,
  ): Promise<void> {
    const jobKey = job.dedupeKey ?? job.canonicalId;
    const key = this.pendingEvalKey(userId, jobKey);
    const prior = this.pendingEvaluations.get(key);
    const createdAt = prior?.createdAt ?? new Date().toISOString();
    const attempts = (prior?.attempts ?? 0) + (failureError ? 1 : 0);
    this.pendingEvaluations.set(key, {
      userId,
      jobKey,
      profileVersion,
      job,
      createdAt,
      attempts,
      ...(reason ? { reason } : {}),
      ...(failureError ? { lastError: failureError.slice(0, 500) } : {}),
    });
    return Promise.resolve();
  }
  listPendingEvaluations(userId: string, limit: number): Promise<PendingEvaluation[]> {
    return Promise.resolve(
      [...this.pendingEvaluations.values()]
        .filter((item) => item.userId === userId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, limit),
    );
  }
  removePendingEvaluation(userId: string, jobKey: string): Promise<void> {
    this.pendingEvaluations.delete(this.pendingEvalKey(userId, jobKey));
    return Promise.resolve();
  }
  recordPendingEvaluationFailure(userId: string, jobKey: string, error: string): Promise<void> {
    const key = this.pendingEvalKey(userId, jobKey);
    const prior = this.pendingEvaluations.get(key);
    if (!prior) return Promise.resolve();
    this.pendingEvaluations.set(key, {
      ...prior,
      attempts: prior.attempts + 1,
      lastError: error.slice(0, 500),
    });
    return Promise.resolve();
  }
  listActiveJobs(limit: number): Promise<NormalizedJob[]> {
    return Promise.resolve(
      [...this.jobs.values()]
        .filter((entry) => entry.status === 'ACTIVE')
        .map((entry) => entry.job)
        .slice(0, limit),
    );
  }
  listScoredNotifications(userId: string, limit: number): Promise<ScoredNotificationSnapshot[]> {
    return Promise.resolve(
      [...this.pending.values()]
        .filter((item) => item.userId === userId)
        .sort((left, right) => right.match.score - left.match.score)
        .slice(0, limit)
        .map((item) => ({
          notificationKey: item.notificationKey,
          match: item.match,
          evaluation: item.evaluation,
          createdAt: item.createdAt,
        })),
    );
  }
  getJobByKey(jobKey: string): Promise<NormalizedJob | undefined> {
    const entry = this.jobs.get(jobKey);
    if (!entry || entry.status === 'EXPIRED') return Promise.resolve(undefined);
    return Promise.resolve(entry.job);
  }
  listIndexedEvaluations(userId: string, limit: number): Promise<PersistedEvaluationSnapshot[]> {
    const prefix = `${userId}#`;
    return Promise.resolve(
      [...this.evaluationIndex.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, snapshot]) => snapshot)
        .sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt))
        .slice(0, limit),
    );
  }
  buildEvaluationCacheMap(maxItems: number): Promise<Map<string, PersistedEvaluationSnapshot>> {
    const map = new Map<string, PersistedEvaluationSnapshot>();
    for (const snapshot of this.evaluationIndex.values()) {
      map.set(snapshot.cacheKey, snapshot);
      if (map.size >= maxItems) break;
    }
    for (const [cacheKey, record] of this.evaluations) {
      if (map.has(cacheKey)) continue;
      map.set(cacheKey, { cacheKey, record });
      if (map.size >= maxItems) break;
    }
    return Promise.resolve(map);
  }
}

function snapshotFromEvaluationItem(item: Record<string, unknown>): PersistedEvaluationSnapshot {
  const record = item.record as EvaluationRecord;
  return {
    cacheKey: record.cacheKey,
    record,
    ...(typeof item.jobKey === 'string' ? { jobKey: item.jobKey } : {}),
    ...(typeof item.contentHash === 'string' ? { contentHash: item.contentHash } : {}),
    ...(typeof item.profileVersion === 'string' ? { profileVersion: item.profileVersion } : {}),
    ...(typeof item.modelId === 'string' ? { modelId: item.modelId } : {}),
  };
}

function itemToNormalizedJob(item: Record<string, unknown>): NormalizedJob {
  const {
    PK: _pk,
    SK: _sk,
    GSI1PK: _g1pk,
    GSI1SK: _g1sk,
    GSI2PK: _g2pk,
    GSI2SK: _g2sk,
    status: _status,
    ...job
  } = item;
  return job as unknown as NormalizedJob;
}

export function mergeJobEvidence(
  previous: Partial<NormalizedJob>,
  current: NormalizedJob,
): NormalizedJob {
  const keepPrevious = previous.sourceKind === 'EMPLOYER' && current.sourceKind === 'MARKETPLACE';
  const preferred = keepPrevious ? { ...current, ...previous } : current;
  const sourceUrls = new Map<string, NonNullable<NormalizedJob['sourceUrls']>[number]>();
  for (const source of [...(previous.sourceUrls ?? []), ...(current.sourceUrls ?? [])]) {
    sourceUrls.set(source.url, source);
  }
  return {
    ...current,
    ...preferred,
    sourceUrls: [...sourceUrls.values()],
    dedupeKey: current.dedupeKey ?? previous.dedupeKey,
  } as NormalizedJob;
}

export function isMaterialJobChange(
  previous: Partial<NormalizedJob>,
  current: NormalizedJob,
): boolean {
  if (previous.contentHash === current.contentHash) return false;
  if (previous.title !== current.title || previous.location !== current.location) {
    return true;
  }
  if (previous.sourceKind === 'MARKETPLACE' && current.sourceKind === 'EMPLOYER') return true;
  if (
    previous.sourceKind === 'MARKETPLACE' &&
    current.sourceKind === 'MARKETPLACE' &&
    previous.provider !== current.provider
  ) {
    return false;
  }
  if (
    previous.sourceKind === 'EMPLOYER' &&
    current.sourceKind === 'EMPLOYER' &&
    (previous.applyUrl !== current.applyUrl || previous.sourceUrl !== current.sourceUrl)
  ) {
    return true;
  }
  const previousDescription = previous.description ?? '';
  const currentDescription = current.description ?? '';
  if (materialSignals(previousDescription) !== materialSignals(currentDescription)) return true;
  return jaccardSimilarity(previousDescription, currentDescription) < 0.9;
}

function materialSignals(value: string): string {
  return value
    .toLowerCase()
    .split(/[.!?\n]+/)
    .filter((sentence) =>
      /\b(required|must|minimum|remote|hybrid|on-site|onsite|salary|compensation|cad|usd|\$)\b/.test(
        sentence,
      ),
    )
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .sort()
    .join('|');
}

function jaccardSimilarity(left: string, right: string): number {
  const tokens = (value: string): Set<string> =>
    new Set(value.toLowerCase().match(/[a-z0-9+#.]{3,}/g) ?? []);
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}
