// Reciprocal Rank Fusion — merges two ranked lists by reciprocal-rank scores.
//
//   score(item) = sum_l ( 1 / (k + rank_l(item)) )
//
// k=60 is the original RRF paper recommendation; we keep it (PLAN §5.1).

export interface RankedHit {
  id: string;
  score: number;
}

export function rrfFuse(lists: RankedHit[][], k = 60, limit = 50): RankedHit[] {
  const acc = new Map<string, number>();
  for (const list of lists) {
    list.forEach((hit, idx) => {
      const rank = idx + 1;
      const contribution = 1 / (k + rank);
      acc.set(hit.id, (acc.get(hit.id) ?? 0) + contribution);
    });
  }
  return [...acc.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
