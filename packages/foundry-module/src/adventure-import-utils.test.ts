/**
 * adventure-import / scene-integrity pure-helper tests (board #1311 root-cause fix).
 *
 * These cover the generic-by-construction claims made in bridge/README.md: uuid detection never
 * names a specific behavior field, the walk finds refs at any depth (including a brand-new
 * behavior type this code has never seen), and the module search scope is read entirely off the
 * pack's own metadata and the owning module's own manifest, never a hardcoded module/adventure id.
 */

import { describe, it, expect } from 'vitest';
import {
  looksLikeSceneUuid,
  walkForSceneUuids,
  packModuleId,
  summarizeUnresolved,
  moduleSearchScope,
  readAidmFlag,
  isAdoptedFrom,
  aidmTagUpdatePayload,
} from './adventure-import-utils.js';

describe('looksLikeSceneUuid', () => {
  it('accepts a bare Scene uuid (16-char id)', () => {
    expect(looksLikeSceneUuid('Scene.x0mQOJ1MS1s2EuKv')).toBe(true);
  });

  it('accepts a Scene.Region embedded uuid', () => {
    expect(looksLikeSceneUuid('Scene.x0mQOJ1MS1s2EuKv.Region.aBcD1234EfGh5678')).toBe(true);
  });

  it('rejects a short/non-id trailing segment (false-positive guard)', () => {
    // "Description" is not a 16-char Foundry id -- this must NOT be flagged as a dangling ref.
    expect(looksLikeSceneUuid('Scene.Description')).toBe(false);
  });

  it('rejects a uuid rooted at a different document type', () => {
    expect(looksLikeSceneUuid('Actor.x0mQOJ1MS1s2EuKv')).toBe(false);
  });

  it('rejects non-strings and empty values', () => {
    expect(looksLikeSceneUuid(null)).toBe(false);
    expect(looksLikeSceneUuid(undefined)).toBe(false);
    expect(looksLikeSceneUuid(42)).toBe(false);
    expect(looksLikeSceneUuid('')).toBe(false);
  });
});

describe('walkForSceneUuids', () => {
  it('finds a known field (teleportToken destination) without naming it in the walk', () => {
    const behaviorData = {
      type: 'teleportToken',
      system: { destination: 'Scene.x0mQOJ1MS1s2EuKv.Region.aBcD1234EfGh5678', choice: false },
    };
    const out: { path: string; value: string }[] = [];
    walkForSceneUuids(behaviorData, 'behavior', new Set(), out);
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe('Scene.x0mQOJ1MS1s2EuKv.Region.aBcD1234EfGh5678');
    expect(out[0].path).toBe('behavior.system.destination');
  });

  it('finds a uuid on a HYPOTHETICAL new behavior type with a differently-named field', () => {
    // Proves the walk is generic: a behavior type this code has never seen, storing its
    // reference under an arbitrary field name, is still found.
    const behaviorData = {
      type: 'someFutureBehaviorNobodyHasWrittenYet',
      system: { linkedRegions: ['Scene.aaaaaaaaaaaaaaaa.Region.bbbbbbbbbbbbbbbb'], other: 1 },
    };
    const out: { path: string; value: string }[] = [];
    walkForSceneUuids(behaviorData, 'behavior', new Set(), out);
    expect(out.map(o => o.value)).toContain('Scene.aaaaaaaaaaaaaaaa.Region.bbbbbbbbbbbbbbbb');
  });

  it('finds multiple refs nested inside arrays', () => {
    const data = {
      system: {
        links: [
          { to: 'Scene.1111111111111111' },
          { to: 'Scene.2222222222222222.Region.3333333333333333' },
        ],
      },
    };
    const out: { path: string; value: string }[] = [];
    walkForSceneUuids(data, 'behavior', new Set(), out);
    expect(out).toHaveLength(2);
  });

  it('does not flag ordinary strings', () => {
    const data = { name: 'Down Secret Staircase', flags: { core: { sourceId: 'not-a-uuid' } } };
    const out: { path: string; value: string }[] = [];
    walkForSceneUuids(data, 'behavior', new Set(), out);
    expect(out).toHaveLength(0);
  });

  it('does not infinite-loop on a cyclic object', () => {
    const data: any = { system: {} };
    data.system.self = data; // cycle
    const out: { path: string; value: string }[] = [];
    expect(() => walkForSceneUuids(data, 'behavior', new Set(), out)).not.toThrow();
    expect(out).toHaveLength(0);
  });
});

