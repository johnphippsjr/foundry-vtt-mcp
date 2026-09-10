/**
 * start-combat default-scoping pure-helper tests (board #1311, bridge fix 0006).
 *
 * These cover the generic-by-construction claims made in bridge/README.md's 0006 entry: the
 * default combatant set is never "every token on the scene"; it is the party plus only hostile,
 * non-hidden tokens that share a Region with the party or, absent that, are in the party's line
 * of sight; hidden tokens and non-hostile bystanders are never swept in; and an explicit token
 * list still bypasses this scoping entirely (that is handled in queries.ts, unit-tested here only
 * by confirming this module never looks at anything but what selectDefaultCombatants is handed).
 */

import { describe, it, expect } from 'vitest';
import {
  TOKEN_DISPOSITION_HOSTILE,
  selectDefaultCombatants,
  formatScopingSummary,
  type CombatToken,
} from './combat-scoping-utils.js';

const HOSTILE = TOKEN_DISPOSITION_HOSTILE;
const NEUTRAL = 0;
const FRIENDLY = 1;

function pc(id: string, name = id): CombatToken {
  return { id, name, actorType: 'character', disposition: FRIENDLY, hidden: false };
}
function monster(id: string, opts: Partial<CombatToken> = {}): CombatToken {
  return { id, name: id, actorType: 'npc', disposition: HOSTILE, hidden: false, ...opts };
}
function noop() {
  return undefined;
}

describe('selectDefaultCombatants: party detection', () => {
  it('auto-detects the party as every character-type actor token when no explicit party ref is given', () => {
    const tokens = [pc('pc1'), pc('pc2'), monster('m1')];
    const result = selectDefaultCombatants(tokens, {
      resolveRef: noop,
      regionsExistOnScene: false,
      tokenRegionIds: () => [],
      hasLineOfSight: () => false,
    });
    expect(result.party.map(t => t.id).sort()).toEqual(['pc1', 'pc2']);
  });

  it('uses explicit party refs (resolved by id or name) instead of actor type when given', () => {
    const tokens = [pc('pc1'), monster('hiredHand', { actorType: 'npc' })];
    const resolveRef = (ref: string) => tokens.find(t => t.id === ref || t.name?.toLowerCase() === ref.toLowerCase())?.id;
    const result = selectDefaultCombatants(tokens, {
      explicitPartyRefs: ['pc1', 'hiredHand'],
      resolveRef,
      regionsExistOnScene: false,
      tokenRegionIds: () => [],
      hasLineOfSight: () => false,
    });
    expect(result.party.map(t => t.id).sort()).toEqual(['hiredHand', 'pc1']);
  });

  it('ignores an explicit party ref that resolves to nothing rather than throwing', () => {
    const tokens = [pc('pc1')];
    const result = selectDefaultCombatants(tokens, {
      explicitPartyRefs: ['doesNotExist'],
      resolveRef: () => undefined,
      regionsExistOnScene: false,
      tokenRegionIds: () => [],
      hasLineOfSight: () => false,
    });
    // no explicit id resolved -> falls back to auto-detect by actor type
    expect(result.party.map(t => t.id)).toEqual(['pc1']);
  });
});

describe('selectDefaultCombatants: never "everything on the scene"', () => {
  it('never admits a friendly or neutral non-party token, and never reports one as excluded either', () => {
    const tokens = [pc('pc1'), monster('m1'), { id: 'villager', name: 'villager', actorType: 'npc', disposition: NEUTRAL, hidden: false }];
    const result = selectDefaultCombatants(tokens, {
      resolveRef: noop,
      regionsExistOnScene: false,
      tokenRegionIds: () => [],
      hasLineOfSight: () => true,
    });
    const allReported = [...result.admitted, ...result.excluded.map(e => e.token)].map(t => t.id);
    expect(allReported).not.toContain('villager');
  });

  it('never admits a hidden hostile, regardless of region or line-of-sight state', () => {
    const p = pc('pc1');
    const tokens = [p, monster('hiddenFoe', { hidden: true })];
    const result = selectDefaultCombatants(tokens, {
      resolveRef: noop,
      regionsExistOnScene: true,
      tokenRegionIds: () => ['roomA'], // would otherwise match on region
      hasLineOfSight: () => true, // would otherwise match on sight
    });
    expect(result.admitted.map(t => t.id)).not.toContain('hiddenFoe');
    expect(result.excluded).toEqual([{ token: tokens[1], reason: 'hidden' }]);
  });
});

