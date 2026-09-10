/**
 * Pure helpers for adventure-import / scene-integrity (board #1311 root-cause fix).
 *
 * These carry NO dependency on Foundry's browser globals (game, CONFIG, Scene, ...), unlike the
 * rest of queries.ts, specifically so they can be unit tested with plain vitest -- the
 * foundry-module package otherwise has no test harness at all, because the query handlers need a
 * live Foundry client environment to run.
 */

/** A single "field path -> uuid string" hit found while walking a document's data. */
export interface SceneUuidHit {
  path: string;
  value: string;
}

/**
 * True if `v` looks like a Foundry document uuid rooted at a Scene, e.g. "Scene.<id>" or
 * "Scene.<id>.Region.<id>". Foundry document ids are 16-char alphanumeric
 * (foundry.utils.randomID()); requiring that exact shape after "Scene." -- rather than just
 * testing for the literal prefix -- keeps this from flagging incidental strings that happen to
 * start with the word "Scene" (e.g. "Scene Selection") as a false unresolved reference.
 */
export function looksLikeSceneUuid(v: unknown): v is string {
  return typeof v === 'string' && /^Scene\.[A-Za-z0-9]{16}(\.|$)/.test(v);
}

/**
 * Recursively walks any plain-object/array data structure (typically a RegionBehavior's
 * .toObject() output) and collects every string field that looks like a Scene-rooted uuid.
 * Deliberately untyped/unscoped to any known field name (e.g. "destination") so a brand-new
 * behavior type with its own uuid-bearing field is still caught without this code needing to
 * know its name.
 */
export function walkForSceneUuids(
  obj: any,
  path: string,
  seen: Set<any>,
  out: SceneUuidHit[]
): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') {
    if (looksLikeSceneUuid(obj)) out.push({ path, value: obj });
    return;
  }
  if (typeof obj !== 'object') return;
  if (seen.has(obj)) return; // cycle guard
  seen.add(obj);
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walkForSceneUuids(v, `${path}[${i}]`, seen, out));
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    walkForSceneUuids(v, path ? `${path}.${k}` : k, seen, out);
  }
}

/**
 * The module (package) id that owns a compendium pack, read off the pack's own metadata --
 * never a hardcoded module id. `packageName` is the documented v13 CompendiumCollection.Metadata
 * field; `pack.collection` (format "<packageName>.<packName>") is a defensive fallback for any
 * pack object that does not carry it directly.
 */
export function packModuleId(pack: any): string | undefined {
  const meta = pack?.metadata || {};
  if (meta.packageName) return meta.packageName;
  if (typeof pack?.collection === 'string') return pack.collection.split('.')[0];
  return undefined;
}

export interface UnresolvedSceneRef {
  scene_id: string;
  region_id: string | null;
  behavior_id: string | null;
  target: string;
}

/** Builds the human-readable `error` string from the unresolved shape, or undefined if clean. */
export function summarizeUnresolved(
  sceneRefs: UnresolvedSceneRef[],
  actorIds: string[]
): string | undefined {
  if (!sceneRefs.length && !actorIds.length) return undefined;
  const parts: string[] = [];
  if (sceneRefs.length) {
    const shown = sceneRefs
      .slice(0, 5)
      .map(
        r =>
          `${r.target} (scene ${r.scene_id}${r.region_id ? ', region ' + r.region_id : ''}${
            r.behavior_id ? ', behavior ' + r.behavior_id : ''
          })`
      )
      .join('; ');
    parts.push(
      `${sceneRefs.length} unresolved scene/region reference(s): ${shown}` +
        (sceneRefs.length > 5 ? `; +${sceneRefs.length - 5} more` : '')
    );
  }
  if (actorIds.length) {
    const shown = actorIds.slice(0, 10).join(', ');
    parts.push(
      `${actorIds.length} unresolved actor id(s): ${shown}` +
        (actorIds.length > 10 ? `; +${actorIds.length - 10} more` : '')
    );
  }
  return parts.join(' | ');
}

/**
 * The module search scope for actor resolution: the module that owns `primaryPack`, plus every
 * module id listed under that module's own manifest relationships.requires. `readModule` is
 * injected so this stays testable without a live `game.modules` global -- callers in the browser
 * pass `(id) => (game as any).modules?.get(id)`.
 */
export function moduleSearchScope(primaryPack: any, readModule: (id: string) => any): Set<string> {
  const scope = new Set<string>();
  const rootId = packModuleId(primaryPack);
  if (rootId) scope.add(rootId);
  try {
    const mod: any = rootId ? readModule(rootId) : undefined;
    const requires = mod?.relationships?.requires;
    if (requires) {
      const list: any[] = Array.isArray(requires)
        ? requires
        : typeof requires?.values === 'function'
          ? Array.from(requires.values())
          : Object.values(requires);
      for (const dep of list) {
        const depId = dep?.id || dep?.name;
        if (depId) scope.add(depId);
      }
    }
  } catch (e) {
    // Manifest relationship data is optional; best-effort only.
  }
  return scope;
}

