import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { MarketplaceProviderKind, NormalizedJob, ProviderKind } from './domain.js';
import type { HttpClient } from './http-client.js';
import type {
  AdzunaBoardConfig,
  JoobleBoardConfig,
  MarketplaceBoardConfig,
  RemotiveBoardConfig,
} from './marketplace-config.js';
import { createDedupeKey } from './normalization.js';
import { planAdzunaRequests, type AdzunaSearchCursor } from './adzuna-scheduler.js';

export interface MarketplaceFetchContext {
  adzunaCursor?: AdzunaSearchCursor;
}

export interface MarketplaceFetchResult {
  jobs: NormalizedJob[];
  complete: boolean;
  requestsMade: number;
  attribution: string;
  nextAdzunaCursor?: AdzunaSearchCursor;
}

export interface MarketplaceProvider<
  TConfig extends MarketplaceBoardConfig = MarketplaceBoardConfig,
> {
  readonly kind: MarketplaceProviderKind;
  fetch(
    config: TConfig,
    credentials: Readonly<Record<string, string>>,
    context?: MarketplaceFetchContext,
  ): Promise<MarketplaceFetchResult>;
}

const adzunaResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  results: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      title: z.string(),
      description: z.string().optional(),
      redirect_url: z.url(),
      created: z.string().optional(),
      company: z.object({ display_name: z.string() }).optional(),
      location: z.object({ display_name: z.string() }).optional(),
      salary_min: z.number().optional(),
      salary_max: z.number().optional(),
      salary_is_predicted: z.union([z.string(), z.number(), z.boolean()]).optional(),
    }),
  ),
});

export class AdzunaMarketplaceProvider implements MarketplaceProvider<AdzunaBoardConfig> {
  readonly kind = 'adzuna' as const;
  constructor(private readonly http: HttpClient) {}

  async fetch(
    config: AdzunaBoardConfig,
    credentials: Readonly<Record<string, string>>,
    context: MarketplaceFetchContext = {},
  ): Promise<MarketplaceFetchResult> {
    const appId = credentials[config.appIdEnv];
    const appKey = credentials[config.appKeyEnv];
    if (!appId || !appKey) throw new Error('Adzuna credentials are not configured');
    const jobs = new Map<string, NormalizedJob>();
    const { requests, nextCursor } = planAdzunaRequests(
      config,
      context.adzunaCursor ?? { combinationIndex: 0, page: 1 },
    );
    let requestsMade = 0;
    for (const slot of requests) {
      const url = new URL(
        `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(slot.country)}/search/${String(slot.page)}`,
      );
      url.searchParams.set('app_id', appId);
      url.searchParams.set('app_key', appKey);
      url.searchParams.set('results_per_page', String(config.resultsPerPage));
      url.searchParams.set('what', slot.query);
      url.searchParams.set('sort_by', 'date');
      url.searchParams.set('content-type', 'application/json');
      const response = adzunaResponseSchema.parse(await this.http.getJson<unknown>(url.href));
      requestsMade += 1;
      for (const result of response.results) {
        const normalized = marketplaceJob({
          provider: this.kind,
          externalId: String(result.id),
          title: result.title,
          companyName: result.company?.display_name ?? 'Unknown employer',
          location: result.location?.display_name ?? null,
          description: result.description ?? null,
          listingUrl: result.redirect_url,
          ...(result.created ? { publishedAt: result.created } : {}),
          salaryText: salaryText(result.salary_min, result.salary_max, result.salary_is_predicted),
          sourceName: 'Adzuna',
        });
        jobs.set(normalized.dedupeKey ?? normalized.canonicalId, normalized);
      }
    }
    const complete = !requests.length || requestsMade < config.maxRequestsPerPoll;
    return {
      jobs: [...jobs.values()],
      complete,
      requestsMade,
      attribution: 'Jobs by Adzuna',
      nextAdzunaCursor: nextCursor,
    };
  }
}

const remotiveResponseSchema = z.object({
  'job-count': z.number().int().nonnegative().optional(),
  jobs: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      url: z.url(),
      title: z.string(),
      company_name: z.string(),
      category: z.string().optional(),
      publication_date: z.string().optional(),
      candidate_required_location: z.string().optional(),
      salary: z.string().optional(),
      description: z.string().optional(),
    }),
  ),
});

export class RemotiveMarketplaceProvider implements MarketplaceProvider<RemotiveBoardConfig> {
  readonly kind = 'remotive' as const;
  constructor(private readonly http: HttpClient) {}

  async fetch(
    config: RemotiveBoardConfig,
    _credentials: Readonly<Record<string, string>> = {},
    _context: MarketplaceFetchContext = {},
  ): Promise<MarketplaceFetchResult> {
    const url = new URL('https://remotive.com/api/remote-jobs');
    url.searchParams.set('category', config.category);
    const response = remotiveResponseSchema.parse(await this.http.getJson<unknown>(url.href));
    const jobs = response.jobs
      .filter((job) => matchesRoleFamilies(job.title, job.description ?? '', config.searchQueries))
      .map((job) =>
        marketplaceJob({
          provider: this.kind,
          externalId: String(job.id),
          title: job.title,
          companyName: job.company_name,
          location: `Remote${job.candidate_required_location ? ` — ${job.candidate_required_location}` : ''}`,
          description: job.description ?? null,
          listingUrl: job.url,
          ...(job.publication_date ? { publishedAt: job.publication_date } : {}),
          salaryText: job.salary ?? null,
          sourceName: 'Remotive',
        }),
      );
    const complete =
      response['job-count'] === undefined || response.jobs.length >= response['job-count'];
    return { jobs, complete, requestsMade: 1, attribution: 'Jobs by Remotive' };
  }
}

const joobleResponseSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  jobs: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      title: z.string(),
      location: z.string().optional(),
      snippet: z.string().optional(),
      salary: z.string().optional(),
      source: z.string().optional(),
      link: z.url(),
      company: z.string().optional(),
      updated: z.string().optional(),
    }),
  ),
});

export class JoobleMarketplaceProvider implements MarketplaceProvider<JoobleBoardConfig> {
  readonly kind = 'jooble' as const;
  constructor(private readonly http: HttpClient) {}

  async fetch(
    config: JoobleBoardConfig,
    credentials: Readonly<Record<string, string>>,
    _context: MarketplaceFetchContext = {},
  ): Promise<MarketplaceFetchResult> {
    const key = credentials[config.apiKeyEnv];
    if (!key) throw new Error('Jooble API key is not configured');
    const jobs = new Map<string, NormalizedJob>();
    let requestsMade = 0;
    let complete = true;
    outer: for (const query of config.searchQueries) {
      for (const region of config.regions) {
        for (let page = 1; page <= config.maxPagesPerQuery; page += 1) {
          if (requestsMade >= config.maxRequestsPerPoll) {
            complete = false;
            break outer;
          }
          const response = joobleResponseSchema.parse(
            await this.http.postJson<unknown>(
              `${config.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(key)}`,
              {
                keywords: query,
                location: region,
                page,
                ResultOnPage: config.resultsPerPage,
                companysearch: false,
              },
            ),
          );
          requestsMade += 1;
          for (const result of response.jobs) {
            const normalized = marketplaceJob({
              provider: this.kind,
              externalId: String(result.id),
              title: result.title,
              companyName: result.company ?? 'Unknown employer',
              location: result.location ?? null,
              description: result.snippet ?? null,
              listingUrl: result.link,
              ...(result.updated ? { publishedAt: result.updated } : {}),
              salaryText: result.salary ?? null,
              sourceName: result.source ? `Jooble (${result.source})` : 'Jooble',
            });
            jobs.set(normalized.dedupeKey ?? normalized.canonicalId, normalized);
          }
          if (
            response.jobs.length < config.resultsPerPage ||
            page * config.resultsPerPage >= response.totalCount
          ) {
            break;
          }
          if (page === config.maxPagesPerQuery) complete = false;
        }
      }
    }
    return { jobs: [...jobs.values()], complete, requestsMade, attribution: 'Jobs by Jooble' };
  }
}

interface MarketplaceJobInput {
  provider: MarketplaceProviderKind;
  externalId: string;
  title: string;
  companyName: string;
  location: string | null;
  description: string | null;
  listingUrl: string;
  publishedAt?: string;
  salaryText: string | null;
  sourceName: string;
}

function marketplaceJob(input: MarketplaceJobInput): NormalizedJob {
  const listingUrl = safeListingUrl(input.listingUrl);
  const title = normalizeText(input.title);
  const companyName = normalizeText(input.companyName);
  const location = input.location ? normalizeText(input.location) : null;
  const description = input.description
    ? normalizeText(input.description.replace(/<[^>]+>/g, ' '))
    : null;
  const dedupeKey = createDedupeKey(companyName, title, location);
  const contentHash = hash(
    JSON.stringify({
      title,
      companyName,
      location,
      description,
      listingUrl,
      salaryText: input.salaryText,
    }),
  );
  return {
    canonicalId: `${input.provider}:${encodeURIComponent(input.externalId)}`,
    dedupeKey,
    companyId: companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, ''),
    companyName,
    provider: input.provider,
    externalId: input.externalId,
    title,
    location,
    description,
    applyUrl: listingUrl,
    sourceUrl: listingUrl,
    sourceName: input.sourceName,
    sourceKind: 'MARKETPLACE',
    sourceUrls: [{ provider: input.provider, url: listingUrl, kind: 'AGGREGATOR' }],
    updatedAt: input.publishedAt ? new Date(input.publishedAt).toISOString() : null,
    sourcePublishedAt: input.publishedAt ? new Date(input.publishedAt).toISOString() : null,
    salaryText: input.salaryText,
    contentHash,
  };
}

function matchesRoleFamilies(
  title: string,
  description: string,
  queries: readonly string[],
): boolean {
  const text = `${title} ${description}`.toLowerCase();
  return queries.some((query) =>
    query
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 3 && !['senior', 'engineer', 'developer'].includes(token))
      .some((token) => text.includes(token)),
  );
}

function safeListingUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Marketplace listing URL must be a public HTTPS URL');
  }
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local') || isIP(url.hostname) !== 0) {
    throw new Error('Marketplace listing URL must not target a local or IP host');
  }
  return url.toString();
}

function salaryText(
  minimum: number | undefined,
  maximum: number | undefined,
  predicted: string | number | boolean | undefined,
): string | null {
  if (minimum === undefined && maximum === undefined) return null;
  const range = [minimum, maximum].filter((value) => value !== undefined).join(' - ');
  return `${range}${predicted ? ' (Adzuna estimate)' : ''}`;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function providerConfigMatches(
  provider: MarketplaceProviderKind,
  config: MarketplaceBoardConfig,
): boolean {
  return provider === config.provider;
}

export function marketplaceSourceUrl(
  job: NormalizedJob,
  provider: ProviderKind,
): string | undefined {
  return job.sourceUrls?.find((source) => source.provider === provider)?.url;
}
