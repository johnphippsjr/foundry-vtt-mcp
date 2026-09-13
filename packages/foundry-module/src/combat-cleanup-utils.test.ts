import { describe, it, expect } from 'vitest';
import { staleCombatIdsToDelete } from './combat-cleanup-utils.js';

describe('staleCombatIdsToDelete (board #1652)', () => {
  it('returns nothing when no Combat documents exist at all', () => {
    expect(staleCombatIdsToDelete([], null)).toEqual([]);
  });

  it('keepId=null (handleStartCombat before creating a new combat) deletes every existing id', () => {
    expect(staleCombatIdsToDelete(['c1', 'c2', 'c3'], null)).toEqual(['c1', 'c2', 'c3']);
  });

  it('a single leftover combat with no active fight is deleted -- the exact board #1645/#1652 shape for one orphan', () => {
    expect(staleCombatIdsToDelete(['orphan-1'], null)).toEqual(['orphan-1']);
  });

  it('keeps the one combat named by keepId and deletes every other one (handleEndCombat sweeping around the fight it just handled)', () => {
    expect(staleCombatIdsToDelete(['c1', 'c2', 'c3'], 'c2')).toEqual(['c1', 'c3']);
  });

  it('a keepId that is not present in the list changes nothing -- there is nothing to spare, so every id is deleted', () => {
    expect(staleCombatIdsToDelete(['c1', 'c2'], 'not-in-the-list')).toEqual(['c1', 'c2']);
  });

  it('never mutates or reorders the input array', () => {
    const input = ['c1', 'c2', 'c3'];
    const result = staleCombatIdsToDelete(input, null);
    expect(input).toEqual(['c1', 'c2', 'c3']);
    expect(result).not.toBe(input);
  });
});