describe('packModuleId', () => {
  it('prefers metadata.packageName', () => {
    const pack = {
      metadata: { packageName: 'curse-of-strahd-by-claygolem' },
      collection: 'ignored.pack',
    };
    expect(packModuleId(pack)).toBe('curse-of-strahd-by-claygolem');
  });

  it('falls back to the collection prefix when packageName is missing', () => {
    const pack = { metadata: {}, collection: 'some-other-module.some-pack' };
    expect(packModuleId(pack)).toBe('some-other-module');
  });

  it('returns undefined when neither is available', () => {
    expect(packModuleId({})).toBeUndefined();
    expect(packModuleId(undefined)).toBeUndefined();
  });
});

describe('moduleSearchScope', () => {
  it('always includes the owning module, with no requires declared', () => {
    const pack = { metadata: { packageName: 'claygolem-cos' } };
    const scope = moduleSearchScope(pack, () => undefined);
    expect(scope).toEqual(new Set(['claygolem-cos']));
  });

  it('adds every module id listed under the owning module manifest relationships.requires', () => {
    const pack = { metadata: { packageName: 'claygolem-cos' } };
    const readModule = (id: string) =>
      id === 'claygolem-cos'
        ? { relationships: { requires: [{ id: 'claygolem-core-resources' }, { id: 'dnd5e' }] } }
        : undefined;
    const scope = moduleSearchScope(pack, readModule);
    expect(scope).toEqual(new Set(['claygolem-cos', 'claygolem-core-resources', 'dnd5e']));
  });

  it('is generic: swapping in a completely different module/dependency set changes the scope', () => {
    // Nothing in moduleSearchScope references "claygolem" or "dnd5e" by name -- this proves it
    // by running the same function against an unrelated module id and getting a matching scope.
    const pack = { metadata: { packageName: 'phandelver-by-someoneelse' } };
    const readModule = (id: string) =>
      id === 'phandelver-by-someoneelse'
        ? { relationships: { requires: [{ id: 'shared-tokens-pack' }] } }
        : undefined;
    const scope = moduleSearchScope(pack, readModule);
    expect(scope).toEqual(new Set(['phandelver-by-someoneelse', 'shared-tokens-pack']));
  });

  it('tolerates a module with no relationships field at all', () => {
    const pack = { metadata: { packageName: 'bare-module' } };
    const scope = moduleSearchScope(pack, () => ({}));
    expect(scope).toEqual(new Set(['bare-module']));
  });
});

describe('summarizeUnresolved', () => {
  it('returns undefined when nothing is unresolved', () => {
    expect(summarizeUnresolved([], [])).toBeUndefined();
  });

  it('names the unresolved scene ref target, scene, region and behavior', () => {
    const msg = summarizeUnresolved(
      [
        {
          scene_id: 'sceneA',
          region_id: 'regionB',
          behavior_id: 'behaviorC',
          target: 'Scene.zzzzzzzzzzzzzzzz',
        },
      ],
      []
    );
    expect(msg).toContain('1 unresolved scene/region reference');
    expect(msg).toContain('Scene.zzzzzzzzzzzzzzzz');
    expect(msg).toContain('scene sceneA');
    expect(msg).toContain('region regionB');
    expect(msg).toContain('behavior behaviorC');
  });

  it('names unresolved actor ids and combines with scene refs', () => {
    const msg = summarizeUnresolved([], ['actor1', 'actor2']);
    expect(msg).toContain('2 unresolved actor id(s)');
    expect(msg).toContain('actor1');
    expect(msg).toContain('actor2');
  });

  it('never claims success is false-worthy silently: a non-empty input always yields a message', () => {
    const msg = summarizeUnresolved(
      [{ scene_id: 's', region_id: null, behavior_id: null, target: 'Scene.qqqqqqqqqqqqqqqq' }],
      ['a']
    );
    expect(msg).toBeTruthy();
  });
});

