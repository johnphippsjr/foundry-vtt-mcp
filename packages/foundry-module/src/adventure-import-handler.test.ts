/**
 * Board #1714: handler-level tests for adventure-import and adventure-source-backfill.
 *
 * These run the REAL QueryHandlers methods from queries.ts against a small in-memory Foundry
 * stand-in. The important part is the Adventure class below: its prepareImport and importContent
 * bodies are copied word for word from the live Foundry 13.351 client
 * (/home/node/resources/app/public/scripts/foundry.mjs lines 41964-41995 and 42000-42033, read
 * from the dnd-dm foundry pod on 2026-09-16), and Array.prototype.partition is copied from line
 * 1995 of the same file. So these tests exercise Foundry's own import decision code, not a guess
 * at it.
 *
 * What this proves: (1) the old {documentTypes:['Scene']} option makes Foundry's real code prepare
 * every document type and plan a full replacement of same-id world documents; (2) the new handler
 * passes an option that code honours, refuses before any write when a scene would be overwritten,
 * creates only tagged scenes otherwise, never calls updateDocuments, and still rolls back only what
 * it created; (3) the back-fill tool writes nothing on a dry run and only flags.aidm keys on apply.
 * What this does NOT prove: that the live Foundry server accepts these writes, that the socket
 * round trip fits inside the 60s bridge query timeout, or how a real canvas reacts. Those need the
 * live verification steps in the report.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./data-access.js', () => ({ FoundryDataAccess: class {} }));
vi.mock('./comfyui-manager.js', () => ({ ComfyUIManager: class {} }));

import { QueryHandlers } from './queries.js';

// ---------------------------------------------------------------------------------------------
// Foundry 13.351 helper, copied from foundry.mjs line 1995 (installed as Array#partition there).
function partition(this: any[], rule: (v: any) => boolean) {
  return this.reduce(
    (acc: any[][], val: any) => {
      const test = rule(val);
      acc[Number(test)]!.push(val);
      return acc;
    },
    [[], []]
  );
}
if (!(Array.prototype as any).partition) {
  Object.defineProperty(Array.prototype, 'partition', { value: partition, configurable: true });
}

// ---------------------------------------------------------------------------------------------
// In-memory world.

type Call = {
  op: string;
  documentName: string;
  ids: string[];
  options?: any;
  changes?: any;
  replaced?: string[];
};
let calls: Call[] = [];

// A client-side world collection. Like Foundry's DocumentCollection it only holds documents whose
// data loaded cleanly; a stored document that failed validation is left out and only its id is
// kept in `invalidDocumentIds` (foundry.mjs lines 23909-23925), and get() returns it only with
// {invalid: true} (line 24014). `stored` stands in for the server database: every record, valid
// or not.
class FakeCollection extends Map<string, any> {
  stored = new Map<string, any>();
  invalidDocumentIds: Set<string> | undefined = new Set<string>();
  get contents() {
    return [...this.values()];
  }
  override get(id: string, opts: { invalid?: boolean } = {}): any {
    const doc = super.get(id);
    if (doc || !opts.invalid || !this.invalidDocumentIds?.has(id)) return doc;
    return { id, invalid: true, _source: this.stored.get(id) };
  }
  override [Symbol.iterator](): any {
    return this.values();
  }
}

function setPath(obj: any, path: string, value: any) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]!] = value;
}

let idCounter = 0;
function newId() {
  idCounter += 1;
  return `gen${String(idCounter).padStart(13, '0')}`;
}

function makeDoc(documentName: string, source: any, collection: FakeCollection) {
  const doc: any = {
    documentName,
    _source: structuredClone(source),
    get id() {
      return this._source._id;
    },
    get name() {
      return this._source.name;
    },
    get flags() {
      return this._source.flags ?? {};
    },
    get folder() {
      return this._source.folder ?? null;
    },
    get active() {
      return !!this._source.active;
    },
    get background() {
      return this._source.background ?? { src: null };
    },
    get _stats() {
      return this._source._stats ?? {};
    },
    get tokens() {
      const list = this._source.tokens ?? [];
      return Object.assign([...list], { size: list.length });
    },
    get regions() {
      return (this._source.regions ?? []).map((r: any) => ({
        id: r._id,
        behaviors: (r.behaviors ?? []).map((b: any) => ({
          id: b._id,
          toObject: () => structuredClone(b),
        })),
      }));
    },
    get actors() {
      return this._source.actors ?? [];
    },
    toObject() {
      return structuredClone(this._source);
    },
    async update(changes: any) {
      calls.push({
        op: 'doc.update',
        documentName,
        ids: [this.id],
        changes: structuredClone(changes),
      });
      for (const [k, v] of Object.entries(changes)) setPath(this._source, k, v);
      collection.stored.set(this.id, this._source);
      return this;
    },
  };
  return doc;
}

// Document class whose create/update/delete model the Foundry 13.351 SERVER for top-level
// documents. The key behaviour (dist/database/backend/server-backend.mjs _createDocuments): with
// keepId, an id that is already stored is NOT rejected; the stored record is silently replaced.
// That only rejects duplicate ids for embedded documents. So these fakes never throw on a duplicate
// id; they record it under `replaced`, and tests assert that list stays empty. A test cannot pass
// on a refusal the real server would never give.
// `failAfterSave` makes the next create calls fail AFTER saving, the two ways 13.351 can:
//  - 'client': the server saved and broadcast, the client added the document to its collection,
//    then something in the client's own _onCreate threw (foundry.mjs lines 58658-58668);
//  - 'server-only': the server saved, then its own _onCreate threw, so the client got an error and
//    no broadcast; the document is stored but not in this client's collection.
// The real client does not clear invalidDocumentIds on create or delete, so neither do these fakes.
function makeDocClass(documentName: string, collection: FakeCollection) {
  const Cls: any = class {
    static documentName = documentName;
    static failAfterSave: null | 'client' | 'server-only' = null;
    static database = {
      // A read-only database get, as used after a failed create to look for a saved record.
      async get(_cls: any, operation: any) {
        const id = operation?.query?._id;
        return collection.stored.has(id) ? [structuredClone(collection.stored.get(id))] : [];
      },
    };
    static async createDocuments(data: any[], options: any = {}) {
      const replaced: string[] = [];
      const mode = Cls.failAfterSave;
      const docs = data.map(d => {
        const id = options.keepId && d._id ? d._id : newId();
        if (collection.stored.has(id)) replaced.push(id);
        const doc = makeDoc(documentName, { ...structuredClone(d), _id: id }, collection);
        collection.stored.set(id, doc._source);
        if (mode !== 'server-only') collection.set(id, doc);
        return doc;
      });
      calls.push({ op: 'create', documentName, ids: data.map(d => d._id), options, replaced });
      if (mode) throw new Error(`${documentName} create failed after save (${mode})`);
      return docs;
    }
    static async updateDocuments(updates: any[], options: any = {}) {
      calls.push({ op: 'update', documentName, ids: updates.map(u => u._id), options });
      return updates.map(u => {
        const doc = makeDoc(documentName, structuredClone(u), collection);
        collection.stored.set(u._id, doc._source);
        collection.set(u._id, doc);
        return doc;
      });
    }
    static async deleteDocuments(ids: string[]) {
      calls.push({ op: 'delete', documentName, ids: [...ids] });
      for (const id of ids) {
        // Like the client's pre-delete step: collection.get(id, {strict: true, invalid: true}).
        if (!collection.has(id) && !collection.invalidDocumentIds?.has(id)) {
          throw new Error(`${documentName} id [${id}] does not exist in the collection`);
        }
      }
      for (const id of ids) {
        collection.delete(id);
        collection.stored.delete(id);
      }
      return ids;
    }
    static async create(data: any, options: any = {}) {
      return (await Cls.createDocuments([data], options))[0];
    }
  };
  Cls.implementation = Cls;
  return Cls;
}

const DOC_FIELDS: [string, string][] = [
  ['actors', 'Actor'],
  ['combats', 'Combat'],
  ['items', 'Item'],
  ['journal', 'JournalEntry'],
  ['scenes', 'Scene'],
  ['tables', 'RollTable'],
  ['macros', 'Macro'],
  ['cards', 'Cards'],
  ['playlists', 'Playlist'],
  ['folders', 'Folder'],
];

let collections: Map<string, FakeCollection>;
let classes: Record<string, any>;
let CONTENT_FIELDS: Record<string, any>;

// ---------------------------------------------------------------------------------------------
// Test Adventure class: prepareImport and importContent are VERBATIM Foundry 13.351 code.

declare const game: any;
declare const ui: any;
declare const CONFIG: any;
function getDocumentClass$1(documentName: string) {
  return CONFIG[documentName]?.documentClass;
}

class Adventure {
  static get contentFields() {
    return CONTENT_FIELDS;
  }
  _source: any;
  constructor(source: any) {
    this._source = source;
  }
  get id() {
    return this._source._id;
  }
  get name() {
    return this._source.name;
  }
  get actors() {
    return this._source.actors;
  }
  toObject() {
    return structuredClone(this._source);
  }

  // ---- BEGIN verbatim foundry.mjs 41964-41995 (Foundry 13.351). Only TypeScript "any" type
  // annotations were added; prettier is told to leave the original formatting alone. ----
  // prettier-ignore
  async prepareImport(options: any) {
    const importFields = new Set(options.importFields);
    const adventureData: any = this.toObject();
    const toCreate: any = {};
    const toUpdate: any = {};
    let documentCount = 0;
    const importAll = !importFields.size || importFields.has("all");
    const keep = new Set();
    for ( const [field, cls] of Object.entries(Adventure.contentFields) as any ) {
      if ( !importAll && !importFields.has(field) ) continue;
      keep.add(cls.documentName);
      const collection = game.collections.get(cls.documentName);
      let [c, u] = adventureData[field].partition((d: any) => collection.has(d._id));
      if ( (field === "folders") && !importAll ) {
        c = c.filter((f: any) => keep.has(f.type));
        u = u.filter((f: any) => keep.has(f.type));
      }
      if ( c.length ) {
        toCreate[cls.documentName] = c;
        documentCount += c.length;
      }
      if ( u.length ) {
        toUpdate[cls.documentName] = u;
        documentCount += u.length;
      }
    }
    return {toCreate, toUpdate, documentCount};
  }
  // ---- END verbatim ----

  // ---- BEGIN verbatim foundry.mjs 42000-42033 (Foundry 13.351). Only TypeScript "any" type
  // annotations were added; prettier is told to leave the original formatting alone. ----
  // prettier-ignore
  async importContent({toCreate, toUpdate, documentCount}: any={}) {
    const created: any = {};
    const updated: any = {};
    const bar = ui.notifications.info("ADVENTURE.ImportProgress", {localize: true, progress: true});

    // Create new documents
    let nImported = 0;
    for ( const [documentName, createData] of Object.entries(toCreate) as any ) {
      const cls = getDocumentClass$1(documentName);
      const docs = await cls.createDocuments(createData, {
        keepId: true,       // Keep adventure document IDs
        render: false,      // Do not re-render related applications
        renderSheet: false  // Do not render new sheets
      });
      created[documentName] = docs;
      nImported += docs.length;
      bar.update({pct: nImported / documentCount});
    }

    // Update existing documents
    for ( const [documentName, updateData] of Object.entries(toUpdate) as any ) {
      const cls = getDocumentClass$1(documentName);
      const docs = await cls.updateDocuments(updateData, {
        diff: false,
        recursive: false,
        noHook: true,
        render: false      // Do not re-render related applications
      });
      updated[documentName] = docs;
      nImported += docs.length;
      bar.update({pct: nImported / documentCount});
    }
    bar.update({pct: 1});
    return {created, updated};
  }
  // ---- END verbatim ----
}

// ---------------------------------------------------------------------------------------------
// Live-shaped data (ids, names and backgrounds read from the live world and pack on 2026-09-16).

const PACK = 'curse-of-strahd-by-claygolem.Curse-of-Strahd';
const BG = 'modules/curse-of-strahd-by-claygolem/Packs/Scenes/';
const ARC_A = 'EcvHvhJXmGoRIksY';
const ARC_B = '4Fst9kuGnkQsNlei';
const CORE = 'AGKuGxDZkMMPbjWh';
const DH = 'FBot4IT6IOGsSq8A';
const BASEMENT = 'GiLH3LdScrBhrkke';
const VILLAGE = 'bICKY970prlBT27M';
const BAROVIA = 'p3ENtVj3gnmL424f';
const ARMOR = 'xJBCo7niFNDAZHZq'; // Animated Armor: a pack actor id the live world also has
const ROSE = 'wUKAMlKhyZxUw5uu'; // Rose Durst

function emptyAdventure(id: string, name: string) {
  const a: any = { _id: id, name };
  for (const [field] of DOC_FIELDS) a[field] = [];
  return a;
}

function packDeathHouseScene(extra: any = {}) {
  return {
    _id: DH,
    name: '1-Death House',
    folder: 'VT3H5i8UDBlVH5nr',
    background: { src: `${BG}1-DeathHouse.webp` },
    tokens: [{ _id: 'tokRose000000001', actorId: ROSE }],
    regions: [
      {
        _id: 'regStairs0000001',
        behaviors: [
          {
            _id: 'behStairs0000001',
            type: 'teleportToken',
            system: { destination: `Scene.${BASEMENT}.Region.regLanding000001` },
          },
        ],
      },
    ],
    flags: {},
    ...extra,
  };
}

function packBasementScene() {
  return {
    _id: BASEMENT,
    name: '2-Death House Dungeons',
    folder: 'VT3H5i8UDBlVH5nr',
    background: { src: `${BG}1-DeathHouseDungeons.webp` },
    tokens: [{ _id: 'tokArmor00000001', actorId: ARMOR }],
    regions: [],
    flags: {},
  };
}

function buildPack(opts: { deathHouseExtra?: any } = {}) {
  const arcA = emptyAdventure(ARC_A, 'Arc A - Death House');
  arcA.scenes = [packDeathHouseScene(opts.deathHouseExtra), packBasementScene()];
  arcA.folders = [
    { _id: 'VT3H5i8UDBlVH5nr', name: 'Arc A - Death House', type: 'Scene' },
    { _id: 'LHx5QXPNS5yn7IME', name: 'Act 1 - Into the Mists', type: 'Scene' },
  ];
  const arcB = emptyAdventure(ARC_B, 'Arc B - Barovia');
  arcB.scenes = [
    {
      _id: VILLAGE,
      name: 'B5b - Town Square',
      background: { src: `${BG}1-BaroviaStreets.webp` },
      tokens: [],
      regions: [],
      flags: {},
    },
    {
      _id: BAROVIA,
      name: 'B5 - Barovia Village Map',
      background: { src: `${BG}1-MapOfBarovia.webp` },
      tokens: [],
      regions: [],
      flags: {},
    },
  ];
  const core = emptyAdventure(CORE, 'Core Resources & Intro');
  core.actors = [
    { _id: ARMOR, name: 'Animated Armor', type: 'npc', folder: 'coreActorsFolder' },
    { _id: ROSE, name: 'Rose Durst', type: 'npc', folder: 'coreActorsFolder' },
  ];
  core.items = [{ _id: 'item000000000001', name: 'Tarokka Deck', type: 'loot' }];
  core.journal = [{ _id: 'journal000000001', name: 'Intro' }];
  core.folders = [{ _id: 'coreActorsFolder', name: 'Actors', type: 'Actor' }];
  core.scenes = [];
  const advs = [arcA, arcB, core].map(a => new Adventure(a));
  return {
    collection: PACK,
    metadata: { type: 'Adventure', packageName: 'curse-of-strahd-by-claygolem', system: 'dnd5e' },
    async getDocument(id: string) {
      return advs.find(a => a.id === id) ?? null;
    },
    async getIndex() {
      return advs.map(a => ({ _id: a.id, name: a.name }));
    },
    async getDocuments() {
      return advs;
    },
  };
}

function liveWorldScene(id: string, name: string, bg: string, extra: any = {}) {
  return {
    _id: id,
    name,
    background: { src: bg },
    tokens: [],
    regions: [],
    flags: { aidm: { pipeline: { kind: 'adopted' }, wall_count: 42 } },
    ...extra,
  };
}

// A standalone Scene compendium pack, for the 3-part ref (single-scene) path.
const SCENE_PACK = 'aidm-synthetic-core.scenes';
const LONE = 'loneScene0000001';
function buildScenePack() {
  const src = {
    _id: LONE,
    name: 'Lone Tower',
    folder: 'packFolder000009',
    background: { src: 'modules/aidm-synthetic-core/tower.webp' },
    tokens: [],
    regions: [],
    flags: {},
  };
  return {
    collection: SCENE_PACK,
    metadata: { type: 'Scene', packageName: 'aidm-synthetic-core' },
    async getDocument(id: string) {
      return id === LONE ? { name: src.name, toObject: () => structuredClone(src) } : null;
    },
    async getIndex() {
      return [{ _id: LONE, name: src.name }];
    },
  };
}

function installWorld(
  opts: {
    scenes?: any[];
    actors?: any[];
    invalidScenes?: any[];
    invalidActors?: any[];
    pack?: any;
  } = {}
) {
  calls = [];
  collections = new Map(DOC_FIELDS.map(([, name]) => [name, new FakeCollection()]));
  classes = {};
  CONTENT_FIELDS = {};
  for (const [field, name] of DOC_FIELDS) {
    classes[name] = makeDocClass(name, collections.get(name)!);
    CONTENT_FIELDS[field] = classes[name];
  }
  const load = (name: string, valid: any[] = [], invalid: any[] = []) => {
    const c = collections.get(name)!;
    for (const d of valid) {
      const doc = makeDoc(name, d, c);
      c.stored.set(d._id, doc._source);
      c.set(d._id, doc);
    }
    for (const d of invalid) {
      c.stored.set(d._id, structuredClone(d));
      c.invalidDocumentIds!.add(d._id);
    }
  };
  load('Scene', opts.scenes, opts.invalidScenes);
  load('Actor', opts.actors, opts.invalidActors);
  const pack = opts.pack ?? buildPack();
  const scenePack = buildScenePack();
  const g: any = globalThis;
  g.CONFIG = Object.fromEntries(
    DOC_FIELDS.map(([, name]) => [name, { documentClass: classes[name] }])
  );
  g.CONFIG.queries = {};
  g.ui = { notifications: { info: () => ({ update: () => {} }) } };
  g.game = {
    user: { isGM: true },
    scenes: collections.get('Scene'),
    actors: collections.get('Actor'),
    folders: collections.get('Folder'),
    collections,
    packs: new Map<string, any>([
      [pack.collection, pack],
      [scenePack.collection, scenePack],
    ]),
    modules: new Map([['curse-of-strahd-by-claygolem', { relationships: { requires: [] } }]]),
  };
  g.Scene = classes.Scene;
  g.Actor = classes.Actor;
  g.foundry = { utils: { randomID: () => newId() } };
  g.fromUuidSync = (uuid: string) => {
    const m = /^Scene\.([A-Za-z0-9]{16})/.exec(uuid);
    return m ? (collections.get('Scene')!.get(m[1]!) ?? null) : null;
  };
  return pack;
}

function writes() {
  return calls;
}

function replacedIds() {
  return calls.flatMap(c => c.replaced ?? []);
}

function snapshotScenes() {
  return JSON.stringify([...collections.get('Scene')!.stored.entries()]);
}

// A promise the test resolves by hand, to hold one call in the middle of its work.
function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => {
    open = resolve;
  });
  return { promise, open };
}

const handlers = () => new QueryHandlers() as any;
const DH_REF = `${PACK}.${ARC_A}.${DH}`;

const LIVE_SCENES = () => [
  liveWorldScene(DH, 'Curse of Strahd: Death House', `${BG}1-DeathHouse.webp`, {
    active: true,
    tokens: [{ actorId: 'pc1' }, { actorId: 'pc2' }, { actorId: 'pc3' }, { actorId: 'pc4' }],
    _stats: { duplicateSource: 'Scene.x0mQOJ1MS1s2EuKv' },
  }),
  liveWorldScene(
    BASEMENT,
    'Curse of Strahd: Death House Basement',
    `${BG}1-DeathHouseDungeons.webp`
  ),
  liveWorldScene(VILLAGE, 'Curse of Strahd: Village of Barovia', `${BG}1-BaroviaStreets.webp`),
  liveWorldScene(BAROVIA, 'Curse of Strahd: Barovia', `${BG}1-MapOfBarovia.webp`),
  liveWorldScene(
    '8dX8d0iZWCndDYP9',
    'Curse of Strahd: Blue Water Inn',
    'worlds/dnd-dm-maps/curse-of-strahd/p100.jpg'
  ),
];

beforeEach(() => {
  idCounter = 0;
});

// ---------------------------------------------------------------------------------------------

describe("Foundry 13.351's own prepareImport/importContent (the hazard, reproduced)", () => {
  it('ignores documentTypes: the old call prepares EVERY document type from the Adventure entry', async () => {
    const pack = installWorld({
      scenes: LIVE_SCENES(),
      actors: [{ _id: ARMOR, name: 'Animated Armor (hand-tuned)' }],
    });
    const core = await pack.getDocument(CORE);
    const prepared: any = await core!.prepareImport({ documentTypes: ['Scene'] });
    expect(Object.keys(prepared.toCreate).sort()).toEqual([
      'Actor',
      'Folder',
      'Item',
      'JournalEntry',
    ]);
    expect(prepared.toUpdate.Actor.map((a: any) => a._id)).toEqual([ARMOR]);
  });

  it('plans a full replacement of the live Death House scene, and importContent carries it out', async () => {
    const pack = installWorld({ scenes: LIVE_SCENES() });
    const arcA = await pack.getDocument(ARC_A);
    const prepared: any = await arcA!.prepareImport({ documentTypes: ['Scene'] });
    expect(prepared.toUpdate.Scene.map((s: any) => s._id)).toEqual([DH, BASEMENT]);
    expect(prepared.toCreate.Folder.map((f: any) => f._id)).toEqual([
      'VT3H5i8UDBlVH5nr',
      'LHx5QXPNS5yn7IME',
    ]);
    await arcA!.importContent(prepared);
    const update = calls.find(c => c.op === 'update' && c.documentName === 'Scene')!;
    expect(update.ids).toEqual([DH, BASEMENT]);
    expect(update.options).toMatchObject({ diff: false, recursive: false });
    expect((game.scenes.get(DH) as any).name).toBe('1-Death House'); // the hand-built scene is gone
  });

  it('honours importFields: ["scenes"], preparing Scene documents and nothing else', async () => {
    const pack = installWorld({ scenes: [] });
    for (const advId of [ARC_A, CORE]) {
      const adv = await pack.getDocument(advId);
      const prepared: any = await adv!.prepareImport({ importFields: ['scenes'] });
      const names = [...Object.keys(prepared.toCreate), ...Object.keys(prepared.toUpdate)];
      expect(names.every(n => n === 'Scene')).toBe(true);
    }
  });
});

describe('adventure-import handler (board #1714)', () => {
  it('REFUSES the live case: untagged Death House and Basement already hold the package ids; nothing is written', async () => {
    installWorld({ scenes: LIVE_SCENES() });
    const before = snapshotScenes();
    const res = await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    expect(res.success).toBe(false);
    expect(res.error).toContain('"Curse of Strahd: Death House" (FBot4IT6IOGsSq8A)');
    expect(res.error).toContain('"Curse of Strahd: Death House Basement" (GiLH3LdScrBhrkke)');
    expect(res.error).toContain('Nothing was imported or changed');
    expect(res.conflicts.map((c: any) => [c.scene_id, c.reason])).toEqual([
      [DH, 'id-taken-untagged'],
      [BASEMENT, 'id-taken-untagged'],
    ]);
    expect(res.unresolved).toEqual({ scene_refs: [], actor_ids: [] }); // new-contract shape kept
    expect(writes()).toEqual([]);
    expect(snapshotScenes()).toBe(before);
    expect(collections.get('Folder')!.size).toBe(0);
  });

  it('on a fresh world creates only the two scenes, tagged, with keepId, and never updates anything', async () => {
    installWorld({ scenes: [], actors: [{ _id: ARMOR }, { _id: ROSE }] });
    const res = await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    expect(res.success).toBe(true);
    expect(res.reused).toBe(false);
    expect(res.imported).toEqual({ scenes: [DH, BASEMENT], actors: [] });
    expect(writes().map(c => [c.op, c.documentName])).toEqual([['create', 'Scene']]);
    expect(calls[0]!.options.keepId).toBe(true);
    for (const id of [DH, BASEMENT]) {
      const s: any = game.scenes.get(id);
      expect(s.flags.aidm).toMatchObject({ sourcePack: PACK, sourceSceneId: id, adoptedFor: DH });
      expect(s.folder).toBeNull(); // the pack folder was not imported, so the dangling id is cleared
    }
    expect(collections.get('Folder')!.size).toBe(0);
    expect(collections.get('Item')!.size).toBe(0);
    expect(collections.get('JournalEntry')!.size).toBe(0);
  });

  it('a repeat call reuses the tagged scene and writes nothing', async () => {
    installWorld({ scenes: [], actors: [{ _id: ARMOR }, { _id: ROSE }] });
    await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    calls = [];
    const res = await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    expect(res).toMatchObject({
      success: true,
      reused: true,
      imported: { scenes: [], actors: [] },
    });
    expect(writes()).toEqual([]);
  });

  it('reuses a tagged sibling untouched and creates only the missing scene', async () => {
    const taggedBasement = liveWorldScene(
      BASEMENT,
      'Basement (hand-edited)',
      `${BG}1-DeathHouseDungeons.webp`,
      {
        flags: {
          aidm: { sourcePack: PACK, sourceSceneId: BASEMENT, adoptedFor: BASEMENT, wall_count: 99 },
        },
      }
    );
    installWorld({ scenes: [taggedBasement], actors: [{ _id: ARMOR }, { _id: ROSE }] });
    const basementBefore = JSON.stringify(game.scenes.get(BASEMENT)._source);
    const res = await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    expect(res.success).toBe(true);
    expect(res.imported.scenes).toEqual([DH]);
    expect(writes().map(c => [c.op, c.documentName, c.ids])).toEqual([['create', 'Scene', [DH]]]);
    expect(JSON.stringify(game.scenes.get(BASEMENT)._source)).toBe(basementBefore);
  });

  it('rollback (0008) still deletes only what this call created, never the reused sibling', async () => {
    const taggedBasement = liveWorldScene(BASEMENT, 'Basement', `${BG}1-DeathHouseDungeons.webp`, {
      flags: { aidm: { sourcePack: PACK, sourceSceneId: BASEMENT, adoptedFor: BASEMENT } },
    });
    const dangling = packDeathHouseScene({
      regions: [
        {
          _id: 'regBroken0000001',
          behaviors: [
            { _id: 'behBroken0000001', system: { destination: 'Scene.missingScene0001' } },
          ],
        },
      ],
    });
    const pack = buildPack({ deathHouseExtra: { regions: dangling.regions } });
    installWorld({ scenes: [taggedBasement], actors: [{ _id: ARMOR }, { _id: ROSE }], pack });
    const res = await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    expect(res.success).toBe(false);
    expect(res.unresolved.scene_refs.map((r: any) => r.target)).toEqual(['Scene.missingScene0001']);
    expect(res.cleanup).toEqual({ deleted: [{ type: 'Scene', id: DH }], failed: [] });
    expect(game.scenes.has(DH)).toBe(false);
    expect(game.scenes.has(BASEMENT)).toBe(true);
  });

  it('by default does NOT create missing actors: reports them, adds the hint, rolls the scenes back', async () => {
    installWorld({ scenes: [], actors: [{ _id: ARMOR }] });
    const res = await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    expect(res.success).toBe(false);
    expect(res.unresolved.actor_ids).toEqual([ROSE]);
    expect(res.error).toContain('import_missing_actors');
    expect(res.error).toContain('deleted on purpose'); // board #1714 review 2
    expect(calls.some(c => c.documentName === 'Actor')).toBe(false);
    expect(res.cleanup.deleted.map((d: any) => d.id).sort()).toEqual([DH, BASEMENT].sort());
  });

  it('with import_missing_actors creates only the missing actor and never touches an existing one', async () => {
    installWorld({ scenes: [], actors: [{ _id: ARMOR, name: 'Animated Armor (hand-tuned)' }] });
    const res = await handlers().handleAdventureImport({
      package: PACK,
      scene_ref: DH_REF,
      import_missing_actors: true,
    });
    expect(res.success).toBe(true);
    expect(res.imported.actors).toEqual([ROSE]);
    const actorWrites = calls.filter(c => c.documentName === 'Actor');
    expect(actorWrites.map(c => [c.op, c.ids])).toEqual([['create', [ROSE]]]);
    expect(game.actors.get(ARMOR).name).toBe('Animated Armor (hand-tuned)');
    expect(game.actors.get(ROSE).folder).toBeNull();
    expect(calls.some(c => c.op === 'update')).toBe(false);
  });

  it('if Foundry drops the tags from the create data, it tags only the scenes it just created', async () => {
    installWorld({ scenes: [], actors: [{ _id: ARMOR }, { _id: ROSE }] });
    const realCreate = classes.Scene.createDocuments;
    classes.Scene.createDocuments = async (data: any[], options: any) =>
      realCreate(
        data.map(d => ({ ...d, flags: {} })),
        options
      );
    const res = await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    expect(res.success).toBe(true);
    expect(writes().map(c => [c.op, c.ids])).toEqual([
      ['create', [DH, BASEMENT]],
      ['doc.update', [DH]],
      ['doc.update', [BASEMENT]],
    ]);
    expect(game.scenes.get(BASEMENT).flags.aidm.sourceSceneId).toBe(BASEMENT);
  });

  it('if a step after the create throws, the created scenes are rolled back (0008 all-or-nothing)', async () => {
    installWorld({ scenes: [], actors: [{ _id: ARMOR }, { _id: ROSE }] });
    const realCreate = classes.Scene.createDocuments;
    classes.Scene.createDocuments = async (data: any[], options: any) => {
      const docs = await realCreate(
        data.map(d => ({ ...d, flags: {} })),
        options
      );
      for (const d of docs) {
        d.update = async () => {
          throw new Error('socket closed');
        };
      }
      return docs;
    };
    const res = await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    expect(res.success).toBe(false);
    expect(res.error).toContain('socket closed');
    expect(res.cleanup.deleted.map((d: any) => d.id).sort()).toEqual([DH, BASEMENT].sort());
    expect(res.cleanup.failed).toEqual([]);
    expect(game.scenes.size).toBe(0);
  });

  it('refuses when two world scenes both claim the same source, writing nothing', async () => {
    const copy = (id: string) =>
      liveWorldScene(id, `copy ${id}`, `${BG}1-DeathHouse.webp`, {
        flags: { aidm: { sourcePack: PACK, sourceSceneId: DH, adoptedFor: DH } },
      });
    installWorld({ scenes: [copy('copyA00000000001'), copy('copyB00000000001')] });
    const res = await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    expect(res.success).toBe(false);
    expect(res.conflicts[0].reason).toBe('ambiguous-adopted-copies');
    expect(writes()).toEqual([]);
  });

  it('refuses on a Foundry without prepareImport instead of calling Adventure import()', async () => {
    const importSpy = vi.fn();
    const pack: any = buildPack();
    pack.getDocument = async () => ({ id: ARC_A, import: importSpy });
    installWorld({ scenes: [], pack });
    const res = await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    expect(res.success).toBe(false);
    expect(res.error).toContain('will not fall back');
    expect(importSpy).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('refuses if Foundry prepares other document types anyway (a future rename of importFields)', async () => {
    const pack: any = buildPack();
    const realGet = pack.getDocument;
    pack.getDocument = async (id: string) => {
      const adv: any = await realGet(id);
      const prep = adv.prepareImport.bind(adv);
      adv.prepareImport = () => prep({}); // behaves as if the option name were not recognised
      return adv;
    };
    installWorld({ scenes: [], pack });
    const res = await handlers().handleAdventureImport({
      package: PACK,
      scene_ref: `${PACK}.${CORE}.${DH}`,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/also prepared .*Actor/);
    expect(writes()).toEqual([]);
  });
});

describe('adventure-source-backfill handler (board #1714)', () => {
  it('dry run (the default) reports the four live scenes and writes nothing', async () => {
    installWorld({ scenes: LIVE_SCENES() });
    const before = snapshotScenes();
    const res = await handlers().handleAdventureSourceBackfill({ pack: PACK });
    expect(res).toMatchObject({ success: true, mode: 'dry-run', changed: false, pack: PACK });
    expect(res.will_tag.map((e: any) => e.scene_id)).toEqual([DH, BASEMENT, VILLAGE, BAROVIA]);
    expect(res.next_step).toContain(res.plan_id);
    expect(writes()).toEqual([]);
    expect(snapshotScenes()).toBe(before);
  });

  it('apply without the dry-run plan_id, or with a stale one, is refused and writes nothing', async () => {
    installWorld({ scenes: LIVE_SCENES() });
    const noId = await handlers().handleAdventureSourceBackfill({ pack: PACK, apply: true });
    expect(noId).toMatchObject({ success: false, mode: 'apply', changed: false });
    const stale = await handlers().handleAdventureSourceBackfill({
      pack: PACK,
      apply: true,
      plan_id: 'bf-4-00000000',
    });
    expect(stale.success).toBe(false);
    expect(stale.error).toContain('Nothing was changed');
    expect(writes()).toEqual([]);
  });

  it('a refused apply does not reveal the live plan_id or the plan (board #1714 review)', async () => {
    installWorld({ scenes: LIVE_SCENES() });
    const realPlanId = (await handlers().handleAdventureSourceBackfill({ pack: PACK })).plan_id;
    const refused = await handlers().handleAdventureSourceBackfill({ pack: PACK, apply: true });
    expect(Object.keys(refused).sort()).toEqual(['changed', 'error', 'mode', 'success', 'summary']);
    expect(refused.summary.will_tag).toBe(4);
    expect(JSON.stringify(refused)).not.toContain(realPlanId);
    // So a second apply built only from the refusal still has no plan_id to send.
    const again = await handlers().handleAdventureSourceBackfill({
      pack: PACK,
      apply: true,
      plan_id: refused.plan_id,
    });
    expect(again.success).toBe(false);
    expect(writes()).toEqual([]);
  });

  it('lists a package scene whose world id is an invalid stored scene under conflicts', async () => {
    installWorld({
      scenes: LIVE_SCENES().filter(s => s._id !== DH),
      invalidScenes: [{ _id: DH, name: 'broken' }],
    });
    const res = await handlers().handleAdventureSourceBackfill({ pack: `${PACK}:${ARC_A}` });
    expect(res.will_tag.map((e: any) => e.scene_id)).toEqual([BASEMENT]);
    expect(res.conflicts.map((e: any) => e.scene_id)).toEqual([DH]);
    expect(res.conflicts[0].reason).toContain("failed Foundry's data checks");
    expect(writes()).toEqual([]);
  });

  it('apply with the plan_id writes only flags.aidm keys on exactly the planned scenes, then import reuses them', async () => {
    installWorld({
      scenes: LIVE_SCENES(),
      actors: [
        { _id: 'pc1' },
        { _id: 'pc2' },
        { _id: 'pc3' },
        { _id: 'pc4' },
        { _id: ARMOR },
        { _id: ROSE },
      ],
    });
    const dry = await handlers().handleAdventureSourceBackfill({ pack: PACK });
    const res = await handlers().handleAdventureSourceBackfill({
      pack: PACK,
      apply: true,
      plan_id: dry.plan_id,
    });
    expect(res).toMatchObject({ success: true, mode: 'apply', changed: true });
    expect(res.applied).toEqual({ tagged: [DH, BASEMENT, VILLAGE, BAROVIA], failed: [] });
    const updates = writes();
    expect(updates.map(c => [c.op, c.ids[0]])).toEqual([
      ['doc.update', DH],
      ['doc.update', BASEMENT],
      ['doc.update', VILLAGE],
      ['doc.update', BAROVIA],
    ]);
    for (const u of updates) {
      expect(Object.keys(u.changes).every(k => k.startsWith('flags.aidm.'))).toBe(true);
    }
    const dh: any = game.scenes.get(DH);
    expect(dh.name).toBe('Curse of Strahd: Death House');
    expect(dh.flags.aidm.wall_count).toBe(42); // existing aidm keys kept
    expect(dh._source.tokens).toHaveLength(4);

    calls = [];
    const imp = await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    expect(imp).toMatchObject({ success: true, reused: true, scene_id: DH });
    expect(writes()).toEqual([]);
  });

  it('with an Adventure id it loads only that entry, and limits the plan to its scenes', async () => {
    const pack: any = installWorld({ scenes: LIVE_SCENES() });
    const getDocuments = vi.spyOn(pack, 'getDocuments');
    const res = await handlers().handleAdventureSourceBackfill({ pack: `${PACK}:${ARC_A}` });
    expect(getDocuments).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect(res.scope.adventure_id).toBe(ARC_A);
    expect(res.will_tag.map((e: any) => e.scene_id)).toEqual([DH, BASEMENT]);
    const missing = await handlers().handleAdventureSourceBackfill({
      pack: `${PACK}:noSuchAdventure1`,
    });
    expect(missing.success).toBe(false);
    expect(writes()).toEqual([]);
  });

  it('without a pack it refuses and lists the installed Adventure packs', async () => {
    installWorld({ scenes: [] });
    const res = await handlers().handleAdventureSourceBackfill({});
    expect(res.success).toBe(false);
    expect(res.adventure_packs).toEqual([PACK]);
    expect(writes()).toEqual([]);
  });
});

describe('adventure-import: stored documents that failed validation (board #1714 review)', () => {
  const brokenDeathHouse = () => ({ _id: DH, name: 'Curse of Strahd: Death House', walls: 'bad' });

  it('treats an invalid stored scene id as taken: refuses, writes nothing, stored record untouched', async () => {
    installWorld({
      scenes: [],
      invalidScenes: [brokenDeathHouse()],
      actors: [{ _id: ARMOR }, { _id: ROSE }],
    });
    expect(game.scenes.get(DH)).toBeUndefined(); // hidden from the collection, like Foundry
    const before = snapshotScenes();
    const res = await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    expect(res.success).toBe(false);
    expect(res.conflicts.map((c: any) => [c.scene_id, c.reason])).toEqual([
      [DH, 'id-taken-invalid'],
    ]);
    expect(res.error).toContain("failed Foundry's data checks");
    expect(writes()).toEqual([]);
    expect(snapshotScenes()).toBe(before);
  });

  it('NEGATIVE CONTROL: without the invalid-id check the fake server silently replaces that record', async () => {
    installWorld({
      scenes: [],
      invalidScenes: [brokenDeathHouse()],
      actors: [{ _id: ARMOR }, { _id: ROSE }],
    });
    game.scenes.invalidDocumentIds = undefined; // a check that cannot see invalid documents
    const res = await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    expect(res.success).toBe(true);
    expect(replacedIds()).toEqual([DH]); // the broken stored Death House was overwritten
  });

  it('with import_missing_actors, never creates over an invalid stored actor', async () => {
    installWorld({
      scenes: [],
      actors: [{ _id: ARMOR }],
      invalidActors: [{ _id: ROSE, name: 'Rose Durst (broken data)' }],
    });
    const res = await handlers().handleAdventureImport({
      package: PACK,
      scene_ref: DH_REF,
      import_missing_actors: true,
    });
    expect(res.success).toBe(true); // the actor exists (invalid), so it is not "missing"
    expect(res.invalid_actor_ids).toEqual([ROSE]); // but it is reported, without failing
    expect(res.imported.actors).toEqual([]);
    expect(calls.some(c => c.documentName === 'Actor')).toBe(false);
    expect(collections.get('Actor')!.stored.get(ROSE).name).toBe('Rose Durst (broken data)');
  });

  it('NEGATIVE CONTROL: without the invalid-id check import_missing_actors replaces the invalid actor', async () => {
    installWorld({
      scenes: [],
      actors: [{ _id: ARMOR }],
      invalidActors: [{ _id: ROSE, name: 'Rose Durst (broken data)' }],
    });
    game.actors.invalidDocumentIds = undefined;
    await handlers().handleAdventureImport({
      package: PACK,
      scene_ref: DH_REF,
      import_missing_actors: true,
    });
    expect(replacedIds()).toEqual([ROSE]);
  });
});

describe('adventure-import and back-fill apply run one at a time (board #1714 review)', () => {
  it('a second import of the same scene waits for the first, then reuses what it created', async () => {
    const pack: any = buildPack();
    const hold = gate();
    const events: string[] = [];
    const realGet = pack.getDocument;
    let n = 0;
    pack.getDocument = async (id: string) => {
      const adv: any = await realGet(id);
      const call = ++n;
      const prep = adv.prepareImport.bind(adv);
      const imp = adv.importContent.bind(adv);
      adv.prepareImport = async (o: any) => {
        events.push(`prepare#${call}`);
        return prep(o);
      };
      adv.importContent = async (d: any) => {
        events.push(`import-start#${call}`);
        if (call === 1) await hold.promise;
        const r = await imp(d);
        events.push(`import-end#${call}`);
        return r;
      };
      return adv;
    };
    installWorld({ scenes: [], actors: [{ _id: ARMOR }, { _id: ROSE }], pack });
    const h = handlers();
    const first = h.handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    const second = h.handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    await new Promise(r => setTimeout(r, 20));
    expect(events).toEqual(['prepare#1', 'import-start#1']); // the second call has not started
    hold.open();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ success: true, reused: false });
    expect(b).toMatchObject({ success: true, reused: true, imported: { scenes: [], actors: [] } });
    expect(events).toEqual(['prepare#1', 'import-start#1', 'import-end#1']);
    expect(replacedIds()).toEqual([]);
    expect(calls.filter(c => c.op === 'create')).toHaveLength(1);
  });

  it('back-fill apply waits for an import in progress before it plans and writes', async () => {
    const pack: any = buildPack();
    const hold = gate();
    const realGet = pack.getDocument;
    pack.getDocument = async (id: string) => {
      const adv: any = await realGet(id);
      if (id === ARC_A) {
        const imp = adv.importContent.bind(adv);
        adv.importContent = async (d: any) => {
          await hold.promise;
          return imp(d);
        };
      }
      return adv;
    };
    const arcBScenes = LIVE_SCENES().filter(s => s._id === VILLAGE || s._id === BAROVIA);
    installWorld({ scenes: arcBScenes, actors: [{ _id: ARMOR }, { _id: ROSE }], pack });
    const h = handlers();
    const dry = await h.handleAdventureSourceBackfill({ pack: `${PACK}:${ARC_B}` });
    const importing = h.handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    const applying = h.handleAdventureSourceBackfill({
      pack: `${PACK}:${ARC_B}`,
      apply: true,
      plan_id: dry.plan_id,
    });
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toEqual([]); // import is held; apply is queued behind it
    hold.open();
    const [imp, app] = await Promise.all([importing, applying]);
    expect(imp.success).toBe(true);
    expect(app.applied.tagged).toEqual([VILLAGE, BAROVIA]);
    expect(calls.map(c => c.op)).toEqual(['create', 'doc.update', 'doc.update']);
  });

  it('a call that throws does not block the calls queued after it', async () => {
    installWorld({ scenes: [], actors: [{ _id: ARMOR }, { _id: ROSE }] });
    const h = handlers();
    const bad = h.handleAdventureImport({ package: PACK }); // no scene_ref
    const good = h.handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    const [r1, r2] = await Promise.all([bad, good]);
    expect(r1.success).toBe(false);
    expect(r1.error).toContain('scene_ref is required');
    expect(r2.success).toBe(true);
  });
});

describe('adventure-import rollback covers every document the call created (board #1714 review)', () => {
  // Arms a throw in the scene's name getter as soon as an actor has been created, so the call fails
  // AFTER both scenes and an actor exist.
  function armThrowAfterActorCreate() {
    let armed = false;
    const realActorCreate = classes.Actor.createDocuments;
    classes.Actor.createDocuments = async (data: any[], options: any) => {
      const docs = await realActorCreate(data, options);
      armed = true;
      return docs;
    };
    const realSceneCreate = classes.Scene.createDocuments;
    classes.Scene.createDocuments = async (data: any[], options: any) => {
      const docs = await realSceneCreate(data, options);
      for (const d of docs) {
        const src = d._source;
        Object.defineProperty(d, 'name', {
          get() {
            if (armed) throw new Error('lost connection');
            return src.name;
          },
        });
      }
      return docs;
    };
  }

  it('rolls back created actors as well as created scenes when a later step throws', async () => {
    installWorld({ scenes: [], actors: [{ _id: ARMOR }] });
    armThrowAfterActorCreate();
    const res = await handlers().handleAdventureImport({
      package: PACK,
      scene_ref: DH_REF,
      import_missing_actors: true,
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('lost connection');
    expect(res.cleanup.deleted).toEqual([
      { type: 'Actor', id: ROSE },
      { type: 'Scene', id: BASEMENT },
      { type: 'Scene', id: DH },
    ]);
    expect(game.actors.has(ROSE)).toBe(false);
    expect(game.actors.has(ARMOR)).toBe(true);
    expect(game.scenes.size).toBe(0);
  });

  it('on the reuse path, rolls back an actor it created if a later step throws, and keeps the scene', async () => {
    const tagged = liveWorldScene(DH, 'Death House', `${BG}1-DeathHouse.webp`, {
      tokens: [{ actorId: ROSE }],
      flags: { aidm: { sourcePack: PACK, sourceSceneId: DH, adoptedFor: DH } },
    });
    installWorld({ scenes: [tagged], actors: [] });
    const dh: any = game.scenes.get(DH);
    let armed = false;
    const realActorCreate = classes.Actor.createDocuments;
    classes.Actor.createDocuments = async (data: any[], options: any) => {
      const docs = await realActorCreate(data, options);
      armed = true;
      return docs;
    };
    Object.defineProperty(dh, 'name', {
      get() {
        if (armed) throw new Error('lost connection');
        return 'Death House';
      },
    });
    const res = await handlers().handleAdventureImport({
      package: PACK,
      scene_ref: DH_REF,
      import_missing_actors: true,
    });
    expect(res.success).toBe(false);
    expect(res.cleanup.deleted).toEqual([{ type: 'Actor', id: ROSE }]);
    expect(game.actors.has(ROSE)).toBe(false);
    expect(game.scenes.has(DH)).toBe(true);
  });

  it('rolls back scenes when importContent throws after its create step', async () => {
    const pack: any = buildPack();
    const realGet = pack.getDocument;
    pack.getDocument = async (id: string) => {
      const adv: any = await realGet(id);
      const imp = adv.importContent.bind(adv);
      adv.importContent = async (d: any) => {
        await imp(d);
        throw new Error('progress bar failed');
      };
      return adv;
    };
    installWorld({ scenes: [], actors: [{ _id: ARMOR }, { _id: ROSE }], pack });
    const res = await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    expect(res.success).toBe(false);
    expect(res.error).toContain('progress bar failed');
    expect(res.cleanup.deleted.map((d: any) => d.id).sort()).toEqual([DH, BASEMENT].sort());
    expect(game.scenes.size).toBe(0);
  });

  it('tag fix-up only touches scenes this call reports as created', async () => {
    const pack: any = buildPack();
    const realGet = pack.getDocument;
    pack.getDocument = async (id: string) => {
      const adv: any = await realGet(id);
      const imp = adv.importContent.bind(adv);
      adv.importContent = async (d: any) => {
        d.toCreate.Scene = d.toCreate.Scene.map((s: any) => ({ ...s, flags: {} }));
        const r = await imp(d);
        r.created.Scene = r.created.Scene.filter((s: any) => s.id !== BASEMENT); // under-reported
        return r;
      };
      return adv;
    };
    installWorld({ scenes: [], actors: [{ _id: ARMOR }, { _id: ROSE }], pack });
    await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    const updated = calls.filter(c => c.op === 'doc.update').map(c => c.ids[0]);
    expect(updated).toEqual([DH]);
  });
});

describe('adventure-import single-scene path, 3-part refs (board #1714 review)', () => {
  const LONE_REF = `${SCENE_PACK}.${LONE}`;

  it('creates the scene under a new id, tagged, when the world has nothing with that id', async () => {
    installWorld({ scenes: [] });
    const res = await handlers().handleAdventureImport({
      package: SCENE_PACK,
      scene_ref: LONE_REF,
    });
    expect(res.success).toBe(true);
    const created = calls.find(c => c.op === 'create')!;
    expect(created.options.keepId).toBe(true); // the new id is chosen and checked first
    expect(created.ids[0]).toBe(res.scene_id);
    const scene: any = game.scenes.get(res.scene_id);
    expect(res.scene_id).not.toBe(LONE);
    expect(scene.flags.aidm).toMatchObject({ sourcePack: SCENE_PACK, sourceSceneId: LONE });
    expect(replacedIds()).toEqual([]);
  });

  it('refuses when an untagged world scene already has the pack scene id (an earlier adoption)', async () => {
    installWorld({ scenes: [liveWorldScene(LONE, 'Lone Tower (adopted)', 'x.webp')] });
    const res = await handlers().handleAdventureImport({
      package: SCENE_PACK,
      scene_ref: LONE_REF,
    });
    expect(res.success).toBe(false);
    expect(res.conflicts.map((c: any) => c.reason)).toEqual(['id-taken-untagged']);
    expect(writes()).toEqual([]);
  });

  it('refuses when an invalid stored scene has the pack scene id', async () => {
    installWorld({ scenes: [], invalidScenes: [{ _id: LONE, name: 'broken' }] });
    const res = await handlers().handleAdventureImport({
      package: SCENE_PACK,
      scene_ref: LONE_REF,
    });
    expect(res.success).toBe(false);
    expect(res.conflicts.map((c: any) => c.reason)).toEqual(['id-taken-invalid']);
    expect(writes()).toEqual([]);
  });
});

describe('create calls that fail after the server saved the document (board #1714 review 2)', () => {
  it('NEGATIVE CONTROL: the fake really saves before it throws, in both modes', async () => {
    installWorld({ scenes: [] });
    classes.Actor.failAfterSave = 'client';
    await expect(
      classes.Actor.createDocuments([{ _id: ROSE }], { keepId: true })
    ).rejects.toThrow();
    expect(game.actors.has(ROSE)).toBe(true);
    classes.Actor.failAfterSave = 'server-only';
    await expect(
      classes.Actor.createDocuments([{ _id: ARMOR }], { keepId: true })
    ).rejects.toThrow();
    expect(game.actors.has(ARMOR)).toBe(false);
    expect(collections.get('Actor')!.stored.has(ARMOR)).toBe(true);
  });

  it('actor path: an actor saved before its create threw is rolled back with the scenes', async () => {
    installWorld({ scenes: [], actors: [{ _id: ARMOR }] });
    classes.Actor.failAfterSave = 'client';
    const res = await handlers().handleAdventureImport({
      package: PACK,
      scene_ref: DH_REF,
      import_missing_actors: true,
    });
    expect(res.success).toBe(false);
    expect(res.unresolved.actor_ids).toEqual([ROSE]);
    expect(res.cleanup.deleted).toEqual([
      { type: 'Actor', id: ROSE },
      { type: 'Scene', id: BASEMENT },
      { type: 'Scene', id: DH },
    ]);
    expect(res.cleanup.failed).toEqual([]);
    expect(collections.get('Actor')!.stored.has(ROSE)).toBe(false);
  });

  it('actor path: an actor saved on the server only is reported by id as not removable from here', async () => {
    installWorld({ scenes: [], actors: [{ _id: ARMOR }] });
    classes.Actor.failAfterSave = 'server-only';
    const res = await handlers().handleAdventureImport({
      package: PACK,
      scene_ref: DH_REF,
      import_missing_actors: true,
    });
    expect(res.success).toBe(false);
    expect(res.cleanup.deleted.map((d: any) => d.id).sort()).toEqual([DH, BASEMENT].sort());
    expect(res.cleanup.failed.map((d: any) => [d.type, d.id])).toEqual([['Actor', ROSE]]);
    expect(res.cleanup.failed[0].error).toContain('never loaded in this client');
  });

  it('single-scene path: a scene saved before its create threw is rolled back by its chosen id', async () => {
    installWorld({ scenes: [] });
    classes.Scene.failAfterSave = 'client';
    const res = await handlers().handleAdventureImport({
      package: SCENE_PACK,
      scene_ref: `${SCENE_PACK}.${LONE}`,
    });
    expect(res.success).toBe(false);
    const createdId = calls.find(c => c.op === 'create')!.ids[0];
    expect(res.cleanup).toEqual({ deleted: [{ type: 'Scene', id: createdId }], failed: [] });
    expect(collections.get('Scene')!.stored.size).toBe(0);
  });

  it('single-scene path: a scene saved on the server only is reported by id', async () => {
    installWorld({ scenes: [] });
    classes.Scene.failAfterSave = 'server-only';
    const res = await handlers().handleAdventureImport({
      package: SCENE_PACK,
      scene_ref: `${SCENE_PACK}.${LONE}`,
    });
    const createdId = calls.find(c => c.op === 'create')!.ids[0];
    expect(res.cleanup.deleted).toEqual([]);
    expect(res.cleanup.failed.map((d: any) => d.id)).toEqual([createdId]);
  });

  it('adventure path: scenes saved on the server only when importContent threw are reported by id', async () => {
    installWorld({ scenes: [], actors: [{ _id: ARMOR }, { _id: ROSE }] });
    classes.Scene.failAfterSave = 'server-only';
    const res = await handlers().handleAdventureImport({ package: PACK, scene_ref: DH_REF });
    expect(res.success).toBe(false);
    expect(res.cleanup.failed.map((d: any) => d.id).sort()).toEqual([DH, BASEMENT].sort());
  });
});

describe('the actor re-check right before create (board #1714 review 2)', () => {
  // Makes an actor appear in the world after the missing list was built, right before the create.
  function packThatAddsActorDuringSearch(makeInvalid: boolean) {
    const pack: any = buildPack();
    const realGet = pack.getDocument;
    pack.getDocument = async (id: string) => {
      if (id === CORE) {
        const c = collections.get('Actor')!;
        if (makeInvalid) {
          c.stored.set(ROSE, { _id: ROSE, name: 'Rose (arrived broken)' });
          c.invalidDocumentIds!.add(ROSE);
        } else {
          const doc = makeDoc('Actor', { _id: ROSE, name: 'Rose (arrived meanwhile)' }, c);
          c.stored.set(ROSE, doc._source);
          c.set(ROSE, doc);
        }
      }
      return realGet(id);
    };
    return pack;
  }

  it('skips an actor that appeared meanwhile, instead of creating over it', async () => {
    installWorld({
      scenes: [],
      actors: [{ _id: ARMOR }],
      pack: packThatAddsActorDuringSearch(false),
    });
    const res = await handlers().handleAdventureImport({
      package: PACK,
      scene_ref: DH_REF,
      import_missing_actors: true,
    });
    expect(calls.some(c => c.documentName === 'Actor' && c.op === 'create')).toBe(false);
    expect(replacedIds()).toEqual([]);
    expect(game.actors.get(ROSE).name).toBe('Rose (arrived meanwhile)');
    expect(res.imported.actors).toEqual([]);
  });

  it('skips an actor that appeared meanwhile as an invalid stored record', async () => {
    installWorld({
      scenes: [],
      actors: [{ _id: ARMOR }],
      pack: packThatAddsActorDuringSearch(true),
    });
    await handlers().handleAdventureImport({
      package: PACK,
      scene_ref: DH_REF,
      import_missing_actors: true,
    });
    expect(calls.some(c => c.documentName === 'Actor' && c.op === 'create')).toBe(false);
    expect(replacedIds()).toEqual([]);
  });
});

describe('invalid_actor_ids (board #1714 review 2)', () => {
  it('scene-integrity reports a token actor Foundry could not load, without failing', async () => {
    const scene = liveWorldScene(DH, 'Death House', `${BG}1-DeathHouse.webp`, {
      tokens: [{ actorId: ROSE }, { actorId: ARMOR }],
    });
    installWorld({ scenes: [scene], actors: [{ _id: ARMOR }], invalidActors: [{ _id: ROSE }] });
    const res = await handlers().handleSceneIntegrity({ scene_id: DH });
    expect(res.success).toBe(true);
    expect(res.unresolved.actor_ids).toEqual([]);
    expect(res.invalid_actor_ids).toEqual([ROSE]);
  });
});
