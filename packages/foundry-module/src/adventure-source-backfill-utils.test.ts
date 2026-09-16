/**
 * Board #1714: tests for the adventure-source-backfill planning logic.
 *
 * The LIVE fixture below mirrors what a read-only copy of the live dnd-dm-main world and the
 * installed curse-of-strahd-by-claygolem Adventure pack held on 2026-09-16 (ids, names, active
 * flag, token counts, backgrounds, duplicateSource). Four world scenes share an id AND a background
 * with a package scene. The Amber Temple entry's package background is illustrative (not read).
 */

import { describe, it, expect } from 'vitest';
import {
  planSourceTagBackfill,
  backfillPlanId,
  backfillUpdatePayload,
  parsePackArg,
  sameBackground,
  sameSceneName,
  type BackfillPackScene,
  type BackfillWorldScene,
} from './adventure-source-backfill-utils.js';

const PACK = 'curse-of-strahd-by-claygolem.Curse-of-Strahd';
const BG = 'modules/curse-of-strahd-by-claygolem/Packs/Scenes/';

const PACK_SCENES: BackfillPackScene[] = [
  {
    adventure_id: 'EcvHvhJXmGoRIksY',
    adventure_name: 'Arc A - Death House',
    scene_id: 'FBot4IT6IOGsSq8A',
    name: '1-Death House',
    background: `${BG}1-DeathHouse.webp`,
  },
  {
    adventure_id: 'EcvHvhJXmGoRIksY',
    adventure_name: 'Arc A - Death House',
    scene_id: 'GiLH3LdScrBhrkke',
    name: '2-Death House Dungeons',
    background: `${BG}1-DeathHouseDungeons.webp`,
  },
  {
    adventure_id: '4Fst9kuGnkQsNlei',
    adventure_name: 'Arc B - Barovia',
    scene_id: 'bICKY970prlBT27M',
    name: 'B5b - Town Square',
    background: `${BG}1-BaroviaStreets.webp`,
  },
  {
    adventure_id: '4Fst9kuGnkQsNlei',
    adventure_name: 'Arc B - Barovia',
    scene_id: 'p3ENtVj3gnmL424f',
    name: 'B5 - Barovia Village Map',
    background: `${BG}1-MapOfBarovia.webp`,
  },
  {
    adventure_id: 'ROrUGdFJq5nUniFT',
    adventure_name: 'Arc S - A Sword of Sunlight',
    scene_id: 'jwUBZsL4SbtP6W5V',
    name: 'Amber Temple',
    background: `${BG}illustrative-AmberTemple.webp`,
  },
];

function world(
  id: string,
  name: string,
  background: string,
  extra: Partial<BackfillWorldScene> = {}
): BackfillWorldScene {
  return {
    id,
    name,
    background,
    active: false,
    token_count: 0,
    duplicate_source: null,
    tags: null,
    ...extra,
  };
}

const LIVE_WORLD: BackfillWorldScene[] = [
  world(
    '8dX8d0iZWCndDYP9',
    'Curse of Strahd: Blue Water Inn',
    'worlds/dnd-dm-maps/curse-of-strahd/p100.jpg'
  ),
  world('FBot4IT6IOGsSq8A', 'Curse of Strahd: Death House', `${BG}1-DeathHouse.webp`, {
    active: true,
    token_count: 4,
    duplicate_source: 'Scene.x0mQOJ1MS1s2EuKv',
  }),
  world(
    'GiLH3LdScrBhrkke',
    'Curse of Strahd: Death House Basement',
    `${BG}1-DeathHouseDungeons.webp`,
    {
      token_count: 27,
    }
  ),
  world('bICKY970prlBT27M', 'Curse of Strahd: Village of Barovia', `${BG}1-BaroviaStreets.webp`, {
    token_count: 1,
  }),
  world(
    'hf1Q1R9xDtBqsgja',
    'Curse of Strahd: Amber Temple',
    'worlds/dnd-dm-maps/curse-of-strahd/p191.jpg'
  ),
  world('p3ENtVj3gnmL424f', 'Curse of Strahd: Barovia', `${BG}1-MapOfBarovia.webp`),
  world(
    'GSwRSQiQXEjUysdD',
    'Lost Mine of Phandelver: Phandalin',
    'worlds/dnd-dm-maps/lost-mine-of-phandelver/p17-map.jpg'
  ),
];

