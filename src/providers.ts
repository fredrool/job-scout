import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Company, CompanyProviderKind, JsonFeedMapping, ProviderJob } from './domain.js';
import { HttpClient } from './http-client.js';

export interface JobProvider {
  readonly kind: CompanyProviderKind;
  fetchJobs(company: Company): Promise<{ jobs: ProviderJob[]; complete: boolean }>;
}

const greenhouseResponseSchema = z.object({
  jobs: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      title: z.string(),
      absolute_url: z.url(),
      location: z.object({ name: z.string() }).optional(),
      content: z.string().optional(),
      updated_at: z.string().optional(),
    }),
  ),
});

@Injectable()
export class GreenhouseProvider implements JobProvider {
  readonly kind = 'greenhouse' as const;
  constructor(@Inject(HttpClient) private readonly http: HttpClient) {}

  async fetchJobs(company: Company): Promise<{ jobs: ProviderJob[]; complete: boolean }> {
    const token = requireBoardToken(company, this.kind);
    const data = greenhouseResponseSchema.parse(
      await this.http.getJson<unknown>(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`,
      ),
    );
    return {
      complete: true,
      jobs: data.jobs.map((job) => ({
        externalId: String(job.id),
        title: job.title,
        applyUrl: job.absolute_url,
        sourceUrl: job.absolute_url,
        ...(job.location ? { location: job.location.name } : {}),
        ...(job.content ? { description: job.content } : {}),
        ...(job.updated_at ? { updatedAt: job.updated_at } : {}),
      })),
    };
  }
}

const leverResponseSchema = z.array(
  z.object({
    id: z.string(),
    text: z.string(),
    hostedUrl: z.url(),
    applyUrl: z.url().optional(),
    descriptionPlain: z.string().optional(),
    categories: z.object({ location: z.string().optional() }).optional(),
    createdAt: z.number().int().optional(),
  }),
);

@Injectable()
export class LeverProvider implements JobProvider {
  readonly kind = 'lever' as const;
  constructor(@Inject(HttpClient) private readonly http: HttpClient) {}

  async fetchJobs(company: Company): Promise<{ jobs: ProviderJob[]; complete: boolean }> {
    const token = requireBoardToken(company, this.kind);
    const jobs = leverResponseSchema.parse(
      await this.http.getJson<unknown>(
        `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`,
      ),
    );
    return {
      complete: true,
      jobs: jobs.map((job) => ({
        externalId: job.id,
        title: job.text,
        applyUrl: job.applyUrl ?? job.hostedUrl,
        sourceUrl: job.hostedUrl,
        ...(job.categories?.location ? { location: job.categories.location } : {}),
        ...(job.descriptionPlain ? { description: job.descriptionPlain } : {}),
        ...(job.createdAt ? { updatedAt: new Date(job.createdAt).toISOString() } : {}),
      })),
    };
  }
}

const ashbyResponseSchema = z.object({
  jobs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      location: z.string().optional(),
      jobUrl: z.url(),
      applyUrl: z.url().optional(),
      descriptionHtml: z.string().optional(),
      publishedAt: z.string().optional(),
    }),
  ),
});

@Injectable()
export class AshbyProvider implements JobProvider {
  readonly kind = 'ashby' as const;
  constructor(@Inject(HttpClient) private readonly http: HttpClient) {}

  async fetchJobs(company: Company): Promise<{ jobs: ProviderJob[]; complete: boolean }> {
    const token = requireBoardToken(company, this.kind);
    const data = ashbyResponseSchema.parse(
      await this.http.getJson<unknown>(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`,
      ),
    );
    return {
      complete: true,
      jobs: data.jobs.map((job) => ({
        externalId: job.id,
        title: job.title,
        applyUrl: job.applyUrl ?? job.jobUrl,
        sourceUrl: job.jobUrl,
        ...(job.location ? { location: job.location } : {}),
        ...(job.descriptionHtml ? { description: job.descriptionHtml } : {}),
        ...(job.publishedAt ? { updatedAt: job.publishedAt } : {}),
      })),
    };
  }
}

@Injectable()
export class JsonFeedProvider implements JobProvider {
  readonly kind = 'json' as const;
  constructor(@Inject(HttpClient) private readonly http: HttpClient) {}

  async fetchJobs(company: Company): Promise<{ jobs: ProviderJob[]; complete: boolean }> {
    if (!company.feedUrl || !company.feedMapping) {
      throw new Error(`Company ${company.id} has incomplete JSON feed configuration`);
    }
    const mapping = company.feedMapping;
    const payload = await this.http.getJson<unknown>(company.feedUrl);
    const jobs = mapping.jobsPath ? readPath(payload, mapping.jobsPath) : payload;
    if (!Array.isArray(jobs)) throw new Error('Configured jobs path does not resolve to an array');
    return { jobs: jobs.map((job, index) => this.mapJob(job, index, mapping)), complete: true };
  }

  private mapJob(job: unknown, index: number, mapping: JsonFeedMapping): ProviderJob {
    const externalId = requiredString(job, mapping.id, index);
    const title = requiredString(job, mapping.title, index);
    const applyUrl = requiredUrl(job, mapping.applyUrl, index);
    const optional = (path: string | undefined): string | undefined =>
      path ? optionalString(job, path) : undefined;
    const sourceUrl = optional(mapping.sourceUrl);
    const location = optional(mapping.location);
    const description = optional(mapping.description);
    const updatedAt = optional(mapping.updatedAt);
    return {
      externalId,
      title,
      applyUrl,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  }
}

function requireBoardToken(company: Company, provider: CompanyProviderKind): string {
  if (!company.boardToken) throw new Error(`Company ${company.id} has no ${provider} board token`);
  return company.boardToken;
}

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (typeof current !== 'object' || current === null) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function optionalString(value: unknown, path: string): string | undefined {
  const result = readPath(value, path);
  return typeof result === 'string' || typeof result === 'number' ? String(result) : undefined;
}

function requiredString(value: unknown, path: string, index: number): string {
  const result = optionalString(value, path);
  if (!result) throw new Error(`Job ${String(index)} has no string at "${path}"`);
  return result;
}

function requiredUrl(value: unknown, path: string, index: number): string {
  return z.url().parse(requiredString(value, path, index));
}
