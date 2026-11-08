const ENGINEERING_TITLE_SIGNALS = [
  /\bsoftware engineer\b/i,
  /\bsoftware developer\b/i,
  /\bbackend engineer\b/i,
  /\bfront[- ]?end engineer\b/i,
  /\bfull[- ]?stack engineer\b/i,
  /\bfull[- ]?stack developer\b/i,
  /\bplatform engineer\b/i,
  /\bdevops engineer\b/i,
  /\bsite reliability engineer\b/i,
  /\bsre\b/i,
  /\bdata engineer\b/i,
  /\bmachine learning engineer\b/i,
  /\bml engineer\b/i,
  /\bproduct engineer\b/i,
  /\bstaff engineer\b/i,
  /\bprincipal engineer\b/i,
  /\bengineering manager\b/i,
  /\b(?:senior|staff|principal|lead)\s+(?:software|backend|frontend|platform|infrastructure)\b/i,
];

const UNRELATED_ROLE_PATTERNS = [
  /\baccount executive\b/i,
  /\b(?:sales|business) development representative\b/i,
  /\b(?:bdr|sdr)\b/i,
  /\bcustomer support\b/i,
  /\bcustomer success\b/i,
  /\bsupport specialist\b/i,
  /\bcopywriter\b/i,
  /\bcontent (?:writer|strategist)\b/i,
  /\bmarketing (?:manager|specialist|coordinator)\b/i,
  /\brecruiter\b/i,
  /\btalent acquisition\b/i,
  /\boffice manager\b/i,
  /\b(?:graphic|product) designer\b/i,
  /\bparalegal\b/i,
  /\b(?:finance|financial) analyst\b/i,
];

const GENERIC_TITLE_TOKENS = new Set([
  'senior',
  'staff',
  'principal',
  'lead',
  'architect',
  'full',
  'stack',
  'remote',
  'ii',
  'iii',
  'iv',
  'the',
  'and',
  'for',
]);

export function isClearlyUnrelatedEngineeringRole(title: string): boolean {
  const normalized = title.toLowerCase().trim();
  if (ENGINEERING_TITLE_SIGNALS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return UNRELATED_ROLE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function roleAlignmentScore(jobTitle: string, targetTitles: readonly string[]): number {
  if (isClearlyUnrelatedEngineeringRole(jobTitle)) return 0;
  if (!hasEngineeringTitleSignal(jobTitle)) return 0;
  const job = jobTitle.toLowerCase();

  let bestOverlap = 0;
  for (const target of targetTitles) {
    const tokens = target
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((word) => word.length > 2 && !GENERIC_TITLE_TOKENS.has(word));
    const overlap = tokens.filter((token) => job.includes(token)).length;
    bestOverlap = Math.max(bestOverlap, overlap);
  }

  if (bestOverlap >= 2) return 20;
  if (bestOverlap === 1) return 12;
  return 8;
}

export function hasEngineeringTitleSignal(title: string): boolean {
  const normalized = title.toLowerCase();
  if (isClearlyUnrelatedEngineeringRole(title)) return false;
  if (ENGINEERING_TITLE_SIGNALS.some((pattern) => pattern.test(normalized))) return true;
  return /\b(?:[a-z][a-z0-9+.#-]*\s+)+engineer\b/i.test(normalized);
}