describe('planSourceTagBackfill on the live-shaped world', () => {
  const plan = planSourceTagBackfill({
    pack: PACK,
    packScenes: PACK_SCENES,
    worldScenes: LIVE_WORLD,
  });

  it('plans to tag exactly the four scenes that share an id and a background with the pack', () => {
    expect(plan.will_tag.map(e => e.scene_id)).toEqual([
      'FBot4IT6IOGsSq8A',
      'GiLH3LdScrBhrkke',
      'bICKY970prlBT27M',
      'p3ENtVj3gnmL424f',
    ]);
    const dh = plan.will_tag[0]!;
    expect(dh).toMatchObject({
      scene_name: 'Curse of Strahd: Death House',
      active: true,
      token_count: 4,
      duplicate_source: 'Scene.x0mQOJ1MS1s2EuKv',
      match: { by_id: true, same_background: true, same_name: true },
      source: {
        pack: PACK,
        adventure_id: 'EcvHvhJXmGoRIksY',
        adventure_name: 'Arc A - Death House',
        scene_id: 'FBot4IT6IOGsSq8A',
        scene_name: '1-Death House',
      },
      tags: { sourcePack: PACK, sourceSceneId: 'FBot4IT6IOGsSq8A', adoptedFor: 'FBot4IT6IOGsSq8A' },
    });
  });

  it('lists a name-only match under a different id for review and never tags it', () => {
    expect(plan.needs_review.map(e => e.scene_id)).toEqual(['hf1Q1R9xDtBqsgja']);
    expect(plan.needs_review[0]!.tags).toBeUndefined();
    expect(plan.needs_review[0]!.match).toEqual({
      by_id: false,
      same_background: false,
      same_name: true,
    });
    expect(plan.needs_review[0]!.reason).toContain('not tagged');
  });

  it('counts everything and leaves unrelated scenes out of the lists', () => {
    expect(plan.summary).toEqual({
      world_scenes_checked: 7,
      pack_scenes: 5,
      will_tag: 4,
      already_tagged: 0,
      needs_review: 1,
      conflicts: 0,
    });
    const listed = [...plan.will_tag, ...plan.needs_review].map(e => e.scene_id);
    expect(listed).not.toContain('8dX8d0iZWCndDYP9');
    expect(listed).not.toContain('GSwRSQiQXEjUysdD');
  });

  it('gives a stable plan_id that does not depend on world order', () => {
    const again = planSourceTagBackfill({
      pack: PACK,
      packScenes: PACK_SCENES,
      worldScenes: [...LIVE_WORLD].reverse(),
    });
    expect(again.plan_id).toBe(plan.plan_id);
    expect(plan.plan_id).toMatch(/^bf-4-[0-9a-f]{8}$/);
  });
});

