import { Module } from '@nestjs/common';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { DiscoveryModule } from './discovery.js';
import { ConfigService } from './config.js';
import { BedrockEvaluator } from './ai.js';
import { MatchingService } from './matching.js';
import { DigestRenderer, SesNotificationService } from './notifications.js';
import { ScanPipeline } from './pipeline.js';
import { DynamoJobStorage, MemoryJobStorage, type JobStorage } from './storage.js';
import { HttpClient } from './http-client.js';
import { JobBoardsRegistry } from './marketplace-config.js';
import {
  AdzunaMarketplaceProvider,
  JoobleMarketplaceProvider,
  RemotiveMarketplaceProvider,
  type MarketplaceProvider,
} from './marketplace-providers.js';
import { MARKETPLACE_PROVIDERS, MarketplaceDiscoveryService } from './marketplace-discovery.js';

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
    {
      provide: JobBoardsRegistry,
      inject: [ConfigService],
      useFactory: (config: ConfigService): JobBoardsRegistry =>
        new JobBoardsRegistry(config.values.JOB_BOARDS_PATH),
    },
    {
      provide: AdzunaMarketplaceProvider,
      inject: [HttpClient],
      useFactory: (http: HttpClient): AdzunaMarketplaceProvider =>
        new AdzunaMarketplaceProvider(http),
    },
    {
      provide: RemotiveMarketplaceProvider,
      inject: [HttpClient],
      useFactory: (http: HttpClient): RemotiveMarketplaceProvider =>
        new RemotiveMarketplaceProvider(http),
    },
    {
      provide: JoobleMarketplaceProvider,
      inject: [HttpClient],
      useFactory: (http: HttpClient): JoobleMarketplaceProvider =>
        new JoobleMarketplaceProvider(http),
    },
    {
      provide: MARKETPLACE_PROVIDERS,
      inject: [AdzunaMarketplaceProvider, RemotiveMarketplaceProvider, JoobleMarketplaceProvider],
      useFactory: (
        adzuna: AdzunaMarketplaceProvider,
        remotive: RemotiveMarketplaceProvider,
        jooble: JoobleMarketplaceProvider,
      ): readonly MarketplaceProvider[] => [adzuna, remotive, jooble],
    },
    MarketplaceDiscoveryService,
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
