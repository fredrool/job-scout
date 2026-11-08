import type { AdzunaBoardConfig } from './marketplace-config.js';

export interface AdzunaSearchCursor {
  combinationIndex: number;
  page: number;
}

export interface AdzunaSearchSlot {
  country: string;
  query: string;
  page: number;
}

export function buildAdzunaCombinations(
  countries: readonly string[],
  queries: readonly string[],
): { country: string; query: string }[] {
  const combinations: { country: string; query: string }[] = [];
  for (const country of countries) {
    for (const query of queries) {
      combinations.push({ country, query });
    }
  }
  return combinations;
}

export function planAdzunaRequests(
  config: Pick<
    AdzunaBoardConfig,
    'countries' | 'searchQueries' | 'maxPagesPerQuery' | 'maxRequestsPerPoll'
  >,
  cursor: AdzunaSearchCursor = { combinationIndex: 0, page: 1 },
): { requests: AdzunaSearchSlot[]; nextCursor: AdzunaSearchCursor } {
  const combinations = buildAdzunaCombinations(config.countries, config.searchQueries);
  if (!combinations.length) {
    return { requests: [], nextCursor: { combinationIndex: 0, page: 1 } };
  }

  const requests: AdzunaSearchSlot[] = [];
  let combinationIndex = cursor.combinationIndex % combinations.length;
  let page = Math.max(1, cursor.page);

  for (let made = 0; made < config.maxRequestsPerPoll; made += 1) {
    const current = combinations[combinationIndex];
    if (!current) break;
    requests.push({ country: current.country, query: current.query, page });
    if (page >= config.maxPagesPerQuery) {
      combinationIndex = (combinationIndex + 1) % combinations.length;
      page = 1;
    } else {
      page += 1;
    }
  }

  return { requests, nextCursor: { combinationIndex, page } };
}
