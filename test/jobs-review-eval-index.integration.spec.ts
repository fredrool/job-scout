import { describe, expect, it, vi } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
  type ScanCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { AppConfig } from '../src/config.js';
import type { EvaluationRecord } from '../src/ai.js';
import { evaluationCacheKey } from '../src/evaluation-cache-key.js';
import { listEvaluatedJobsForReview } from '../src/jobs-review.js';
import { applyLlmEvaluation, MatchingService } from '../src/matching.js';
import type { EvaluationPersistContext } from '../src/evaluation-persist.js';
import type { NormalizedJob, SearchProfile } from '../src/domain.js';
import { DynamoJobStorage } from '../src/storage.js';

const TABLE_NAME = 'job-scout-eval-index-integration-test';
const USER_ID = 'integration-user';

const profile: SearchProfile = {
  version: '1',
  userId: USER_ID,
  name: 'Integration profile',
  targetTitles: ['Senior Software Engineer'],
  skills: [{ name: 'TypeScript', proficiency: 'expert', evidence: 'Production systems' }],
  workHistorySummary: 'Senior backend engineer',
  locations: ['Canada'],
  remoteOnly: true,
  preferredRegions: ['Canada'],
  compensation: { currency: 'CAD' },
  hardExclusions: [],
  learningInterests: [],
  feedbackPreferences: { rejectionPenalty: 4 },
};

const appConfig = {
  USER_ID,
  BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  MOCK_MODE: false,
  DYNAMODB_TABLE_NAME: TABLE_NAME,
  AWS_REGION: 'us-east-1',
  SCORE_THRESHOLD: 80,
} as AppConfig;

function pearsonJob(): NormalizedJob {
  return {
    canonicalId: 'pearson-carter:platform-engineer',
    dedupeKey: 'pearson-carter:platform-engineer',
    companyId: 'pearson-carter',
    provider: 'greenhouse',
    externalId: 'pc-42',
    title: 'Senior Platform Engineer',
    location: 'Remote — Canada',
    description: 'TypeScript, AWS, and NestJS platform engineering.',
    applyUrl: 'https://careers.pearsoncarter.example/jobs/pc-42/apply',
    sourceUrl: 'https://careers.pearsoncarter.example/jobs/pc-42',
    updatedAt: '2026-03-02T00:00:00.000Z',
    contentHash: 'pearson-hash-v1',
  };
}

function legacyJob(): NormalizedJob {
  return {
    canonicalId: 'lemon-io:senior-node',
    dedupeKey: 'lemon-io:senior-node',
    companyId: 'lemon-io',
    provider: 'lever',
    externalId: 'lemon-7',
    title: 'Senior Node.js Engineer',
    location: 'Remote — Canada',
    description: 'Node.js and TypeScript product development.',
    applyUrl: 'https://lemon.io/jobs/senior-node/apply',
    sourceUrl: 'https://lemon.io/jobs/senior-node',
    updatedAt: '2026-02-28T12:00:00.000Z',
    contentHash: 'lemon-hash-legacy',
  };
}

type TableItem = Record<string, unknown>;