// board #1311 bridge fix 0007: adventure-import crashed on every call because it read/wrote
// flags.aidm through the getFlag/setFlag flag-accessor methods, and Foundry's Document flag
// accessors throw for any scope that is not the id of an active package ("aidm" is this lane's
// own flag namespace, not a package). readAidmFlag/isAdoptedFrom/aidmTagUpdatePayload replace
// every accessor call with a plain property read and an update() payload builder -- these never
// touch a live Document, so they are testable with a plain object standing in for one.
describe('readAidmFlag', () => {
  it('reads a key out of flags.aidm', () => {
    const doc = {
      flags: { aidm: { sourcePack: 'Adventure.deathhouse', sourceSceneId: 'abc123' } },
    };
    expect(readAidmFlag(doc, 'sourcePack')).toBe('Adventure.deathhouse');
    expect(readAidmFlag(doc, 'sourceSceneId')).toBe('abc123');
  });

  it('returns undefined when the document has no flags, no aidm namespace, or no such key', () => {
    expect(readAidmFlag({}, 'sourcePack')).toBeUndefined();
    expect(readAidmFlag({ flags: {} }, 'sourcePack')).toBeUndefined();
    expect(readAidmFlag({ flags: { aidm: {} } }, 'sourcePack')).toBeUndefined();
    expect(readAidmFlag(null, 'sourcePack')).toBeUndefined();
    expect(readAidmFlag(undefined, 'sourcePack')).toBeUndefined();
  });

  it('never throws for a document shape a real Foundry Document.getFlag would reject', () => {
    // A plain object is not a Foundry Document at all (no constructor.database), which is
    // exactly the case that proves this never delegates to the throwing accessor.
    expect(() => readAidmFlag({ flags: { aidm: { x: 1 } } }, 'x')).not.toThrow();
  });
});

describe('isAdoptedFrom', () => {
  const tagged = {
    flags: {
      aidm: {
        sourcePack: 'Adventure.deathhouse',
        sourceSceneId: 'srcScene1',
        adoptedFor: 'srcScene1',
      },
    },
  };

  it('true only when both sourcePack and sourceSceneId match exactly', () => {
    expect(isAdoptedFrom(tagged, 'Adventure.deathhouse', 'srcScene1')).toBe(true);
  });

  it('false when the pack differs', () => {
    expect(isAdoptedFrom(tagged, 'Adventure.other', 'srcScene1')).toBe(false);
  });

  it('false when the source scene id differs', () => {
    expect(isAdoptedFrom(tagged, 'Adventure.deathhouse', 'srcScene2')).toBe(false);
  });

  it('false for an untagged document', () => {
    expect(isAdoptedFrom({}, 'Adventure.deathhouse', 'srcScene1')).toBe(false);
    expect(isAdoptedFrom({ flags: {} }, 'Adventure.deathhouse', 'srcScene1')).toBe(false);
  });
});

describe('aidmTagUpdatePayload', () => {
  it('builds a dotted-path payload for document.update(), one key per tag', () => {
    const payload = aidmTagUpdatePayload({
      sourcePack: 'Adventure.deathhouse',
      sourceSceneId: 'srcScene1',
      adoptedFor: 'targetScene1',
    });
    expect(payload).toEqual({
      'flags.aidm.sourcePack': 'Adventure.deathhouse',
      'flags.aidm.sourceSceneId': 'srcScene1',
      'flags.aidm.adoptedFor': 'targetScene1',
    });
  });

  it('the payload round-trips through readAidmFlag once merged into a flags object', () => {
    // Simulates what Foundry's own dotted-path flattening inside update() does: merge each
    // "flags.aidm.<key>" entry into the document's flags.aidm object.
    const payload = aidmTagUpdatePayload({
      sourcePack: 'Adventure.lmop',
      sourceSceneId: 'srcScene9',
      adoptedFor: 'srcScene9',
    });
    const doc: any = { flags: {} };
    for (const [dottedKey, value] of Object.entries(payload)) {
      const [, , key] = dottedKey.split('.');
      doc.flags.aidm = { ...(doc.flags.aidm || {}), [key as string]: value };
    }
    expect(readAidmFlag(doc, 'sourcePack')).toBe('Adventure.lmop');
    expect(isAdoptedFrom(doc, 'Adventure.lmop', 'srcScene9')).toBe(true);
  });
});
