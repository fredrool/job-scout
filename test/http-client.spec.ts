import { describe, expect, it, vi } from 'vitest';
import { HttpClient, HttpError } from '../src/http-client.js';

describe('HttpClient', () => {
  it('retries a rate limit with backoff', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new HttpClient(
      { timeoutMs: 1000, maxRetries: 2, requestsPerSecond: 100, baseBackoffMs: 1 },
      fetcher,
      sleep,
      () => 0,
    );
    await expect(client.getJson('https://example.com/jobs')).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalled();
  });

  it('rejects oversized and unsafe responses', async () => {
    const client = new HttpClient(
      {
        timeoutMs: 1000,
        maxRetries: 0,
        requestsPerSecond: 100,
        maxResponseBytes: 4,
      },
      vi.fn().mockResolvedValue(new Response('12345', { status: 200 })),
      vi.fn().mockResolvedValue(undefined),
    );
    await expect(client.getJson('https://example.com/jobs')).rejects.toBeInstanceOf(HttpError);
    await expect(client.getJson('http://127.0.0.1/jobs')).rejects.toBeInstanceOf(HttpError);
  });
});
