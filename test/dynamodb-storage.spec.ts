import { describe, expect, it, vi } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { EvaluationRecord } from '../src/ai.js';
import type { MatchResult } from '../src/domain.js';
import type { NotificationBatch, PendingNotification } from '../src/storage.js';
import { DynamoJobStorage } from '../src/storage.js';

function assertUpdateUsesResultAlias(command: UpdateCommand): void {
  expect(command.input.UpdateExpression).toContain('#result = :result');
  expect(command.input.ExpressionAttributeNames).toMatchObject({
    '#result': 'result',
  });
}

function assertUpdateAliasesStatus(command: UpdateCommand): void {
  expect(command.input.ExpressionAttributeNames).toMatchObject({ '#status': 'status' });
  expect(command.input.UpdateExpression).toContain('#status');
}

describe('DynamoJobStorage pagination', () => {
  it('follows LastEvaluatedKey for multi-page queries', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            value: {
              userId: 'default',
              canonicalId: 'one',
              state: 'interested',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
        LastEvaluatedKey: { PK: 'FEEDBACK#default', SK: 'one' },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            value: {
              userId: 'default',
              canonicalId: 'two',
              state: 'applied',
              updatedAt: '2026-01-02T00:00:00.000Z',
            },
          },
        ],
      });
    const document = { send } as unknown as DynamoDBDocumentClient;
    const storage = new DynamoJobStorage('table', new DynamoDBClient({}), document);

    const feedback = await storage.feedback('default');

    expect(feedback.map((item) => item.canonicalId)).toEqual(['one', 'two']);
    expect(send).toHaveBeenCalledTimes(2);
    const secondCommand: unknown = send.mock.calls[1]?.[0];
    expect(secondCommand).toBeInstanceOf(QueryCommand);
    expect((secondCommand as QueryCommand).input.ExclusiveStartKey).toEqual({
      PK: 'FEEDBACK#default',
      SK: 'one',
    });
  });
});

describe('DynamoJobStorage scan lease', () => {
  it('aliases reserved attribute names when releasing a lease', async () => {
    const send = vi.fn().mockResolvedValue({});
    const storage = new DynamoJobStorage('table', new DynamoDBClient({}), {
      send,
    } as unknown as DynamoDBDocumentClient);

    await storage.releaseLease('run-123');

    const command: unknown = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(DeleteCommand);
    const input = (command as DeleteCommand).input;
    expect(input.ConditionExpression).toBe('#owner = :owner');
    expect(input.ExpressionAttributeNames).toEqual({ '#owner': 'owner' });
    expect(input.ExpressionAttributeValues).toEqual({ ':owner': 'run-123' });
  });

  it('ignores missing or foreign leases when releasing', async () => {
    const send = vi.fn().mockRejectedValue(
      Object.assign(new Error('The conditional request failed'), {
        name: 'ConditionalCheckFailedException',
      }),
    );
    const storage = new DynamoJobStorage('table', new DynamoDBClient({}), {
      send,
    } as unknown as DynamoDBDocumentClient);

    await expect(storage.releaseLease('not-owner')).resolves.toBeUndefined();
  });
});

describe('DynamoJobStorage pending evaluation failures', () => {
  const job = {
    canonicalId: 'job-1',
    dedupeKey: 'job-1',
    companyId: 'acme',
    provider: 'greenhouse' as const,
    externalId: '1',
    title: 'Senior Engineer',
    location: 'Remote Canada',
    description: 'TypeScript on AWS',
    applyUrl: 'https://example.com/apply',
    sourceUrl: 'https://example.com/job',
    updatedAt: null,
    contentHash: 'hash-1',
  };

  it('refuses to record a failure when no full pending item exists', async () => {
    const send = vi.fn().mockRejectedValue(
      Object.assign(new Error('The conditional request failed'), {
        name: 'ConditionalCheckFailedException',
      }),
    );
    const storage = new DynamoJobStorage('table', new DynamoDBClient({}), {
      send,
    } as unknown as DynamoDBDocumentClient);

    await expect(
      storage.recordPendingEvaluationFailure('default', 'job-1', 'Bedrock unavailable'),
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledOnce();
    const command: unknown = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(UpdateCommand);
    expect((command as UpdateCommand).input.ConditionExpression).toBe('attribute_exists(#job)');
  });

  it('persists job data and failure metadata together when enqueue records an error', async () => {
    const send = vi.fn().mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) return Promise.resolve({ Item: undefined });
      if (command instanceof PutCommand) return Promise.resolve({});
      return Promise.resolve({});
    });
    const storage = new DynamoJobStorage('table', new DynamoDBClient({}), {
      send,
    } as unknown as DynamoDBDocumentClient);

    await storage.enqueuePendingEvaluation(
      'default',
      job,
      'profile-v1',
      'evaluation_error',
      'Bedrock unavailable',
    );

    const putCall = send.mock.calls.find(
      ([command]) => command instanceof PutCommand,
    )?.[0] as PutCommand;
    expect(putCall.input.Item).toMatchObject({
      userId: 'default',
      jobKey: 'job-1',
      profileVersion: 'profile-v1',
      job,
      attempts: 1,
      lastError: 'Bedrock unavailable',
      reason: 'evaluation_error',
    });
  });

  it('increments attempts only when updating an existing pending record', async () => {
    const send = vi.fn().mockResolvedValue({});
    const storage = new DynamoJobStorage('table', new DynamoDBClient({}), {
      send,
    } as unknown as DynamoDBDocumentClient);

    await storage.recordPendingEvaluationFailure('default', 'job-1', 'Still failing');

    const command: unknown = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(UpdateCommand);
    expect((command as UpdateCommand).input.UpdateExpression).toContain('attempts');
  });
});

