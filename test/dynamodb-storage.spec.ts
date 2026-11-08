import { describe, expect, it, vi } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
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
