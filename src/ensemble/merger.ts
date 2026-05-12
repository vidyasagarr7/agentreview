import { ModelFinding, FindingSeverity } from '../types/index.js';

// ─── Severity Ranks ────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

const RANK_TO_SEVERITY: FindingSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

// ─── Token Overlap ─────────────────────────────────────────────────────────────

/**
 * Jaccard similarity of lowercased word tokens between two strings.
 * Splits on whitespace, filters empty tokens, computes |intersection|/|union|.
 * Returns 1 if both strings are empty.
 */
export function tokenOverlap(a: string, b: string): number {
  const tokenize = (s: string): Set<string> => {
    const tokens = s.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    return new Set(tokens);
  };

  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }

  let intersectionCount = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersectionCount++;
    }
  }

  const unionSize = setA.size + setB.size - intersectionCount;
  if (unionSize === 0) {
    return 1;
  }

  return intersectionCount / unionSize;
}

// ─── Finding Similarity ────────────────────────────────────────────────────────

/**
 * Determines if two ModelFindings are similar enough to be merged.
 * Criteria:
 *  - Same normalized file (lowercase, strip line number with split(':')[0])
 *  - Adjacent severity (rank difference <= 1)
 *  - Token overlap of summaries > threshold (default 0.7)
 */
export function areSimilarFindings(
  a: ModelFinding,
  b: ModelFinding,
  threshold = 0.7,
): boolean {
  // Normalize file: lowercase, strip line numbers
  const normalizeFile = (loc: string): string => loc.toLowerCase().split(':')[0];
  if (normalizeFile(a.location) !== normalizeFile(b.location)) {
    return false;
  }

  // Adjacent severity check
  const rankA = SEVERITY_RANK[a.severity];
  const rankB = SEVERITY_RANK[b.severity];
  if (Math.abs(rankA - rankB) > 1) {
    return false;
  }

  // Token overlap of summaries
  return tokenOverlap(a.summary, b.summary) > threshold;
}

// ─── Union-Find ────────────────────────────────────────────────────────────────

class UnionFind {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]); // path compression
    }
    return this.parent[x];
  }

  union(x: number, y: number): void {
    const rootX = this.find(x);
    const rootY = this.find(y);
    if (rootX !== rootY) {
      this.parent[rootX] = rootY;
    }
  }
}

// ─── Merge Findings ────────────────────────────────────────────────────────────

/**
 * Merges an array of per-model finding arrays into a deduplicated list.
 *
 * Steps:
 *  1. Flatten all findings
 *  2. Group similar findings using union-find
 *  3. For each group: canonical = longest detail, merge sources/lenses, highest severity
 *  4. Sort by agreementCount desc, then severity rank asc
 */
export function mergeFindings(
  modelFindings: ModelFinding[][],
  options?: {
    similarityThreshold?: number;
    strategy?: 'unanimous' | 'majority' | 'any';
    totalModels?: number;
  },
): ModelFinding[] {
  const threshold = options?.similarityThreshold ?? 0.7;

  // Flatten all findings
  const flat: ModelFinding[] = modelFindings.flat();
  const n = flat.length;

  if (n === 0) {
    return [];
  }

  // Build union-find groups
  const uf = new UnionFind(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (areSimilarFindings(flat[i], flat[j], threshold)) {
        uf.union(i, j);
      }
    }
  }

  // Collect groups
  const groupMap = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const group = groupMap.get(root);
    if (group) {
      group.push(i);
    } else {
      groupMap.set(root, [i]);
    }
  }

  // Merge each group into a single canonical finding
  const merged: ModelFinding[] = [];
  for (const indices of groupMap.values()) {
    const findings = indices.map(i => flat[i]);

    // Canonical = finding with longest detail
    const canonical = findings.reduce((best, f) =>
      f.detail.length > best.detail.length ? f : best,
    );

    // Merge modelSources (unique models that contributed)
    const allSources = new Set<string>();
    for (const f of findings) {
      allSources.add(f.modelSource);
      for (const src of f.modelSources) {
        allSources.add(src);
      }
    }

    // Highest severity = lowest rank
    const highestRank = Math.min(...findings.map(f => SEVERITY_RANK[f.severity]));
    const highestSeverity = RANK_TO_SEVERITY[highestRank];

    // Merge lenses (union)
    const allLenses = new Set<string>();
    for (const f of findings) {
      for (const lens of f.lenses) {
        allLenses.add(lens);
      }
    }

    merged.push({
      ...canonical,
      severity: highestSeverity,
      lenses: Array.from(allLenses),
      modelSources: Array.from(allSources),
      agreementCount: allSources.size,
    });
  }

  // Sort: agreementCount desc, then severity rank asc (higher severity first)
  merged.sort((a, b) => {
    if (b.agreementCount !== a.agreementCount) {
      return b.agreementCount - a.agreementCount;
    }
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  });

  return merged;
}
