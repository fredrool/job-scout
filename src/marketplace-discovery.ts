import { Inject, Injectable } from '@nestjs/common';
import type {
  DiscoveryResult,
  MarketplaceProviderKind,
  NormalizedJob,
  SourceHealth,
} from './domain.js';
import { JobBoardsRegistry, type MarketplaceBoardConfig } from './marketplace-config.js';
import type { MarketplaceProvider } from './marketplace-providers.js';
import type { JobStorage, ProviderState } from './storage.js';

export const MARKETPLACE_PROVIDERS = Symbol('MARKETPLACE_PROVIDERS');

@Injectable()
export class MarketplaceDiscoveryService {
  private readonly providers: ReadonlyMap<MarketplaceProviderKind, MarketplaceProvider>;

  constructor(
    @Inject(MARKETPLACE_PROVIDERS) providers: readonly MarketplaceProvider[],
    @Inject(JobBoardsRegistry) private readonly registry: JobBoardsRegistry,
    @Inject('JOB_STORAGE') private readonly storage: JobStorage,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.kind, provider]));
  }

  async discover(
    options: {
      provider?: MarketplaceProviderKind;
      force?: boolean;
    } = {},
  ): Promise<DiscoveryResult> {
    const startedAt = new Date().toISOString();
    const document = await this.registry.load();
    const jobs: NormalizedJob[] = [];
    const sources: SourceHealth[] = [];
    for (const config of document.providers.filter(
      (candidate) =>
        (candidate.enabled || (options.force && options.provider === candidate.provider)) &&
        (!options.provider || candidate.provider === options.provider),
    )) {
      const health = await this.fetchProvider(config, options.force ?? false);
      jobs.push(...health.jobs);
      sources.push(health.source);
    }
    return {
      jobs: deduplicateJobs(jobs),
      sources,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  private async fetchProvider(
    config: MarketplaceBoardConfig,
    force: boolean,
  ): Promise<{ jobs: NormalizedJob[]; source: SourceHealth }> {
    const provider = this.providers.get(config.provider);
    const started = Date.now();
    if (!provider) {
      return {
        jobs: [],
        source: sourceHealth(config, false, false, started, 'FAILED', 'Provider is not registered'),
      };
    }
    const previous = await this.storage.getProviderState(config.provider);
    if (!force && previous && !pollingDue(previous, config.pollIntervalMinutes)) {
      return {
        jobs: [],
        source: {
          ...sourceHealth(config, true, false, started, 'SKIPPED_INTERVAL'),
          checkedAt: previous.lastFetchAt,
        },
      };
    }
    const credentials = credentialsFor(config);
    if (!credentials.available) {
      return {
        jobs: [],
        source: sourceHealth(
          config,
          false,
          false,
          started,
          'MISSING_CREDENTIALS',
          credentials.message,
        ),
      };
    }
    const fetchedAt = new Date().toISOString();
    try {
      const result = await provider.fetch(config, process.env as Readonly<Record<string, string>>, {
        ...(config.provider === 'adzuna' && previous?.adzunaCursor
          ? { adzunaCursor: previous.adzunaCursor }
          : {}),
      });
      await this.storage.putProviderState({
        provider: config.provider,
        lastFetchAt: fetchedAt,
        lastSuccessAt: fetchedAt,
        status: 'SUCCESS',
        requestsMade: result.requestsMade,
        ...(config.provider === 'adzuna' && result.nextAdzunaCursor
          ? { adzunaCursor: result.nextAdzunaCursor }
          : {}),
      });
      return {
        jobs: result.jobs,
        source: {
          ...sourceHealth(config, true, result.complete, started, 'FETCHED'),
          jobsFound: result.jobs.length,
          requestsMade: result.requestsMade,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown marketplace error';
      const state: ProviderState = {
        provider: config.provider,
        lastFetchAt: fetchedAt,
        ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
        status: 'FAILED',
        requestsMade: 0,
        error: message,
      };
      await this.storage.putProviderState(state);
      return {
        jobs: [],
        source: sourceHealth(config, false, false, started, 'FAILED', message),
      };
    }
  }
}

function sourceHealth(
  config: MarketplaceBoardConfig,
  healthy: boolean,
  complete: boolean,
  started: number,
  status: NonNullable<SourceHealth['status']>,
  error?: string,
): SourceHealth {
  return {
    companyId: `marketplace:${config.provider}`,
    provider: config.provider,
    healthy,
    complete,
    authoritativeForExpiration: false,
    status,
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - started,
    ...(error ? { error } : {}),
  };
}

function pollingDue(state: ProviderState, intervalMinutes: number): boolean {
  return Date.now() - new Date(state.lastFetchAt).getTime() >= intervalMinutes * 60_000;
}

function credentialsFor(config: MarketplaceBoardConfig): {
  available: boolean;
  message?: string;
} {
  if (config.provider === 'remotive') return { available: true };
  const names =
    config.provider === 'adzuna' ? [config.appIdEnv, config.appKeyEnv] : [config.apiKeyEnv];
  const missing = names.filter((name) => !process.env[name]);
  return missing.length
    ? { available: false, message: `Missing environment variables: ${missing.join(', ')}` }
    : { available: true };
}

export function deduplicateJobs(jobs: readonly NormalizedJob[]): NormalizedJob[] {
  const grouped = new Map<string, NormalizedJob>();
  for (const job of jobs) {
    const key = job.dedupeKey ?? job.canonicalId;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, job);
      continue;
    }
    const preferred = preferJob(existing, job);
    grouped.set(key, {
      ...preferred,
      sourceUrls: mergeSourceUrls(existing, job),
    });
  }
  return [...grouped.values()];
}

function preferJob(left: NormalizedJob, right: NormalizedJob): NormalizedJob {
  if (left.sourceKind === 'EMPLOYER' && right.sourceKind !== 'EMPLOYER') return left;
  if (right.sourceKind === 'EMPLOYER' && left.sourceKind !== 'EMPLOYER') return right;
  return (right.description?.length ?? 0) > (left.description?.length ?? 0) ? right : left;
}

function mergeSourceUrls(
  left: NormalizedJob,
  right: NormalizedJob,
): NonNullable<NormalizedJob['sourceUrls']> {
  const byUrl = new Map<string, NonNullable<NormalizedJob['sourceUrls']>[number]>();
  for (const source of [...(left.sourceUrls ?? []), ...(right.sourceUrls ?? [])]) {
    byUrl.set(source.url, source);
  }
  return [...byUrl.values()];
}
