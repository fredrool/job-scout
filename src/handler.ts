import 'reflect-metadata';
import type { Handler, ScheduledEvent } from 'aws-lambda';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { ScanPipeline, type ScanSummary } from './pipeline.js';

let application: Promise<INestApplicationContext> | undefined;

async function context(): Promise<INestApplicationContext> {
  application ??= NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  return application;
}

export const handler: Handler<ScheduledEvent, ScanSummary> = async () => {
  const app = await context();
  const result = await app.get(ScanPipeline).run();
  console.log(JSON.stringify({ level: 'info', event: 'scan_completed', ...result }));
  return result;
};
