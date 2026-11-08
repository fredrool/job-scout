import type { EvaluationRecord } from './ai.js';

export interface EvaluationPersistContext {
  userId: string;
  jobKey: string;
  contentHash: string;
  profileVersion: string;
  modelId: string;
}

export interface PersistedEvaluationSnapshot {
  cacheKey: string;
  record: EvaluationRecord;
  jobKey?: string;
  contentHash?: string;
  profileVersion?: string;
  modelId?: string;
}
