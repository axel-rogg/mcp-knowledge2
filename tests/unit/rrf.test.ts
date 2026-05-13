import { describe, expect, it } from 'vitest';
import { rrfFuse } from '../../src/search/rrf.ts';

describe('rrfFuse', () => {
  it('fuses two ranked lists and dedupes', () => {
    const fts = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.8 },
      { id: 'c', score: 0.7 },
    ];
    const vec = [
      { id: 'b', score: 0.99 },
      { id: 'd', score: 0.95 },
      { id: 'a', score: 0.85 },
    ];
    const fused = rrfFuse([fts, vec], 60, 10);
    expect(fused.length).toBe(4); // a, b, c, d
    expect(fused.map((f) => f.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    // items appearing in both lists should rank above singletons
    const aIdx = fused.findIndex((f) => f.id === 'a');
    const bIdx = fused.findIndex((f) => f.id === 'b');
    const cIdx = fused.findIndex((f) => f.id === 'c');
    expect(aIdx).toBeLessThan(cIdx);
    expect(bIdx).toBeLessThan(cIdx);
  });

  it('respects the limit', () => {
    const lists = [
      [{ id: 'a', score: 1 }, { id: 'b', score: 1 }, { id: 'c', score: 1 }],
      [{ id: 'd', score: 1 }, { id: 'e', score: 1 }],
    ];
    expect(rrfFuse(lists, 60, 2).length).toBe(2);
  });
});
