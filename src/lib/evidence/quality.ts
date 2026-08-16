export type FreshnessState = "current" | "stale" | "unknown";
export type DuplicateKind = "content_hash" | "canonical_url" | "syndicated_content";
export type InjectionFlag =
  | "instruction_override"
  | "role_impersonation"
  | "tool_invocation"
  | "secret_exfiltration"
  | "role_markup";

export type QualitySource = {
  id: string;
  name: string;
  canonicalUrl: string | null;
  authorityWeight: number;
  currentVersion: {
    id: string;
    contentHash: string;
    contentText: string | null;
    retrievedAt: string | null;
    authorityWeight: number;
    freshnessDays: number;
    promptInjectionFlags?: string[];
  } | null;
};

export type QualityClaim = {
  id: string;
  sourceVersionId: string;
  claimText: string;
  conflictGroup: string | null;
  freshnessState?: FreshnessState;
  authorityWeight: number;
  createdAt: string;
};

export type SourceQualityAssessment = {
  sourceId: string;
  sourceName: string;
  sourceVersionId: string | null;
  authorityWeight: number;
  freshnessDays: number | null;
  freshness: FreshnessState;
  ageDays: number | null;
  retrievedAt: string | null;
  independent: boolean;
  duplicateKind: DuplicateKind | null;
  duplicateOfSourceId: string | null;
  promptInjectionFlags: InjectionFlag[];
};

export type DuplicateGroup = {
  kind: DuplicateKind;
  representativeSourceId: string;
  sourceIds: string[];
};

export type ConflictResolution = {
  conflictGroup: string;
  winnerClaimId: string;
  claimIds: string[];
  distinctClaimCount: number;
  rationale: string;
};

export type EvidenceQualityReport = {
  sources: SourceQualityAssessment[];
  duplicateGroups: DuplicateGroup[];
  conflicts: ConflictResolution[];
  counts: {
    current: number;
    stale: number;
    unknown: number;
    independent: number;
    duplicate: number;
    injectionFlagged: number;
    conflictGroups: number;
  };
};

const DAY_MS = 86_400_000;
const SYNDICATION_THRESHOLD = 0.82;
const MIN_SYNDICATION_TOKENS = 12;
const MAX_SYNDICATION_TOKENS = 5_000;

const injectionPatterns: ReadonlyArray<{ flag: InjectionFlag; pattern: RegExp }> = [
  { flag: "instruction_override", pattern: /ignore\s+(?:all|any|the|previous|prior|above|system|developer)[^.!?]{0,80}instruction/iu },
  { flag: "role_impersonation", pattern: /(?:system|developer|assistant)[\s_-]*(?:prompt|message|instruction)/iu },
  { flag: "tool_invocation", pattern: /(?:call|invoke|use|run|execute)\s+(?:a\s+|the\s+)?(?:tool|function|command|shell|api)/iu },
  { flag: "secret_exfiltration", pattern: /(?:reveal|print|show|return|exfiltrate|leak)[^.!?]{0,80}(?:secret|password|api[\s_-]*key|token|credential|environment)/iu },
  { flag: "role_markup", pattern: /(?:<\s*(?:system|developer|assistant|tool)|\[(?:system|developer|assistant|tool)\])/iu },
];

const injectionFlagSet = new Set<InjectionFlag>(injectionPatterns.map(({ flag }) => flag));

export const injectionFlagLabels: Record<InjectionFlag, string> = {
  instruction_override: "instruction override text",
  role_impersonation: "system or assistant role impersonation",
  tool_invocation: "tool invocation request",
  secret_exfiltration: "secret-disclosure request",
  role_markup: "model-role markup",
};

export function detectPromptInjection(content: string | null | undefined): InjectionFlag[] {
  if (!content) return [];
  return injectionPatterns.filter(({ pattern }) => pattern.test(content)).map(({ flag }) => flag);
}

function knownInjectionFlags(flags: string[] | undefined): InjectionFlag[] {
  return (flags ?? []).filter((flag): flag is InjectionFlag => injectionFlagSet.has(flag as InjectionFlag));
}

export function assessFreshness(
  retrievedAt: string | null | undefined,
  freshnessDays: number | null | undefined,
  now: Date = new Date(),
): { state: FreshnessState; ageDays: number | null } {
  if (!retrievedAt || !freshnessDays || freshnessDays <= 0) return { state: "unknown", ageDays: null };
  const retrieved = new Date(retrievedAt);
  if (!Number.isFinite(retrieved.getTime()) || retrieved.getTime() > now.getTime()) {
    return { state: "unknown", ageDays: null };
  }
  const ageDays = Math.floor((now.getTime() - retrieved.getTime()) / DAY_MS);
  return { state: ageDays > freshnessDays ? "stale" : "current", ageDays };
}