describe('planSourceTagBackfill edge cases', () => {
  it('moves a scene that is already tagged to already_tagged, and the plan_id changes', () => {
    const before = planSourceTagBackfill({
      pack: PACK,
      packScenes: PACK_SCENES,
      worldScenes: LIVE_WORLD,
    });
    const tagged = LIVE_WORLD.map(w =>
      w.id === 'FBot4IT6IOGsSq8A'
        ? { ...w, tags: { sourcePack: PACK, sourceSceneId: 'FBot4IT6IOGsSq8A' } }
        : w
    );
    const after = planSourceTagBackfill({
      pack: PACK,
      packScenes: PACK_SCENES,
      worldScenes: tagged,
    });
    expect(after.already_tagged.map(e => e.scene_id)).toEqual(['FBot4IT6IOGsSq8A']);
    expect(after.will_tag.map(e => e.scene_id)).not.toContain('FBot4IT6IOGsSq8A');
    expect(after.plan_id).not.toBe(before.plan_id);
  });

  it('does not tag a same-id scene whose background differs (it may have been rebuilt)', () => {
    const rebuilt = [world('FBot4IT6IOGsSq8A', 'Death House', 'worlds/dnd-dm-maps/rebuilt.jpg')];
    const plan = planSourceTagBackfill({
      pack: PACK,
      packScenes: PACK_SCENES,
      worldScenes: rebuilt,
    });
    expect(plan.will_tag).toEqual([]);
    expect(plan.needs_review[0]!.reason).toContain('different background');
  });

  it('reports a same-id scene tagged from another pack as a conflict and does not tag it', () => {
    const w = [
      world('FBot4IT6IOGsSq8A', 'Death House', `${BG}1-DeathHouse.webp`, {
        tags: { sourcePack: 'other.pack', sourceSceneId: 'abc' },
      }),
    ];
    const plan = planSourceTagBackfill({ pack: PACK, packScenes: PACK_SCENES, worldScenes: w });
    expect(plan.will_tag).toEqual([]);
    expect(plan.conflicts[0]!.reason).toContain('other.pack');
  });

  it('does not call a tag stale when only some Adventure entries were loaded (partialPack)', () => {
    const w = [
      world('zz1', 'Old', 'x.jpg', { tags: { sourcePack: PACK, sourceSceneId: 'inOtherArc' } }),
    ];
    const plan = planSourceTagBackfill({
      pack: PACK,
      packScenes: PACK_SCENES,
      worldScenes: w,
      partialPack: true,
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.already_tagged).toEqual([]);
  });

  it('reports a package scene whose id is an invalid stored world scene as a conflict', () => {
    const plan = planSourceTagBackfill({
      pack: PACK,
      packScenes: PACK_SCENES,
      worldScenes: LIVE_WORLD.filter(w => w.id !== 'FBot4IT6IOGsSq8A'),
      invalidWorldIds: ['FBot4IT6IOGsSq8A'],
    });
    expect(plan.will_tag.map(e => e.scene_id)).not.toContain('FBot4IT6IOGsSq8A');
    expect(plan.conflicts.map(e => e.scene_id)).toEqual(['FBot4IT6IOGsSq8A']);
    expect(plan.conflicts[0]!.reason).toContain("failed Foundry's data checks");
  });

  it('respects onlySceneIds for invalid ids too', () => {
    const plan = planSourceTagBackfill({
      pack: PACK,
      packScenes: PACK_SCENES,
      worldScenes: LIVE_WORLD,
      invalidWorldIds: ['FBot4IT6IOGsSq8A'],
      onlySceneIds: ['GiLH3LdScrBhrkke'],
    });
    expect(plan.conflicts).toEqual([]);
  });

  it('reports a stale tag that points at a scene this pack does not have', () => {
    const w = [world('zz1', 'Old', 'x.jpg', { tags: { sourcePack: PACK, sourceSceneId: 'nope' } })];
    const plan = planSourceTagBackfill({ pack: PACK, packScenes: PACK_SCENES, worldScenes: w });
    expect(plan.conflicts.map(e => e.scene_id)).toEqual(['zz1']);
  });

  it('refuses to tag a scene when another world scene already claims that package scene', () => {
    const w = [
      world('FBot4IT6IOGsSq8A', 'Death House', `${BG}1-DeathHouse.webp`),
      world('copy000000000001', 'Death House copy', `${BG}1-DeathHouse.webp`, {
        tags: { sourcePack: PACK, sourceSceneId: 'FBot4IT6IOGsSq8A' },
      }),
    ];
    const plan = planSourceTagBackfill({ pack: PACK, packScenes: PACK_SCENES, worldScenes: w });
    expect(plan.will_tag).toEqual([]);
    expect(plan.conflicts.map(e => e.scene_id)).toEqual(['FBot4IT6IOGsSq8A']);
    expect(plan.already_tagged.map(e => e.scene_id)).toEqual(['copy000000000001']);
  });

  it('does not tag an id that appears in two Adventure entries', () => {
    const dup = [...PACK_SCENES, { ...PACK_SCENES[0]!, adventure_id: 'otherAdv00000001' }];
    const plan = planSourceTagBackfill({ pack: PACK, packScenes: dup, worldScenes: LIVE_WORLD });
    expect(plan.will_tag.map(e => e.scene_id)).not.toContain('FBot4IT6IOGsSq8A');
    expect(plan.needs_review.find(e => e.scene_id === 'FBot4IT6IOGsSq8A')!.candidates).toHaveLength(
      2
    );
  });

  it('only checks the scene ids it is limited to', () => {
    const plan = planSourceTagBackfill({
      pack: PACK,
      packScenes: PACK_SCENES,
      worldScenes: LIVE_WORLD,
      onlySceneIds: ['GiLH3LdScrBhrkke'],
    });
    expect(plan.summary.world_scenes_checked).toBe(1);
    expect(plan.will_tag.map(e => e.scene_id)).toEqual(['GiLH3LdScrBhrkke']);
    expect(plan.plan_id).toMatch(/^bf-1-/);
  });
});

describe('backfillUpdatePayload', () => {
  it('writes only flags.aidm keys', () => {
    const plan = planSourceTagBackfill({
      pack: PACK,
      packScenes: PACK_SCENES,
      worldScenes: LIVE_WORLD,
    });
    const payload = backfillUpdatePayload(plan.will_tag[0]!);
    expect(payload).toEqual({
      'flags.aidm.sourcePack': PACK,
      'flags.aidm.sourceSceneId': 'FBot4IT6IOGsSq8A',
      'flags.aidm.adoptedFor': 'FBot4IT6IOGsSq8A',
      'flags.aidm.sourceTaggedBy': 'adventure-source-backfill',
    });
    expect(Object.keys(payload).every(k => k.startsWith('flags.aidm.'))).toBe(true);
  });

  it('throws for an entry with no planned tags', () => {
    expect(() =>
      backfillUpdatePayload({
        scene_id: 'x',
        scene_name: null,
        active: false,
        token_count: 0,
        duplicate_source: null,
        match: { by_id: false, same_background: false, same_name: false },
        source: null,
      })
    ).toThrow();
  });
});

describe('small helpers', () => {
  it('parsePackArg accepts a pack id, a package id and a scene ref', () => {
    expect(parsePackArg(PACK)).toEqual({ pack: PACK, adventureId: null });
    expect(parsePackArg(`${PACK}:EcvHvhJXmGoRIksY`)).toEqual({
      pack: PACK,
      adventureId: 'EcvHvhJXmGoRIksY',
    });
    expect(parsePackArg(`${PACK}.EcvHvhJXmGoRIksY.FBot4IT6IOGsSq8A`)).toEqual({
      pack: PACK,
      adventureId: 'EcvHvhJXmGoRIksY',
    });
    expect(parsePackArg('')).toBeNull();
    expect(parsePackArg('nodot')).toBeNull();
    expect(parsePackArg(undefined)).toBeNull();
  });

  it('sameBackground ignores a cache-busting query and needs both sides', () => {
    expect(sameBackground('a/b.webp?123', 'a/b.webp')).toBe(true);
    expect(sameBackground('a/b.webp', 'a/c.webp')).toBe(false);
    expect(sameBackground(null, 'a/b.webp')).toBe(false);
  });

  it('sameSceneName matches a prefixed world name to a coded package name, loosely', () => {
    expect(sameSceneName('Curse of Strahd: Death House', '1-Death House')).toBe(true);
    expect(sameSceneName('Curse of Strahd: Barovia', 'B5 - Barovia Village Map')).toBe(false);
    expect(sameSceneName('Amber Temple', 'Amber Temple')).toBe(true);
  });

  it('backfillPlanId is the same for the same set in any order', () => {
    const plan = planSourceTagBackfill({
      pack: PACK,
      packScenes: PACK_SCENES,
      worldScenes: LIVE_WORLD,
    });
    expect(backfillPlanId([...plan.will_tag].reverse())).toBe(plan.plan_id);
    expect(backfillPlanId([])).toMatch(/^bf-0-/);
  });
});