describe('DynamoJobStorage notification lifecycle updates', () => {
  const send = vi.fn().mockResolvedValue({});
  const storage = new DynamoJobStorage('table', new DynamoDBClient({}), {
    send,
  } as unknown as DynamoDBDocumentClient);

  const evaluation: EvaluationRecord = {
    cacheKey: 'cache',
    evaluation: {
      strengths: [],
      weaknesses: [],
      mustHaveGaps: [],
      remoteEligibility: 'CONFIRMED',
      legitimacySignals: [],
      fitScore: 90,
      confidence: 1,
      recommendation: 'Apply',
    },
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    modelId: 'mock',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const match: MatchResult = {
    job: {
      canonicalId: 'job-1',
      dedupeKey: 'job-1',
      companyId: 'acme',
      provider: 'greenhouse',
      externalId: '1',
      title: 'Senior Engineer',
      location: 'Remote — Canada',
      description: 'TypeScript',
      applyUrl: 'https://example.com/apply',
      sourceUrl: 'https://example.com/job',
      updatedAt: null,
      contentHash: 'hash-1',
    },
    score: 90,
    preliminaryScore: 80,
    breakdown: {
      skills: 20,
      role: 20,
      seniority: 10,
      remote: 15,
      compensation: 0,
      interests: 0,
      legitimacy: 10,
      feedback: 0,
    },
    remoteEligibility: 'CONFIRMED',
    reasons: [],
    gaps: [],
    salary: null,
    eligible: true,
    promising: true,
  };

  const pendingItem: PendingNotification = {
    userId: 'default',
    notificationKey: 'job-1#hash-1',
    match,
    evaluation,
    createdAt: '2026-01-01T00:00:00.000Z',
    attempts: 1,
  };

  const batch: NotificationBatch = {
    batchId: 'batch-uuid',
    userId: 'default',
    status: 'SENDING',
    items: [pendingItem],
    attempts: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('aliases reserved result on completeBatch notification and batch updates', async () => {
    send.mockClear();
    await storage.completeBatch(batch, 'ses-message-id');

    const updates = send.mock.calls
      .map((call) => call[0] as unknown)
      .filter((command): command is UpdateCommand => command instanceof UpdateCommand);

    expect(updates.length).toBeGreaterThanOrEqual(2);
    const notifyUpdate = updates.find((command) => command.input.Key?.PK === 'NOTIFY#default');
    const batchUpdate = updates.find((command) => command.input.Key?.PK === 'BATCH#default');
    if (!notifyUpdate || !batchUpdate) {
      throw new Error('Expected NOTIFY and BATCH UpdateCommands');
    }
    assertUpdateUsesResultAlias(notifyUpdate);
    assertUpdateUsesResultAlias(batchUpdate);
    assertUpdateAliasesStatus(notifyUpdate);
    assertUpdateAliasesStatus(batchUpdate);
  });

  it('aliases reserved result on failBatch batch metadata update', async () => {
    send.mockClear();
    await storage.failBatch(batch, 'SES throttled');

    const updates = send.mock.calls
      .map((call) => call[0] as unknown)
      .filter((command): command is UpdateCommand => command instanceof UpdateCommand);

    const notifyRevert = updates.find((command) => command.input.Key?.PK === 'NOTIFY#default');
    const batchUpdate = updates.find((command) => command.input.Key?.PK === 'BATCH#default');
    if (!notifyRevert || !batchUpdate) {
      throw new Error('Expected NOTIFY revert and BATCH UpdateCommands');
    }
    expect(notifyRevert.input.UpdateExpression).not.toContain('#result');
    assertUpdateUsesResultAlias(batchUpdate);
    assertUpdateAliasesStatus(batchUpdate);
    assertUpdateAliasesStatus(notifyRevert);
  });

  it('claimBatch marks notifications SENDING with status alias only', async () => {
    send.mockClear();
    send
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({
        Items: [
          {
            PK: 'NOTIFY#default',
            SK: 'job-1#hash-1',
            notificationKey: 'job-1#hash-1',
            userId: 'default',
            status: 'PENDING',
            match,
            evaluation,
            createdAt: '2026-01-01T00:00:00.000Z',
            attempts: 0,
            GSI1PK: 'PENDING#default',
            GSI1SK: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValue({});

    await storage.claimBatch('default', 5);

    const claimUpdate = send.mock.calls
      .map((call) => call[0] as unknown)
      .find(
        (command): command is UpdateCommand =>
          command instanceof UpdateCommand && command.input.Key?.PK === 'NOTIFY#default',
      );
    if (!claimUpdate) {
      throw new Error('Expected claim UpdateCommand on NOTIFY item');
    }
    assertUpdateAliasesStatus(claimUpdate);
    expect(claimUpdate.input.UpdateExpression).toContain('batchId');
  });
});