/**
 * Read one key out of a document's `flags.aidm` namespace as a plain property -- never through
 * the getFlag flag-accessor method with scope "aidm" (board #1311, bridge/README.md 0007 entry).
 *
 * Foundry's Document flag-accessor methods (common/abstract/document.mjs) look up
 * `this.constructor.database.getFlagScopes()` and throw `Flag scope "<scope>" is not valid or
 * not currently active` for any scope that is not the id of an active package: a module, the
 * game system, "core", or "world". "aidm" is this lane's own flag namespace -- it is not a
 * package -- so calling a flag-accessor method with "aidm" as the scope argument throws
 * unconditionally on every call, on every world, regardless of what is stored under flags.aidm.
 * Foundry does not scope-check a plain property read/write, which is why every other writer in
 * this lane already reads/writes flags.aidm this way (e.g. scene.update({"flags.aidm.sourcePack":
 * ...}) / scene.flags?.aidm?.sourcePack) instead of the flag-accessor methods.
 */
export function readAidmFlag(doc: any, key: string): any {
  return doc?.flags?.aidm?.[key];
}

/**
 * True if `doc` already carries the aidm idempotency tags for this exact pack + source scene id,
 * read via readAidmFlag (never a flag-accessor method). Used to short-circuit a repeat
 * adventure-import call for a scene that was already adopted, and to skip re-tagging a sibling
 * scene that a prior call already tagged.
 */
export function isAdoptedFrom(doc: any, sourcePack: string, sourceSceneId: string): boolean {
  return (
    readAidmFlag(doc, 'sourcePack') === sourcePack &&
    readAidmFlag(doc, 'sourceSceneId') === sourceSceneId
  );
}

/**
 * Builds the dotted-path update payload for writing the aidm idempotency tags
 * (sourcePack/sourceSceneId/adoptedFor), for callers to pass straight to
 * `document.update(aidmTagUpdatePayload(...))` -- never the setFlag flag-accessor method with
 * scope "aidm" (same scope restriction as readAidmFlag above). Foundry's own dotted-path
 * flattening inside `update()` merges these into any existing `flags` object without disturbing
 * sibling keys under other namespaces, matching the merge semantics the setFlag accessor would
 * have provided if it were usable here.
 */
export function aidmTagUpdatePayload(tags: {
  sourcePack: string;
  sourceSceneId: string;
  adoptedFor: string;
}): Record<string, string> {
  return {
    'flags.aidm.sourcePack': tags.sourcePack,
    'flags.aidm.sourceSceneId': tags.sourceSceneId,
    'flags.aidm.adoptedFor': tags.adoptedFor,
  };
}

/** One document `adventure-import` created in the current call, tracked as it happens. */
export interface CreatedDocRef {
  /** Foundry document name, e.g. "Scene", "Actor", "JournalEntry", "Item", "Folder". */
  type: string;
  id: string;
}

/**
 * Flattens `Adventure#importContent`'s own `created` result (`Record<documentName, Document[]>`,
 * per the official v13 API: foundry.documents.types.AdventureImportResult) into an ordered
 * `{type, id}` list, preserving both the object's key order and each array's order -- this is the
 * import call's OWN record of exactly what it made, not something inferred afterward by diffing
 * world state. Generic over whatever document names `created` carries: today `adventure-import`
 * only requests `documentTypes: ['Scene']` so only a "Scene" key is ever present, but this makes
 * no assumption about that -- if a future caller widens `documentTypes` to include Actor, Item,
 * JournalEntry, or Folder, those creations are tracked the same way with no code change here.
 * Entries with no usable id (`id`/`_id` both missing) are skipped rather than pushed as `undefined`.
 */
export function collectCreatedDocuments(
  created: Record<string, Array<{ id?: string; _id?: string }>> | null | undefined
): CreatedDocRef[] {
  const out: CreatedDocRef[] = [];
  for (const [type, docs] of Object.entries(created ?? {})) {
    for (const doc of docs ?? []) {
      const id = doc?.id ?? doc?._id;
      if (id) out.push({ type, id });
    }
  }
  return out;
}

/** The outcome of attempting to delete one previously-created document during rollback. */
export interface CleanupAttempt {
  type: string;
  id: string;
  ok: boolean;
  error?: string;
}

/** `adventure-import`'s `cleanup` reply field: what rollback actually managed to remove. */
export interface CleanupReport {
  deleted: CreatedDocRef[];
  failed: { id: string; type: string; error: string }[];
}

/**
 * Turns a list of individual delete attempts (one per document, already run in reverse creation
 * order by the caller) into the `cleanup` reply shape: every document that deleted cleanly under
 * `deleted`, and every one that did not -- by id, with its own error -- under `failed`, rather
 * than collapsing a partial failure into one generic message. A caller that only sees `deleted`
 * would not know which specific document (if any) a user still has to remove by hand; this keeps
 * that list explicit so a partial cleanup is never reported as if it were a tidy one.
 */
export function summarizeCleanup(attempts: CleanupAttempt[]): CleanupReport {
  const deleted: CreatedDocRef[] = [];
  const failed: { id: string; type: string; error: string }[] = [];
  for (const a of attempts) {
    if (a.ok) {
      deleted.push({ type: a.type, id: a.id });
    } else {
      failed.push({ id: a.id, type: a.type, error: a.error || 'unknown error' });
    }
  }
  return { deleted, failed };
}
