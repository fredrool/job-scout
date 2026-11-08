import { describe, expect, it, vi } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { DynamoJobStorage } from '../src/storage.js';

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
