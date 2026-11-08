import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
import type { Company, NormalizedJob, ProviderJob } from './domain.js';

const trackingParameters = new Set([
  'fbclid',
  'gclid',
  'ref',
  'source',
  'utm_campaign',
  'utm_content',
  'utm_medium',
  'utm_source',
  'utm_term',
]);

const providerHosts: Readonly<Record<Company['provider'], readonly string[]>> = {
  greenhouse: ['greenhouse.io'],
  lever: ['lever.co'],
  ashby: ['ashbyhq.com'],
  json: [],
};

@Injectable()
export class SourceUrlVerifier {
  verify(rawUrl: string, company: Company): string {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
      throw new Error(`Unsafe source URL for ${company.id}`);
    }
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      isIP(hostname) !== 0 ||
      hostname.endsWith('.local')
    ) {
      throw new Error(`Private or local source URL for ${company.id}`);
    }

    const configuredHosts = [new URL(company.careersUrl).hostname];
    if (company.feedUrl) configuredHosts.push(new URL(company.feedUrl).hostname);
    const allowed = [...configuredHosts, ...providerHosts[company.provider]].some(
      (host) => hostname === host || hostname.endsWith(`.${host}`),
    );
    if (!allowed) throw new Error(`Unexpected source host "${hostname}" for ${company.id}`);
    return canonicalizeUrl(url);
  }
}

export function normalizeJob(
  company: Company,
  job: ProviderJob,
  verifier = new SourceUrlVerifier(),
): NormalizedJob {
  const sourceUrl = verifier.verify(job.sourceUrl ?? job.applyUrl, company);
  const applyUrl = verifier.verify(job.applyUrl, company);
  const normalized = {
    canonicalId: `${company.id}:${company.provider}:${encodeURIComponent(job.externalId.trim())}`,
    companyId: company.id,
    provider: company.provider,
    externalId: job.externalId.trim(),
    title: normalizeText(job.title),
    location: job.location ? normalizeText(job.location) : null,
    description: job.description ? normalizeText(stripHtml(job.description)) : null,
    applyUrl,
    sourceUrl,
    updatedAt: job.updatedAt ? new Date(job.updatedAt).toISOString() : null,
  } satisfies Omit<NormalizedJob, 'contentHash'>;

  return {
    ...normalized,
    companyName: company.name,
    sourceName: company.name,
    sourceKind: 'EMPLOYER',
    sourceUrls: [
      { provider: company.provider, url: sourceUrl, kind: 'ORIGINAL' },
      ...(applyUrl === sourceUrl
        ? []
        : [{ provider: company.provider, url: applyUrl, kind: 'APPLICATION' as const }]),
    ],
    dedupeKey: createDedupeKey(company.name, normalized.title, normalized.location),
    contentHash: sha256(
      stableStringify({
        title: normalized.title,
        location: normalized.location,
        description: normalized.description,
        applyUrl: normalized.applyUrl,
        sourceUrl: normalized.sourceUrl,
      }),
    ),
  };
}

export function createDedupeKey(
  companyName: string,
  title: string,
  location: string | null,
): string {
  const normalize = (value: string): string =>
    value
      .toLowerCase()
      .replace(/\b(inc|incorporated|corp|corporation|llc|ltd|limited|co)\b\.?/g, '')
      .replace(/[^a-z0-9+#]+/g, ' ')
      .trim();
  const normalizedLocation =
    location && /\bremote\b/i.test(location) ? 'remote' : normalize(location ?? 'unknown');
  return sha256(`${normalize(companyName)}|${normalize(title)}|${normalizedLocation}`);
}

export function canonicalizeUrl(input: URL): string {
  const url = new URL(input);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (trackingParameters.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

function normalizeText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
