import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/http-client.js';
import {
  ScanLogger,
  accumulateSourceFailures,
  extractHttpStatus,
  logDiscoverySource,
  logJobEvaluation,
  sanitizeDiscoveryError,
  sanitizeText,
} from '../src/scan-observability.js';
import type { SourceHealth } from '../src/domain.js';

describe('scan observability', () => {
  it('sanitizes credential patterns and preserves HTTP status', () => {
    const error = new HttpError('Request failed with HTTP 503', 503, 'https://example.com');
    expect(sanitizeDiscoveryError(error)).toEqual({
      message: 'Request failed with HTTP 503',
      httpStatus: 503,
    });
    expect(sanitizeText('Missing api_key=supersecretvalue')).toContain('[redacted]');
    expect(extractHttpStatus('upstream HTTP 429 too many requests')).toBe(429);
  });

  it('logs discovery sources with jobs found and latency', () => {
    const events: Record<string, unknown>[] = [];
    const logger = new ScanLogger('run-1', (payload) => events.push(payload));
    const source: SourceHealth = {
      companyId: 'acme',
      provider: 'greenhouse',
      healthy: true,
      complete: true,
      status: 'FETCHED',
      checkedAt: new Date().toISOString(),
      latencyMs: 120,
      jobsFound: 4,
    };
    logDiscoverySource(logger, source, 'company');
    expect(events[0]).toMatchObject({
      runId: 'run-1',
      event: 'discovery_source',
      boardId: 'acme',
      jobsFound: 4,
      latencyMs: 120,
    });
  });

  it('aggregates source failures by provider', () => {
    const counts = accumulateSourceFailures([
      {
        companyId: 'a',
        provider: 'lever',
        healthy: false,
        complete: false,
        checkedAt: '',
        latencyMs: 1,
        status: 'FAILED',
      },
      {
        companyId: 'b',
        provider: 'lever',
        healthy: false,
        complete: false,
        checkedAt: '',
        latencyMs: 1,
        status: 'MISSING_CREDENTIALS',
      },
      {
        companyId: 'c',
        provider: 'adzuna',
        healthy: true,
        complete: true,
        checkedAt: '',
        latencyMs: 1,
      },
    ]);
    expect(counts).toEqual({ lever: 2 });
  });

  it('logs evaluation outcomes without descriptions', () => {
    const events: Record<string, unknown>[] = [];
    const logger = new ScanLogger('run-2', (payload) => events.push(payload));
    logJobEvaluation(logger, {
      jobKey: 'job-1',
      origin: 'fresh',
      preliminaryScore: 70,
      finalScore: 86,
      eligible: true,
      remoteEligibility: 'CONFIRMED',
      decision: 'queued',
      scoreThreshold: 80,
      job: {
        canonicalId: 'job-1',
        companyId: 'acme',
        provider: 'greenhouse',
        externalId: '1',
        title: 'Senior Engineer',
        location: 'Remote',
        description: 'Secret CV details should never appear',
        applyUrl: 'https://example.com/apply',
        sourceUrl: 'https://example.com/job',
        updatedAt: null,
        contentHash: 'hash',
      },
    });
    expect(events[0]).toMatchObject({
      event: 'job_evaluated',
      decision: 'queued',
      evaluationOrigin: 'fresh',
      jobUrl: 'https://example.com/job',
    });
    expect(JSON.stringify(events[0])).not.toContain('Secret CV');
  });
});
