/**
 * Board #1714: pure tests for the scene-only, never-overwrite import planning in
 * adventure-import-utils.ts. The handler-level proof against Foundry 13.351's real
 * prepareImport/importContent code is in adventure-import-handler.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  sceneOnlyImportOptions,
  nonSceneDocumentNames,
  findAdoptedScenes,
  planAdventureSceneImport,
  summarizeSceneConflicts,
  collectionHasId,
  createSerialLock,
} from './adventure-import-utils.js';

const PACK = 'curse-of-strahd-by-claygolem.Curse-of-Strahd';

function tagged(id: string, name: string, sourceSceneId: string, pack = PACK) {
  return {
    id,
    name,
    flags: { aidm: { sourcePack: pack, sourceSceneId, adoptedFor: sourceSceneId } },
  };
}

function worldOf(scenes: any[]) {
  const byId = new Map(scenes.map(s => [s.id, s]));
  return { getWorldScene: (id: string) => byId.get(id), worldScenes: scenes };
}

describe('sceneOnlyImportOptions', () => {
  it('uses the importFields option Foundry 13.351 reads, listing only the scenes field', () => {
    expect(sceneOnlyImportOptions()).toEqual({ importFields: ['scenes'] });
  });

  it('never passes the documentTypes key Foundry ignores', () => {
    expect(Object.keys(sceneOnlyImportOptions())).not.toContain('documentTypes');
  });

  it('returns a fresh object each time, so a caller cannot change it for the next call', () => {
    const a = sceneOnlyImportOptions();
    a.importFields.push('actors');
    expect(sceneOnlyImportOptions()).toEqual({ importFields: ['scenes'] });
  });
});

describe('nonSceneDocumentNames', () => {
  it('is empty for scene-only prepared data', () => {
    expect(nonSceneDocumentNames({ toCreate: { Scene: [{ _id: 'a' }] }, toUpdate: {} })).toEqual(
      []
    );
  });

  it('names every other document type found in toCreate or toUpdate', () => {
    const names = nonSceneDocumentNames({
      toCreate: { Scene: [{ _id: 'a' }], Actor: [{ _id: 'b' }] },
      toUpdate: { Folder: [{ _id: 'c' }], JournalEntry: [] },
    });
    expect(names.sort()).toEqual(['Actor', 'Folder']);
  });

  it('copes with missing parts', () => {
    expect(nonSceneDocumentNames(undefined)).toEqual([]);
    expect(nonSceneDocumentNames({})).toEqual([]);
  });
});

describe('findAdoptedScenes', () => {
  it('returns every world scene tagged for this exact pack and source scene', () => {
    const a = tagged('a', 'A', 'src1');
    const b = tagged('b', 'B', 'src1');
    const c = tagged('c', 'C', 'src2');
    const d = tagged('d', 'D', 'src1', 'other.pack');
    expect(findAdoptedScenes([a, b, c, d], PACK, 'src1').map(s => s.id)).toEqual(['a', 'b']);
  });
});

describe('planAdventureSceneImport', () => {
  const deathHouse = { _id: 'FBot4IT6IOGsSq8A', name: '1-Death House', folder: 'packFolder000001' };
  const basement = { _id: 'GiLH3LdScrBhrkke', name: '2-Death House Dungeons', folder: null };

  it('creates every scene the world does not have, with the source tags stamped in', () => {
    const plan = planAdventureSceneImport({
      packCollection: PACK,
      targetSceneId: deathHouse._id,
      preparedScenes: [deathHouse, basement],
      ...worldOf([]),
      folderExists: () => false,
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.reuse).toEqual([]);
    expect(plan.create.map(s => s._id)).toEqual([deathHouse._id, basement._id]);
    for (const s of plan.create) {
      expect(s.flags.aidm).toEqual({
        sourcePack: PACK,
        sourceSceneId: s._id,
        adoptedFor: deathHouse._id,
      });
    }
  });

  it('keeps flags the package scene already had and does not change the input data', () => {
    const src = { _id: 'x1', name: 'X', flags: { other: { k: 1 }, aidm: { note: 'n' } } };
    const plan = planAdventureSceneImport({
      packCollection: PACK,
      targetSceneId: 'x1',
      preparedScenes: [src],
      ...worldOf([]),
      folderExists: () => true,
    });
    expect(plan.create[0].flags.other).toEqual({ k: 1 });
    expect(plan.create[0].flags.aidm.note).toBe('n');
    expect(src.flags.aidm).toEqual({ note: 'n' });
  });

  it('clears a folder id the world does not have, and keeps one it does', () => {
    const plan = planAdventureSceneImport({
      packCollection: PACK,
      targetSceneId: deathHouse._id,
      preparedScenes: [deathHouse, { _id: 'y1', name: 'Y', folder: 'worldFolder00001' }],
      ...worldOf([]),
      folderExists: id => id === 'worldFolder00001',
    });
    expect(plan.create[0].folder).toBeNull();
    expect(plan.create[1].folder).toBe('worldFolder00001');
  });

  it('REFUSES when an untagged world scene already has the id (the live Death House case)', () => {
    const liveDeathHouse = {
      id: 'FBot4IT6IOGsSq8A',
      name: 'Curse of Strahd: Death House',
      flags: { aidm: { pipeline: { kind: 'adopted' } } },
    };
    const plan = planAdventureSceneImport({
      packCollection: PACK,
      targetSceneId: deathHouse._id,
      preparedScenes: [deathHouse, basement],
      ...worldOf([liveDeathHouse]),
      folderExists: () => false,
    });
    expect(plan.conflicts).toEqual([
      {
        scene_id: 'FBot4IT6IOGsSq8A',
        scene_name: 'Curse of Strahd: Death House',
        reason: 'id-taken-untagged',
        tagged_source: null,
        world_scene_ids: ['FBot4IT6IOGsSq8A'],
      },
    ]);
  });

  it('REFUSES when the same-id world scene is tagged as coming from somewhere else', () => {
    const other = tagged('FBot4IT6IOGsSq8A', 'Imported elsewhere', 'zzz', 'other.pack');
    const plan = planAdventureSceneImport({
      packCollection: PACK,
      targetSceneId: deathHouse._id,
      preparedScenes: [deathHouse],
      ...worldOf([other]),
      folderExists: () => false,
    });
    expect(plan.conflicts[0]!.reason).toBe('id-taken-other-source');
    expect(plan.conflicts[0]!.tagged_source).toEqual({
      sourcePack: 'other.pack',
      sourceSceneId: 'zzz',
    });
  });

  it('reuses a same-id world scene that carries matching tags, and never plans to change it', () => {
    const adopted = tagged(
      'GiLH3LdScrBhrkke',
      'Curse of Strahd: Death House Basement',
      'GiLH3LdScrBhrkke'
    );
    const plan = planAdventureSceneImport({
      packCollection: PACK,
      targetSceneId: deathHouse._id,
      preparedScenes: [deathHouse, basement],
      ...worldOf([adopted]),
      folderExists: () => false,
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.reuse).toEqual([
      { source_scene_id: 'GiLH3LdScrBhrkke', world_scene_id: 'GiLH3LdScrBhrkke' },
    ]);
    expect(plan.create.map(s => s._id)).toEqual([deathHouse._id]);
  });

  it('reuses a tagged copy that lives under a different id instead of creating a duplicate', () => {
    const copy = tagged('copyId0000000001', 'Basement copy', 'GiLH3LdScrBhrkke');
    const plan = planAdventureSceneImport({
      packCollection: PACK,
      targetSceneId: deathHouse._id,
      preparedScenes: [deathHouse, basement],
      ...worldOf([copy]),
      folderExists: () => false,
    });
    expect(plan.reuse).toEqual([
      { source_scene_id: 'GiLH3LdScrBhrkke', world_scene_id: 'copyId0000000001' },
    ]);
    expect(plan.create.map(s => s._id)).toEqual([deathHouse._id]);
  });

  it('refuses when two world scenes are both tagged as the same source (ambiguous)', () => {
    const plan = planAdventureSceneImport({
      packCollection: PACK,
      targetSceneId: deathHouse._id,
      preparedScenes: [deathHouse, basement],
      ...worldOf([tagged('c1', 'Copy 1', basement._id), tagged('c2', 'Copy 2', basement._id)]),
      folderExists: () => false,
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.reason).toBe('ambiguous-adopted-copies');
    expect(plan.conflicts[0]!.world_scene_ids).toEqual(['c1', 'c2']);
  });

  it('has no way to express an update: the plan only has create, reuse and conflicts', () => {
    const plan = planAdventureSceneImport({
      packCollection: PACK,
      targetSceneId: deathHouse._id,
      preparedScenes: [deathHouse],
      ...worldOf([]),
      folderExists: () => false,
    });
    expect(Object.keys(plan).sort()).toEqual(['conflicts', 'create', 'reuse']);
  });

  it('ignores a duplicate prepared entry for the same id', () => {
    const plan = planAdventureSceneImport({
      packCollection: PACK,
      targetSceneId: deathHouse._id,
      preparedScenes: [deathHouse, { ...deathHouse }],
      ...worldOf([]),
      folderExists: () => false,
    });
    expect(plan.create).toHaveLength(1);
  });
});

describe('summarizeSceneConflicts', () => {
  it('names each scene in plain words and says nothing was changed', () => {
    const msg = summarizeSceneConflicts([
      {
        scene_id: 'FBot4IT6IOGsSq8A',
        scene_name: 'Curse of Strahd: Death House',
        reason: 'id-taken-untagged',
        tagged_source: null,
        world_scene_ids: ['FBot4IT6IOGsSq8A'],
      },
    ]);
    expect(msg).toContain('"Curse of Strahd: Death House" (FBot4IT6IOGsSq8A)');
    expect(msg).toContain('Nothing was imported or changed');
    expect(msg).toContain('adventure-source-backfill');
  });
});

describe('collectionHasId (board #1714 review)', () => {
  const collection = {
    docs: new Map([['valid00000000001', { id: 'valid00000000001' }]]),
    invalidDocumentIds: new Set(['broken0000000001']),
    get(id: string) {
      return this.docs.get(id);
    },
  };

  it('counts a normal document and an invalid stored document as taken', () => {
    expect(collectionHasId(collection, 'valid00000000001')).toBe(true);
    expect(collectionHasId(collection, 'broken0000000001')).toBe(true);
    expect(collectionHasId(collection, 'free000000000001')).toBe(false);
  });

  it('copes with a collection that has no invalidDocumentIds, or no collection', () => {
    expect(collectionHasId({ get: () => undefined }, 'x')).toBe(false);
    expect(collectionHasId(undefined, 'x')).toBe(false);
  });
});

describe('createSerialLock (board #1714 review)', () => {
  it('runs jobs one at a time, in call order, even when an earlier job is slower', async () => {
    const lock = createSerialLock();
    const events: string[] = [];
    const slow = lock(async () => {
      events.push('slow-start');
      await new Promise(r => setTimeout(r, 30));
      events.push('slow-end');
      return 1;
    });
    const fast = lock(async () => {
      events.push('fast-start');
      events.push('fast-end');
      return 2;
    });
    expect(await Promise.all([slow, fast])).toEqual([1, 2]);
    expect(events).toEqual(['slow-start', 'slow-end', 'fast-start', 'fast-end']);
  });

  it('a job that throws passes its error to its own caller and does not block the next job', async () => {
    const lock = createSerialLock();
    const bad = lock(async () => {
      throw new Error('boom');
    });
    const good = lock(async () => 'ok');
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe('ok');
  });
});

describe('planAdventureSceneImport with invalid stored scenes (board #1714 review)', () => {
  it('refuses an id that belongs to a stored scene that failed validation', () => {
    const plan = planAdventureSceneImport({
      packCollection: PACK,
      targetSceneId: 'FBot4IT6IOGsSq8A',
      preparedScenes: [{ _id: 'FBot4IT6IOGsSq8A', name: '1-Death House' }],
      ...worldOf([]),
      folderExists: () => false,
      isInvalidId: id => id === 'FBot4IT6IOGsSq8A',
    });
    expect(plan.create).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        scene_id: 'FBot4IT6IOGsSq8A',
        scene_name: '1-Death House',
        reason: 'id-taken-invalid',
        tagged_source: null,
        world_scene_ids: ['FBot4IT6IOGsSq8A'],
      },
    ]);
    expect(summarizeSceneConflicts(plan.conflicts)).toContain("failed Foundry's data checks");
  });

  it('NEGATIVE CONTROL: without isInvalidId the same scene is planned for creation', () => {
    const plan = planAdventureSceneImport({
      packCollection: PACK,
      targetSceneId: 'FBot4IT6IOGsSq8A',
      preparedScenes: [{ _id: 'FBot4IT6IOGsSq8A', name: '1-Death House' }],
      ...worldOf([]),
      folderExists: () => false,
    });
    expect(plan.create.map(s => s._id)).toEqual(['FBot4IT6IOGsSq8A']);
  });
});
