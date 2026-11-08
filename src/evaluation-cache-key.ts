import { createHash } from 'node:crypto';
import type { NormalizedJob, SearchProfile } from './domain.js';

export function evaluationCacheKey(
  job: Pick<NormalizedJob, 'contentHash'>,
  profile: Pick<SearchProfile, 'version'>,
  modelId: string,
): string {
  return createHash('sha256')
    .update(`${job.contentHash}:${profile.version}:${modelId}:score-v2`)
    .digest('hex');
}
