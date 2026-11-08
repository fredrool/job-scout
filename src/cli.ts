#!/usr/bin/env node
import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import { parse } from 'yaml';
import { AppModule } from './app.module.js';
import { companySchema, marketplaceProviderKindSchema, type UserFeedback } from './domain.js';
import { ScanPipeline } from './pipeline.js';
import { CompanyRegistry } from './registry.js';
import type { JobStorage } from './storage.js';
import { ConfigService } from './config.js';
import { DiscoveryService } from './discovery.js';
import { MarketplaceDiscoveryService } from './marketplace-discovery.js';

const usageText = [
  'Usage:',
  '  npm run cli -- scan [dry-run]',
  '  npm run cli -- companies validate [path]',
  '  npm run cli -- companies list',
  '  npm run cli -- companies discover <company-name> <https-careers-url>',
  '  npm run cli -- companies add <id> <name> <provider> <careers-url> <board-token>',
  '  npm run cli -- companies add-file <company-yaml-or-json>',
  '  npm run cli -- companies enable|disable <id>',
  '  npm run cli -- companies health',
  '  npm run cli -- providers test <adzuna|remotive|jooble>',
  '  npm run cli -- providers test-all',
  '  npm run cli -- feedback <canonical-id> <interested|applied|rejected|interviewing|offered|closed> [reason]',
].join('\n');

function usage(): never {
  throw new Error(usageText);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usageText);
    return;
  }
  const [command, action] = args;
  const registry = new CompanyRegistry();
  if (command === 'companies' && action === 'validate') {
    const path = args[2] ?? 'config/companies.yaml';
    const valid = registry.validate(parse(await readFile(path, 'utf8')));
    console.log(JSON.stringify({ valid: true, companies: valid.companies.length }, null, 2));
    return;
  }
  if (command === 'companies' && action === 'discover') {
    const [, , name, url] = args;
    if (!name || !url) usage();
    console.log(JSON.stringify(registry.candidateFromCareersUrl(name, url), null, 2));
    return;
  }
  if (command === 'companies' && action === 'list') {
    const current = await registry.load();
    console.log(
      JSON.stringify(
        {
          active: current.companies.filter((company) => company.enabled).length,
          sources: current.companies.map(({ id, name, provider, careersUrl, enabled }) => ({
            id,
            name,
            provider,
            careersUrl,
            enabled,
            status: enabled ? 'ACTIVE_NOT_PROBED' : 'DISABLED',
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'companies' && action === 'add') {
    const [, , id, name, provider, careersUrl, boardToken] = args;
    if (!id || !name || !provider || !careersUrl || !boardToken) usage();
    const company = companySchema.parse({
      id,
      name,
      provider,
      careersUrl,
      boardToken,
      enabled: false,
    });
    await registry.add(company);
    console.log(JSON.stringify({ added: id, enabled: false }, null, 2));
    return;
  }
  if (command === 'companies' && action === 'add-file') {
    const path = args[2];
    if (!path) usage();
    const company = companySchema.parse(parse(await readFile(path, 'utf8')));
    await registry.add(company);
    console.log(JSON.stringify({ added: company.id, enabled: false }, null, 2));
    return;
  }
  if (command === 'companies' && (action === 'enable' || action === 'disable')) {
    const id = args[2];
    if (!id) usage();
    await registry.setEnabled(id, action === 'enable');
    console.log(JSON.stringify({ id, enabled: action === 'enable' }, null, 2));
    return;
  }
  if (args.includes('--dry-run') || args.includes('dry-run')) process.env.DRY_RUN = 'true';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    if (command === 'scan') {
      console.log(JSON.stringify(await app.get(ScanPipeline).run(), null, 2));
      return;
    }
    if (command === 'providers' && (action === 'test' || action === 'test-all')) {
      const provider = action === 'test' ? marketplaceProviderKindSchema.parse(args[2]) : undefined;
      const result = await app
        .get(MarketplaceDiscoveryService)
        .discover({ ...(provider ? { provider } : {}), force: true });
      console.log(
        JSON.stringify(
          {
            jobsFound: result.jobs.length,
            sources: result.sources,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'companies' && action === 'health') {
      const configured = await app.get(CompanyRegistry).load();
      const result = await app.get(DiscoveryService).discover(configured);
      console.log(
        JSON.stringify(
          {
            activeSources: configured.companies.filter((company) => company.enabled).length,
            checkedAt: result.completedAt,
            sources: result.sources,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'feedback') {
      const [, canonicalId, state, reason] = args;
      if (!canonicalId || !state) usage();
      if (
        !['interested', 'applied', 'rejected', 'interviewing', 'offered', 'closed'].includes(state)
      ) {
        usage();
      }
      const config = app.get(ConfigService);
      const value: UserFeedback = {
        userId: config.values.USER_ID,
        canonicalId,
        state: state as UserFeedback['state'],
        ...(reason ? { reason } : {}),
        updatedAt: new Date().toISOString(),
      };
      await app.get<JobStorage>('JOB_STORAGE').putFeedback(value);
      console.log(JSON.stringify({ saved: true, value }, null, 2));
      return;
    }
    usage();
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