function sortableString(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function rowKey(pk: string, sk: string): string {
  return `${pk}\u0000${sk}`;
}

class InMemoryDynamoTable {
  readonly items = new Map<string, TableItem>();

  put(item: TableItem): void {
    const pk = String(item.PK);
    const sk = String(item.SK);
    this.items.set(rowKey(pk, sk), { ...item });
  }

  get(pk: string, sk: string): TableItem | undefined {
    return this.items.get(rowKey(pk, sk));
  }

  private gsiMatches(gsiField: 'GSI1PK' | 'GSI3PK', value: string): TableItem[] {
    return [...this.items.values()].filter((item) => item[gsiField] === value);
  }

  query(input: QueryCommandInput): {
    Items: TableItem[];
    LastEvaluatedKey?: Record<string, unknown>;
  } {
    const values = input.ExpressionAttributeValues ?? {};
    let matches: TableItem[] = [];
    if (input.IndexName === 'GSI3') {
      const reviewKey = values[':review'] as string;
      const scoreKey = values[':score'] as string | undefined;
      if (reviewKey) {
        matches = this.gsiMatches('GSI3PK', reviewKey);
      } else if (scoreKey) {
        matches = this.gsiMatches('GSI3PK', scoreKey);
      }
      const sortField = 'GSI3SK';
      matches.sort((left, right) =>
        sortableString(left[sortField]).localeCompare(sortableString(right[sortField])),
      );
      if (input.ScanIndexForward === false) {
        matches.reverse();
      }
    } else if (input.IndexName === 'GSI1') {
      const activeKey = values[':active'] as string;
      matches = this.gsiMatches('GSI1PK', activeKey);
    } else {
      const pk = values[':pk'] as string;
      matches = [...this.items.values()].filter((item) => item.PK === pk);
    }

    if (input.ExclusiveStartKey) {
      const startPk = String(input.ExclusiveStartKey.PK);
      const startSk = String(input.ExclusiveStartKey.SK);
      const startIndex = matches.findIndex((item) => item.PK === startPk && item.SK === startSk);
      matches = startIndex >= 0 ? matches.slice(startIndex + 1) : matches;
    }

    const limit = input.Limit ?? matches.length;
    const page = matches.slice(0, limit);
    const last = page.at(-1);
    const LastEvaluatedKey =
      matches.length > limit && last ? { PK: last.PK, SK: last.SK } : undefined;
    return { Items: page, ...(LastEvaluatedKey ? { LastEvaluatedKey } : {}) };
  }

  scan(input: ScanCommandInput): {
    Items: TableItem[];
    LastEvaluatedKey?: Record<string, unknown>;
  } {
    const values = input.ExpressionAttributeValues ?? {};
    const prefix = String(values[':prefix'] ?? '');
    const sk = String(values[':sk'] ?? '');
    let matches = [...this.items.values()].filter(
      (item) => typeof item.PK === 'string' && item.PK.startsWith(prefix) && item.SK === sk,
    );

    if (input.ExclusiveStartKey) {
      const startPk = String(input.ExclusiveStartKey.PK);
      const startSk = String(input.ExclusiveStartKey.SK);
      const startIndex = matches.findIndex((item) => item.PK === startPk && item.SK === startSk);
      matches = startIndex >= 0 ? matches.slice(startIndex + 1) : matches;
    }

    const limit = input.Limit ?? matches.length;
    const page = matches.slice(0, limit);
    const last = page.at(-1);
    const LastEvaluatedKey =
      matches.length > limit && last ? { PK: last.PK, SK: last.SK } : undefined;
    return { Items: page, ...(LastEvaluatedKey ? { LastEvaluatedKey } : {}) };
  }

  notifyItems(): TableItem[] {
    return [...this.items.values()].filter(
      (item) => typeof item.PK === 'string' && item.PK.startsWith('NOTIFY#'),
    );
  }
}

function createMockDocument(table: InMemoryDynamoTable): {
  client: DynamoDBDocumentClient;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn((command: unknown) => {
    if (command instanceof PutCommand) {
      table.put(command.input.Item as TableItem);
      return Promise.resolve({});
    }
    if (command instanceof GetCommand) {
      const key = command.input.Key ?? {};
      const item = table.get(String(key.PK), String(key.SK));
      return Promise.resolve(item ? { Item: item } : {});
    }
    if (command instanceof QueryCommand) {
      return Promise.resolve(table.query(command.input));
    }
    if (command instanceof ScanCommand) {
      return Promise.resolve(table.scan(command.input));
    }
    return Promise.resolve({});
  });
  return {
    client: { send } as unknown as DynamoDBDocumentClient,
    send,
  };
}

function evaluationForJob(
  job: NormalizedJob,
  fitScore: number,
  recommendation: string,
): EvaluationRecord {
  const cacheKey = evaluationCacheKey(job, profile, appConfig.BEDROCK_MODEL_ID);
  return {
    cacheKey,
    evaluation: {
      strengths: ['TypeScript'],
      weaknesses: [],
      mustHaveGaps: [],
      remoteEligibility: 'CONFIRMED',
      legitimacySignals: ['HTTPS careers URL'],
      fitScore,
      confidence: 0.9,
      recommendation,
    },
    inputTokens: 800,
    outputTokens: 180,
    estimatedCostUsd: 0.001,
    modelId: appConfig.BEDROCK_MODEL_ID,
    createdAt: '2026-03-02T05:00:00.000Z',
  };
}

function persistContext(job: NormalizedJob): EvaluationPersistContext {
  return {
    userId: USER_ID,
    jobKey: job.dedupeKey ?? job.canonicalId,
    contentHash: job.contentHash,
    profileVersion: profile.version,
    modelId: appConfig.BEDROCK_MODEL_ID,
  };
}

function fitScoreForTargetPreliminary(preliminaryScore: number, targetFinal: number): number {
  return Math.round((targetFinal - preliminaryScore * 0.4) / 0.6);
}

describe('evaluation review index integration (mocked DynamoDB)', () => {
  it('persists EVALREVIEW GSI3 attributes and jobs:review reads indexed evaluations below notify threshold', async () => {
    const table = new InMemoryDynamoTable();
    const { client, send } = createMockDocument(table);
    const storage = new DynamoJobStorage(TABLE_NAME, new DynamoDBClient({}), client);
    const job = pearsonJob();
    const matching = new MatchingService();
    const preliminary = matching.evaluate(job, profile, []);
    const targetScore = 72;
    const fitScore = fitScoreForTargetPreliminary(preliminary.preliminaryScore, targetScore);
    const recommendation =
      'Pearson Carter role fits senior platform work; confirm team scope and Canada hiring.';
    const record = evaluationForJob(job, fitScore, recommendation);

    await storage.upsertJob(job);
    await storage.putEvaluation(record, persistContext(job));

    const jobKey = job.dedupeKey ?? job.canonicalId;
    const putEval = send.mock.calls
      .map((call) => call[0] as unknown)
      .find(
        (command): command is PutCommand =>
          command instanceof PutCommand && String(command.input.Item?.PK).startsWith('EVAL#'),
      );
    expect(putEval?.input.Item).toMatchObject({
      GSI3PK: `EVALREVIEW#${USER_ID}`,
      GSI3SK: `${record.createdAt}#${jobKey}`,
      jobKey: job.dedupeKey,
      contentHash: job.contentHash,
      profileVersion: profile.version,
    });

    const indexed = await storage.listIndexedEvaluations(USER_ID, 20);
    expect(indexed).toHaveLength(1);
    expect(indexed[0]?.cacheKey).toBe(record.cacheKey);
    expect(indexed[0]?.jobKey).toBe(job.dedupeKey);

    const scoredNotifications = await storage.listScoredNotifications(USER_ID, 20);
    expect(scoredNotifications).toHaveLength(0);
    expect(table.notifyItems()).toHaveLength(0);

    const result = await listEvaluatedJobsForReview(storage, profile, appConfig, {
      minScore: 60,
      limit: 10,
      eligibleOnly: false,
      maxActiveJobs: 50,
      diagnostic: true,
      maxEvaluationCacheEntries: 100,
    });

    const expectedScore = applyLlmEvaluation(preliminary, record.evaluation).score;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      jobKey: job.dedupeKey,
      finalScore: expectedScore,
      title: job.title,
      companyId: job.companyId,
      recommendation,
      jobUrl: job.sourceUrl,
    });
    expect(result.rows[0]?.finalScore).toBeGreaterThanOrEqual(60);
    expect(result.rows[0]?.finalScore).toBeLessThan(appConfig.SCORE_THRESHOLD);
    expect(result.diagnostics?.inspected.indexedEvaluations).toBe(1);

    expect(
      send.mock.calls.some((call) => {
        const command = call[0] as unknown;
        return (
          command instanceof QueryCommand &&
          command.input.ExpressionAttributeValues?.[':review'] === `EVALREVIEW#${USER_ID}`
        );
      }),
    ).toBe(true);
  });

  it('reads legacy EVAL# rows without EVALREVIEW attributes through scan and active-job fallback', async () => {
    const table = new InMemoryDynamoTable();
    const { client, send } = createMockDocument(table);
    const storage = new DynamoJobStorage(TABLE_NAME, new DynamoDBClient({}), client);
    const job = legacyJob();
    const recommendation = 'Lemon.io contract role — verify Canada eligibility before applying.';
    const record = evaluationForJob(job, 78, recommendation);

    await storage.upsertJob(job);
    table.put({
      PK: `EVAL#${record.cacheKey}`,
      SK: 'EVALUATION',
      record,
    });

    const indexed = await storage.listIndexedEvaluations(USER_ID, 20);
    expect(indexed).toHaveLength(0);

    const result = await listEvaluatedJobsForReview(storage, profile, appConfig, {
      minScore: 60,
      limit: 10,
      eligibleOnly: false,
      maxActiveJobs: 50,
      diagnostic: true,
      maxEvaluationCacheEntries: 100,
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      jobKey: job.dedupeKey,
      title: job.title,
      companyId: job.companyId,
      recommendation,
      jobUrl: job.sourceUrl,
    });
    expect(result.diagnostics?.inspected.indexedEvaluations).toBe(0);
    expect(result.diagnostics?.inspected.evaluationCacheEntries).toBeGreaterThanOrEqual(1);

    expect(
      send.mock.calls.some((call) => {
        const command = call[0] as unknown;
        return (
          command instanceof ScanCommand &&
          command.input.ExpressionAttributeValues?.[':prefix'] === 'EVAL#'
        );
      }),
    ).toBe(true);
    expect(table.notifyItems()).toHaveLength(0);
  });
});
