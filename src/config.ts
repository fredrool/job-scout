import { Injectable } from '@nestjs/common';
import { z } from 'zod';

const booleanFromString = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return value;
}, z.boolean());

export const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    MOCK_MODE: booleanFromString.default(true),
    AWS_REGION: z.string().min(1).default('us-east-1'),
    BEDROCK_MODEL_ID: z.string().min(1).default('us.anthropic.claude-haiku-4-5-20251001-v1:0'),
    NOTIFICATION_EMAIL: z.email(),
    SENDER_EMAIL: z.email().default('sender@example.com'),
    DYNAMODB_TABLE_NAME: z.string().min(1).default('job-scout-local'),
    USER_ID: z.string().min(1).default('default'),
    PROFILE_PATH: z.string().min(1).default('config/profile.yaml'),
    COMPANY_REGISTRY_PATH: z.string().min(1).default('config/companies.yaml'),
    JOB_BOARDS_PATH: z.string().min(1).default('config/job-boards.yaml'),
    SCORE_THRESHOLD: z.coerce.number().min(0).max(100).default(80),
    DIGEST_LIMIT: z.coerce.number().int().positive().max(100).default(25),
    MAX_REQUESTS_PER_SCAN: z.coerce.number().int().positive().default(200),
    MAX_JOBS_PER_SCAN: z.coerce.number().int().positive().default(1000),
    MAX_BEDROCK_CALLS_PER_SCAN: z.coerce.number().int().nonnegative().default(50),
    MAX_RUNTIME_MS: z.coerce.number().int().positive().default(240_000),
    PRESENTATION_TIMEZONE: z.string().min(1).default('America/Toronto'),
    DRY_RUN: booleanFromString.default(false),
    BEDROCK_INPUT_COST_PER_MILLION: z.coerce.number().nonnegative().default(1),
    BEDROCK_OUTPUT_COST_PER_MILLION: z.coerce.number().nonnegative().default(5),
    HTTP_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(10_000),
    HTTP_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
    HTTP_REQUESTS_PER_SECOND: z.coerce.number().positive().max(100).default(5),
    HTTP_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(5_000_000),
  })
  .strict()
  .superRefine((environment, context) => {
    if (environment.NODE_ENV === 'production' && environment.MOCK_MODE) {
      context.addIssue({
        code: 'custom',
        path: ['MOCK_MODE'],
        message: 'MOCK_MODE must be false in production',
      });
    }
  });

export type AppConfig = Readonly<z.infer<typeof environmentSchema>>;

export function parseEnvironment(input: NodeJS.ProcessEnv): AppConfig {
  return Object.freeze(
    environmentSchema.parse({
      NODE_ENV: input.NODE_ENV,
      MOCK_MODE: input.MOCK_MODE,
      AWS_REGION: input.AWS_REGION,
      BEDROCK_MODEL_ID: input.BEDROCK_MODEL_ID,
      NOTIFICATION_EMAIL: input.NOTIFICATION_EMAIL,
      SENDER_EMAIL: input.SENDER_EMAIL,
      DYNAMODB_TABLE_NAME: input.DYNAMODB_TABLE_NAME,
      USER_ID: input.USER_ID,
      PROFILE_PATH: input.PROFILE_PATH,
      COMPANY_REGISTRY_PATH: input.COMPANY_REGISTRY_PATH,
      JOB_BOARDS_PATH: input.JOB_BOARDS_PATH,
      SCORE_THRESHOLD: input.SCORE_THRESHOLD,
      DIGEST_LIMIT: input.DIGEST_LIMIT,
      MAX_REQUESTS_PER_SCAN: input.MAX_REQUESTS_PER_SCAN,
      MAX_JOBS_PER_SCAN: input.MAX_JOBS_PER_SCAN,
      MAX_BEDROCK_CALLS_PER_SCAN: input.MAX_BEDROCK_CALLS_PER_SCAN,
      MAX_RUNTIME_MS: input.MAX_RUNTIME_MS,
      PRESENTATION_TIMEZONE: input.PRESENTATION_TIMEZONE,
      DRY_RUN: input.DRY_RUN,
      BEDROCK_INPUT_COST_PER_MILLION: input.BEDROCK_INPUT_COST_PER_MILLION,
      BEDROCK_OUTPUT_COST_PER_MILLION: input.BEDROCK_OUTPUT_COST_PER_MILLION,
      HTTP_TIMEOUT_MS: input.HTTP_TIMEOUT_MS,
      HTTP_MAX_RETRIES: input.HTTP_MAX_RETRIES,
      HTTP_REQUESTS_PER_SECOND: input.HTTP_REQUESTS_PER_SECOND,
      HTTP_MAX_RESPONSE_BYTES: input.HTTP_MAX_RESPONSE_BYTES,
    }),
  );
}

@Injectable()
export class ConfigService {
  readonly values: AppConfig;

  constructor() {
    this.values = parseEnvironment(process.env);
  }
}
