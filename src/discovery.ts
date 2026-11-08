import { Inject, Injectable, Module } from '@nestjs/common';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type {
  CompanyRegistryDocument,
  DiscoveryResult,
  NormalizedJob,
  SourceHealth,
} from './domain.js';
import { ConfigService } from './config.js';
import { HttpClient } from './http-client.js';
import { sanitizeDiscoveryError } from './scan-observability.js';
import { normalizeJob, SourceUrlVerifier } from './normalization.js';
import {
  AshbyProvider,
  GreenhouseProvider,
  JsonFeedProvider,
  LeverProvider,
  type JobProvider,
} from './providers.js';
import { CompanyRegistry } from './registry.js';

export const JOB_PROVIDERS = Symbol('JOB_PROVIDERS');
export const BEDROCK_CLIENT = Symbol('BEDROCK_CLIENT');

@Injectable()
export class DiscoveryService {
  private readonly providersByKind: ReadonlyMap<JobProvider['kind'], JobProvider>;

  constructor(
    @Inject(JOB_PROVIDERS) providers: readonly JobProvider[],
    private readonly verifier: SourceUrlVerifier,
  ) {
    this.providersByKind = new Map(providers.map((provider) => [provider.kind, provider]));
  }

  async discover(registry: CompanyRegistryDocument): Promise<DiscoveryResult> {
    const startedAt = new Date().toISOString();
    const jobs = new Map<string, NormalizedJob>();
    const sources: SourceHealth[] = [];

    for (const company of registry.companies.filter((entry) => entry.enabled)) {
      const started = Date.now();
      try {
        const provider = this.providersByKind.get(company.provider);
        if (!provider) throw new Error(`No provider registered for "${company.provider}"`);
        const providerResult = await provider.fetchJobs(company);
        for (const job of providerResult.jobs) {
          const normalized = normalizeJob(company, job, this.verifier);
          jobs.set(normalized.canonicalId, normalized);
        }
        sources.push({
          companyId: company.id,
          provider: company.provider,
          healthy: true,
          complete: providerResult.complete,
          authoritativeForExpiration: providerResult.complete,
          status: 'FETCHED',
          checkedAt: new Date().toISOString(),
          latencyMs: Date.now() - started,
          jobsFound: providerResult.jobs.length,
        });
      } catch (error) {
        const sanitized = sanitizeDiscoveryError(error);
        sources.push({
          companyId: company.id,
          provider: company.provider,
          healthy: false,
          complete: false,
          authoritativeForExpiration: false,
          status: 'FAILED',
          checkedAt: new Date().toISOString(),
          latencyMs: Date.now() - started,
          error: sanitized.message,
          ...(sanitized.httpStatus !== undefined ? { httpStatus: sanitized.httpStatus } : {}),
        });
      }
    }

    return {
      jobs: [...jobs.values()],
      sources,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

@Module({
  providers: [
    ConfigService,
    {
      provide: HttpClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService): HttpClient =>
        new HttpClient({
          timeoutMs: config.values.HTTP_TIMEOUT_MS,
          maxRetries: config.values.HTTP_MAX_RETRIES,
          requestsPerSecond: config.values.HTTP_REQUESTS_PER_SECOND,
          maxResponseBytes: config.values.HTTP_MAX_RESPONSE_BYTES,
        }),
    },
    {
      provide: GreenhouseProvider,
      inject: [HttpClient],
      useFactory: (http: HttpClient): GreenhouseProvider => new GreenhouseProvider(http),
    },
    {
      provide: LeverProvider,
      inject: [HttpClient],
      useFactory: (http: HttpClient): LeverProvider => new LeverProvider(http),
    },
    {
      provide: AshbyProvider,
      inject: [HttpClient],
      useFactory: (http: HttpClient): AshbyProvider => new AshbyProvider(http),
    },
    {
      provide: JsonFeedProvider,
      inject: [HttpClient],
      useFactory: (http: HttpClient): JsonFeedProvider => new JsonFeedProvider(http),
    },
    {
      provide: JOB_PROVIDERS,
      inject: [GreenhouseProvider, LeverProvider, AshbyProvider, JsonFeedProvider],
      useFactory: (
        greenhouse: GreenhouseProvider,
        lever: LeverProvider,
        ashby: AshbyProvider,
        json: JsonFeedProvider,
      ): readonly JobProvider[] => [greenhouse, lever, ashby, json],
    },
    {
      provide: BEDROCK_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): BedrockRuntimeClient =>
        new BedrockRuntimeClient({ region: config.values.AWS_REGION }),
    },
    SourceUrlVerifier,
    {
      provide: CompanyRegistry,
      inject: [ConfigService],
      useFactory: (config: ConfigService): CompanyRegistry =>
        new CompanyRegistry(config.values.COMPANY_REGISTRY_PATH, config.values.PROFILE_PATH),
    },
    DiscoveryService,
  ],
  exports: [
    ConfigService,
    HttpClient,
    JOB_PROVIDERS,
    BEDROCK_CLIENT,
    CompanyRegistry,
    DiscoveryService,
  ],
})
// Nest modules are intentionally metadata-only classes.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class DiscoveryModule {}
