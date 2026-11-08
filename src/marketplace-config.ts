import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { parse } from 'yaml';
import { z } from 'zod';

const commonSchema = z.object({
  enabled: z.boolean(),
  pollIntervalMinutes: z.number().int().positive(),
  searchQueries: z.array(z.string().min(2)).min(1),
  regions: z.array(z.string().min(2)).min(1),
  maxPagesPerQuery: z.number().int().positive().max(20),
  resultsPerPage: z.number().int().positive().max(100),
  maxRequestsPerPoll: z.number().int().positive().max(100),
});

const adzunaSchema = commonSchema.extend({
  provider: z.literal('adzuna'),
  countries: z.array(z.string().length(2)).min(1),
  appIdEnv: z.string().min(1).default('ADZUNA_APP_ID'),
  appKeyEnv: z.string().min(1).default('ADZUNA_APP_KEY'),
});

const remotiveSchema = commonSchema
  .extend({
    provider: z.literal('remotive'),
    category: z.string().min(1).default('software-dev'),
    attributionRequired: z.literal(true),
  })
  .superRefine((value, context) => {
    if (value.pollIntervalMinutes < 360) {
      context.addIssue({
        code: 'custom',
        path: ['pollIntervalMinutes'],
        message: 'Remotive must not be polled more than four times per day',
      });
    }
    if (value.maxRequestsPerPoll > 1) {
      context.addIssue({
        code: 'custom',
        path: ['maxRequestsPerPoll'],
        message: 'Remotive public API should be fetched once per polling interval',
      });
    }
  });

const joobleSchema = commonSchema.extend({
  provider: z.literal('jooble'),
  apiKeyEnv: z.string().min(1).default('JOOBLE_API_KEY'),
  endpoint: z.url().startsWith('https://'),
  lifetimeRequestQuota: z.number().int().positive().default(500),
});

export const jobBoardsSchema = z
  .object({
    providers: z.array(
      z.discriminatedUnion('provider', [adzunaSchema, remotiveSchema, joobleSchema]),
    ),
  })
  .strict();

export type JobBoardsConfig = z.infer<typeof jobBoardsSchema>;
export type MarketplaceBoardConfig = JobBoardsConfig['providers'][number];
export type AdzunaBoardConfig = Extract<MarketplaceBoardConfig, { provider: 'adzuna' }>;
export type RemotiveBoardConfig = Extract<MarketplaceBoardConfig, { provider: 'remotive' }>;
export type JoobleBoardConfig = Extract<MarketplaceBoardConfig, { provider: 'jooble' }>;

@Injectable()
export class JobBoardsRegistry {
  constructor(private readonly path = join(process.cwd(), 'config', 'job-boards.yaml')) {}

  async load(): Promise<JobBoardsConfig> {
    return jobBoardsSchema.parse(parse(await readFile(this.path, 'utf8')));
  }
}