describe('selectDefaultCombatants: region mode', () => {
  it('uses region mode once the party is found inside a region, and admits a hostile sharing that region', () => {
    const p = pc('pc1');
    const inRoom = monster('inRoom');
    const otherRoom = monster('otherRoom');
    const tokens = [p, inRoom, otherRoom];
    const regionOf: Record<string, string[]> = { pc1: ['storageRoom'], inRoom: ['storageRoom'], otherRoom: ['anotherRoom'] };
    const result = selectDefaultCombatants(tokens, {
      resolveRef: noop,
      regionsExistOnScene: true,
      tokenRegionIds: t => regionOf[t.id] || [],
      hasLineOfSight: () => true, // must be ignored in region mode
    });
    expect(result.mode).toBe('region');
    expect(result.admitted.map(t => t.id)).toEqual(['inRoom']);
    expect(result.excluded).toEqual([{ token: otherRoom, reason: 'out-of-room' }]);
  });

  it('this is the exact Death House shape: an Animated Armor in a different room is excluded, not swept into a Storage Room fight', () => {
    const party = pc('pc1');
    const armoredFoeElsewhere = monster('animatedArmor');
    const storageRoomFoe = monster('skeleton');
    const tokens = [party, armoredFoeElsewhere, storageRoomFoe];
    const regionOf: Record<string, string[]> = {
      pc1: ['storageRoom'],
      skeleton: ['storageRoom'],
      animatedArmor: ['anotherRoomEntirely'],
    };
    const result = selectDefaultCombatants(tokens, {
      resolveRef: noop,
      regionsExistOnScene: true,
      tokenRegionIds: t => regionOf[t.id] || [],
      hasLineOfSight: () => true,
    });
    expect(result.admitted.map(t => t.id)).toEqual(['skeleton']);
    expect(result.excluded.map(e => e.token.id)).toEqual(['animatedArmor']);
  });

  it('excludes a hostile that occupies no region at all, even though the scene has regions', () => {
    const p = pc('pc1');
    const untaggedFoe = monster('untagged');
    const tokens = [p, untaggedFoe];
    const result = selectDefaultCombatants(tokens, {
      resolveRef: noop,
      regionsExistOnScene: true,
      tokenRegionIds: t => (t.id === 'pc1' ? ['roomA'] : []),
      hasLineOfSight: () => true,
    });
    expect(result.mode).toBe('region');
    expect(result.admitted).toEqual([]);
    expect(result.excluded).toEqual([{ token: untaggedFoe, reason: 'out-of-room' }]);
  });
});

describe('selectDefaultCombatants: line-of-sight fallback', () => {
  it('falls back to line-of-sight when the scene has no regions at all', () => {
    const p = pc('pc1');
    const visible = monster('visible');
    const blocked = monster('blocked');
    const tokens = [p, visible, blocked];
    const result = selectDefaultCombatants(tokens, {
      resolveRef: noop,
      regionsExistOnScene: false,
      tokenRegionIds: () => [],
      hasLineOfSight: (a, b) => b.id === 'visible',
    });
    expect(result.mode).toBe('line-of-sight');
    expect(result.admitted.map(t => t.id)).toEqual(['visible']);
    expect(result.excluded).toEqual([{ token: blocked, reason: 'no-line-of-sight' }]);
  });

  it('falls back to line-of-sight when the scene HAS regions but the party is not standing in any of them', () => {
    const p = pc('pc1'); // occupies no region
    const nearby = monster('nearby');
    const tokens = [p, nearby];
    const result = selectDefaultCombatants(tokens, {
      resolveRef: noop,
      regionsExistOnScene: true,
      tokenRegionIds: t => (t.id === 'nearby' ? ['someRoom'] : []), // hostile has a region, party does not
      hasLineOfSight: () => true,
    });
    expect(result.mode).toBe('line-of-sight');
    expect(result.admitted.map(t => t.id)).toEqual(['nearby']);
  });

  it('admits a hostile visible to ANY party token, not only the first', () => {
    const p1 = pc('pc1');
    const p2 = pc('pc2');
    const foe = monster('foe');
    const tokens = [p1, p2, foe];
    const result = selectDefaultCombatants(tokens, {
      resolveRef: noop,
      regionsExistOnScene: false,
      tokenRegionIds: () => [],
      hasLineOfSight: (a, b) => a.id === 'pc2' && b.id === 'foe',
    });
    expect(result.admitted.map(t => t.id)).toEqual(['foe']);
  });

  it('fails closed (excludes) when the line-of-sight check itself reports nothing is visible -- proving an unavailable/erroring collision test can never silently over-include a hostile', () => {
    const p = pc('pc1');
    const foe = monster('foe');
    const tokens = [p, foe];
    const result = selectDefaultCombatants(tokens, {
      resolveRef: noop,
      regionsExistOnScene: false,
      tokenRegionIds: () => [],
      hasLineOfSight: () => false, // simulates an unavailable/erroring backend, per queries.ts's fail-closed wiring
    });
    expect(result.admitted).toEqual([]);
    expect(result.excluded).toEqual([{ token: foe, reason: 'no-line-of-sight' }]);
  });
});

describe('formatScopingSummary', () => {
  it('formats party/admitted/excluded down to plain {id, name} shapes plus the exclusion reason, for a JSON reply', () => {
    const p = pc('pc1');
    const admitted = monster('m1');
    const excluded = monster('m2', { hidden: true });
    const summary = formatScopingSummary({ party: [p], admitted: [admitted], excluded: [{ token: excluded, reason: 'hidden' }], mode: 'region' });
    expect(summary).toEqual({
      mode: 'region',
      party: [{ id: 'pc1', name: 'pc1' }],
      admitted: [{ id: 'm1', name: 'm1' }],
      excluded: [{ id: 'm2', name: 'm2', reason: 'hidden' }],
    });
  });
});
