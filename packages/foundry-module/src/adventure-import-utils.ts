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