function normalizedWords(content: string | null) {
  return (content ?? "").toLocaleLowerCase("en-US").normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/u).filter(Boolean)
    .slice(0, MAX_SYNDICATION_TOKENS);
}

function shingles(content: string | null) {
  const words = normalizedWords(content);
  if (words.length < MIN_SYNDICATION_TOKENS) return new Set<string>();
  const result = new Set<string>();
  for (let index = 0; index <= words.length - 3; index += 1) {
    result.add(`${words[index]} ${words[index + 1]} ${words[index + 2]}`);
  }
  return result;
}

function shingleSimilarity(leftShingles: Set<string>, rightShingles: Set<string>) {
  if (leftShingles.size === 0 || rightShingles.size === 0) return 0;
  let intersection = 0;
  for (const shingle of leftShingles) if (rightShingles.has(shingle)) intersection += 1;
  return intersection / (leftShingles.size + rightShingles.size - intersection);
}

export function syndicatedContentSimilarity(left: string | null, right: string | null) {
  return shingleSimilarity(shingles(left), shingles(right));
}

function normalizedCanonicalUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLocaleLowerCase("en-US");
    return url.toString();
  } catch {
    return value.trim().toLocaleLowerCase("en-US") || null;
  }
}

class DisjointSet {
  private readonly parent = new Map<string, string>();
  constructor(ids: string[]) { for (const id of ids) this.parent.set(id, id); }
  find(id: string): string {
    const parent = this.parent.get(id);
    if (!parent || parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }
  union(left: string, right: string) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }
}

function freshnessRank(state: FreshnessState) {
  return state === "current" ? 2 : state === "unknown" ? 1 : 0;
}

