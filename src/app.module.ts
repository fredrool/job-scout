import { Module } from '@nestjs/common';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { DiscoveryModule } from './discovery.js';
import { ConfigService } from './config.js';
import { BedrockEvaluator } from './ai.js';
import { MatchingService } from './matching.js';
import { DigestRenderer, SesNotificationService } from './notifications.js';
import { ScanPipeline } from './pipeline.js';
import { DynamoJobStorage, MemoryJobStorage, type JobStorage } from './storage.js';

@Module({
  imports: [DiscoveryModule],
  providers: [
    MatchingService,
    DigestRenderer,
    {
      provide: 'JOB_STORAGE',
      inject: [ConfigService],
      useFactory: (config: ConfigService): JobStorage =>
        config.values.MOCK_MODE
          ? new MemoryJobStorage()
          : new DynamoJobStorage(config.values.DYNAMODB_TABLE_NAME),
    },
    { provide: 'EVALUATION_CACHE', useExisting: 'JOB_STORAGE' },
    BedrockEvaluator,
    {
      provide: SesNotificationService,
      inject: [ConfigService, DigestRenderer],
      useFactory: (config: ConfigService, renderer: DigestRenderer): SesNotificationService =>
        new SesNotificationService(
          new SESv2Client({ region: config.values.AWS_REGION }),
          renderer,
          config.values.SENDER_EMAIL,
          config.values.PRESENTATION_TIMEZONE,
        ),
    },
    ScanPipeline,
  ],
  exports: [ScanPipeline, 'JOB_STORAGE'],
})
// Nest modules are intentionally metadata-only classes.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AppModule {}