function timestampRank(value: string | null) {
  const timestamp = value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function compareSourceQuality(left: SourceQualityAssessment, right: SourceQualityAssessment) {
  return right.authorityWeight - left.authorityWeight
    || freshnessRank(right.freshness) - freshnessRank(left.freshness)
    || timestampRank(right.retrievedAt) - timestampRank(left.retrievedAt)
    || left.sourceId.localeCompare(right.sourceId);
}

function pairDuplicateKind(
  left: QualitySource,
  right: QualitySource,
  leftShingles: Set<string>,
  rightShingles: Set<string>,
): DuplicateKind | null {
  const leftVersion = left.currentVersion;
  const rightVersion = right.currentVersion;
  if (!leftVersion || !rightVersion) return null;
  if (leftVersion.contentHash && leftVersion.contentHash === rightVersion.contentHash) return "content_hash";
  const leftUrl = normalizedCanonicalUrl(left.canonicalUrl);
  const rightUrl = normalizedCanonicalUrl(right.canonicalUrl);
  if (leftUrl && leftUrl === rightUrl) return "canonical_url";
  return shingleSimilarity(leftShingles, rightShingles) >= SYNDICATION_THRESHOLD
    ? "syndicated_content"
    : null;
}

function normalizedClaim(claim: string) {
  return claim.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

export function evaluateEvidenceQuality(
  inputSources: QualitySource[],
  claims: QualityClaim[] = [],
  now: Date = new Date(),
): EvidenceQualityReport {
  const sources = [...inputSources].sort((left, right) => left.id.localeCompare(right.id));
  const assessments = sources.map<SourceQualityAssessment>((source) => {
    const version = source.currentVersion;
    const authorityWeight = version?.authorityWeight ?? source.authorityWeight;
    const freshnessDays = version?.freshnessDays ?? null;
    const freshness = assessFreshness(version?.retrievedAt, freshnessDays, now);
    const flags = new Set<InjectionFlag>([
      ...knownInjectionFlags(version?.promptInjectionFlags),
      ...detectPromptInjection(version?.contentText),
    ]);
    return {
      sourceId: source.id,
      sourceName: source.name,
      sourceVersionId: version?.id ?? null,
      authorityWeight,
      freshnessDays,
      freshness: freshness.state,
      ageDays: freshness.ageDays,
      retrievedAt: version?.retrievedAt ?? null,
      independent: true,
      duplicateKind: null,
      duplicateOfSourceId: null,
      promptInjectionFlags: [...flags].sort(),
    };
  });
  const assessmentBySource = new Map(assessments.map((assessment) => [assessment.sourceId, assessment]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const shinglesBySource = new Map(sources.map((source) => [source.id, shingles(source.currentVersion?.contentText ?? null)]));
  const sets = new DisjointSet(sources.map(({ id }) => id));
  const pairKinds = new Map<string, DuplicateKind>();

  for (let leftIndex = 0; leftIndex < sources.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sources.length; rightIndex += 1) {
      const left = sources[leftIndex];
      const right = sources[rightIndex];
      const kind = pairDuplicateKind(left, right, shinglesBySource.get(left.id)!, shinglesBySource.get(right.id)!);
      if (!kind) continue;
      sets.union(left.id, right.id);
      pairKinds.set(`${left.id}|${right.id}`, kind);
    }
  }

  const membersByRoot = new Map<string, string[]>();
  for (const source of sources) {
    const root = sets.find(source.id);
    membersByRoot.set(root, [...(membersByRoot.get(root) ?? []), source.id]);
  }
  const duplicateGroups: DuplicateGroup[] = [];
  for (const memberIds of membersByRoot.values()) {
    if (memberIds.length < 2) continue;
    const ranked = memberIds.map((id) => assessmentBySource.get(id)!).sort(compareSourceQuality);
    const representative = ranked[0];
    const memberSet = new Set(memberIds);
    const kinds = [...pairKinds.entries()]
      .filter(([key]) => key.split("|").every((id) => memberSet.has(id)))
      .map(([, kind]) => kind);
    const kind: DuplicateKind = kinds.includes("content_hash") ? "content_hash"
      : kinds.includes("canonical_url") ? "canonical_url" : "syndicated_content";
    for (const assessment of ranked.slice(1)) {
      assessment.independent = false;
      assessment.duplicateKind = kind;
      assessment.duplicateOfSourceId = representative.sourceId;
    }
    duplicateGroups.push({
      kind,
      representativeSourceId: representative.sourceId,
      sourceIds: [...memberIds].sort(),
    });
  }

  const sourceByVersion = new Map(sources.flatMap((source) => source.currentVersion
    ? [[source.currentVersion.id, source.id] as const] : []));
  const claimsByGroup = new Map<string, QualityClaim[]>();
  for (const claim of claims) {
    const group = claim.conflictGroup?.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
    if (!group || !sourceByVersion.has(claim.sourceVersionId)) continue;
    claimsByGroup.set(group, [...(claimsByGroup.get(group) ?? []), claim]);
  }
  const conflicts: ConflictResolution[] = [];
  for (const [conflictGroup, groupedClaims] of claimsByGroup) {
    const distinctClaimCount = new Set(groupedClaims.map(({ claimText }) => normalizedClaim(claimText))).size;
    if (distinctClaimCount < 2) continue;
    const ranked = [...groupedClaims].sort((left, right) => {
      const leftAssessment = assessmentBySource.get(sourceByVersion.get(left.sourceVersionId)!);
      const rightAssessment = assessmentBySource.get(sourceByVersion.get(right.sourceVersionId)!);
      if (!leftAssessment || !rightAssessment) return left.id.localeCompare(right.id);
      return Number(rightAssessment.independent) - Number(leftAssessment.independent)
        || right.authorityWeight - left.authorityWeight
        || freshnessRank(rightAssessment.freshness) - freshnessRank(leftAssessment.freshness)
        || timestampRank(rightAssessment.retrievedAt) - timestampRank(leftAssessment.retrievedAt)
        || left.id.localeCompare(right.id);
    });
    const winner = ranked[0];
    const winnerSourceId = sourceByVersion.get(winner.sourceVersionId)!;
    const winnerAssessment = assessmentBySource.get(winnerSourceId)!;
    const winnerSource = sourceById.get(winnerSourceId)!;
    const winnerFreshness = winnerAssessment.freshness;
    conflicts.push({
      conflictGroup,
      winnerClaimId: winner.id,
      claimIds: ranked.map(({ id }) => id),
      distinctClaimCount,
      rationale: `${winnerSource.name} wins the published ranking: independent evidence first, then authority (${Math.round(winner.authorityWeight * 100)}%), freshness (${winnerFreshness}), retrieval time, and stable claim ID. Syndicated copies cannot outvote their representative.`,
    });
  }

  const counts = assessments.reduce<EvidenceQualityReport["counts"]>((result, assessment) => {
    result[assessment.freshness] += 1;
    if (assessment.independent) result.independent += 1;
    else result.duplicate += 1;
    if (assessment.promptInjectionFlags.length > 0) result.injectionFlagged += 1;
    return result;
  }, { current: 0, stale: 0, unknown: 0, independent: 0, duplicate: 0, injectionFlagged: 0, conflictGroups: conflicts.length });

  return {
    sources: assessments,
    duplicateGroups: duplicateGroups.sort((left, right) => left.representativeSourceId.localeCompare(right.representativeSourceId)),
    conflicts: conflicts.sort((left, right) => left.conflictGroup.localeCompare(right.conflictGroup)),
    counts,
  };
}
