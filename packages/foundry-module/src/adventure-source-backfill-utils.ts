/**
 * Pure planning logic for the adventure-source-backfill tool (board #1714).
 *
 * Why this tool exists: adventure-import finds an already-adopted scene by its
 * flags.aidm.sourcePack / flags.aidm.sourceSceneId tags. Scenes adopted before those tags were
 * written reliably (the live Curse of Strahd scenes, for example) carry no tags, so the import
 * cannot tell they are the same scenes and, since board #1714, refuses to import over them. This
 * tool finds world scenes that provably came from a package scene and tags them, so the next
 * adventure-import call reuses them instead of refusing.
 *
 * "Provably" means: the world scene has the SAME id as the package scene (Adventure import keeps
 * ids) AND the same background image. Anything weaker (same id but a different background, or a
 * name/background match under a different id) is reported for a person to review and never
 * tagged automatically.
 *
 * Like adventure-import-utils.ts, nothing here touches Foundry globals, so it is unit tested with
 * plain vitest. queries.ts gathers the plain data and does the (optional) writes.
 */

/** One scene inside an Adventure document of the pack being checked. */
export interface BackfillPackScene {
  adventure_id: string;
  adventure_name: string | null;
  scene_id: string;
  name: string | null;
  background: string | null;
}

/** One world scene, reduced to what the plan needs. */
export interface BackfillWorldScene {
  id: string;
  name: string | null;
  background: string | null;
  active: boolean;
  token_count: number;
  /** `_stats.duplicateSource`, set by Foundry when the scene was made with Duplicate. */
  duplicate_source: string | null;
  /** The aidm source tags the scene already carries, or null when it carries none. */
  tags: { sourcePack: string | null; sourceSceneId: string | null } | null;
}

export interface BackfillSourceRef {
  pack: string;
  adventure_id: string;
  adventure_name: string | null;
  scene_id: string;
  scene_name: string | null;
}

export interface BackfillEntry {
  scene_id: string;
  scene_name: string | null;
  active: boolean;
  token_count: number;
  duplicate_source: string | null;
  match: { by_id: boolean; same_background: boolean; same_name: boolean };
  /** The package scene this world scene matches (the id match, or the first weaker candidate). */
  source: BackfillSourceRef | null;
  /** Other package scenes that also matched, for review entries. */
  candidates?: BackfillSourceRef[];
  /** The exact tags apply mode would write. Present only on will_tag entries. */
  tags?: { sourcePack: string; sourceSceneId: string; adoptedFor: string };
  /** Plain-English reason, on every entry that is not will_tag. */
  reason?: string;
}

export interface BackfillPlan {
  pack: string;
  plan_id: string;
  summary: {
    world_scenes_checked: number;
    pack_scenes: number;
    will_tag: number;
    already_tagged: number;
    needs_review: number;
    conflicts: number;
  };
  will_tag: BackfillEntry[];
  already_tagged: BackfillEntry[];
  needs_review: BackfillEntry[];
  conflicts: BackfillEntry[];
}

/** Background paths compare equal when they match exactly, ignoring any "?cache-buster" suffix. */
export function sameBackground(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b) return false;
  return a.split('?')[0] === b.split('?')[0];
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Loose name comparison, for reporting only (never enough on its own to tag anything). Treats
 * "Curse of Strahd: Death House" and "1-Death House" as the same name: the part after the last
 * ": " on one side, and the name without a short leading code like "1-" or "B5b - " on the other.
 */
export function sameSceneName(
  worldName: string | null | undefined,
  packName: string | null | undefined
): boolean {
  if (!worldName || !packName) return false;
  const w = normName(worldName);
  const p = normName(packName);
  if (w && w === p) return true;
  const wTail = normName(worldName.split(': ').pop() ?? '');
  const pBare = normName(packName.replace(/^[A-Za-z]{0,2}\d+[A-Za-z]?\s*-\s*/, ''));
  return !!wTail && wTail === pBare;
}

/** A short, stable id for a plan (FNV-1a 32-bit over the sorted list of tags it would write). */
export function backfillPlanId(willTag: BackfillEntry[]): string {
  const lines = willTag
    .map(e => `${e.scene_id}>${e.tags?.sourcePack ?? ''}>${e.tags?.sourceSceneId ?? ''}`)
    .sort()
    .join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < lines.length; i++) {
    h ^= lines.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `bf-${willTag.length}-${h.toString(16).padStart(8, '0')}`;
}

function refOf(pack: string, s: BackfillPackScene): BackfillSourceRef {
  return {
    pack,
    adventure_id: s.adventure_id,
    adventure_name: s.adventure_name,
    scene_id: s.scene_id,
    scene_name: s.name,
  };
}

/**
 * Builds the back-fill plan. Read-only by construction: it only sorts world scenes into lists.
 *  - will_tag: untagged, same id as exactly one package scene, same background, and no other
 *    world scene is already tagged as adopted from that package scene.
 *  - already_tagged: carries tags for this pack and a scene that is in this pack.
 *  - needs_review: a weaker match a person should look at; never tagged by this tool.
 *  - conflicts: tags that disagree with the pack; never changed by this tool.
 * World scenes with no relation to the pack are counted but not listed.
 * `onlySceneIds`, when given, limits the check to those world scene ids. Set `partialPack` when
 * `packScenes` holds only some of the pack's Adventure entries: a tag pointing at a scene outside
 * them is then left out of the lists instead of being reported as a stale tag.
 * `invalidWorldIds` are ids of world scenes Foundry stores but could not load because their data
 * failed validation (game.scenes.invalidDocumentIds). They are not in `worldScenes`; a package
 * scene with one of those ids is reported under conflicts, since it can be neither read nor tagged.
 */
export function planSourceTagBackfill(opts: {
  pack: string;
  packScenes: BackfillPackScene[];
  worldScenes: BackfillWorldScene[];
  onlySceneIds?: string[] | null;
  partialPack?: boolean;
  invalidWorldIds?: string[] | null;
}): BackfillPlan {
  const pack = opts.pack;
  const packScenes = opts.packScenes ?? [];
  const only = opts.onlySceneIds?.length ? new Set(opts.onlySceneIds) : null;
  const allWorld = opts.worldScenes ?? [];
  const world = only ? allWorld.filter(w => only.has(w.id)) : allWorld;

  const packById = new Map<string, BackfillPackScene[]>();
  for (const s of packScenes) {
    const list = packById.get(s.scene_id) ?? [];
    list.push(s);
    packById.set(s.scene_id, list);
  }
  // Which package scene ids some world scene (anywhere in the world) is already tagged with.
  const taggedFrom = new Map<string, string[]>();
  for (const w of allWorld) {
    if (w.tags?.sourcePack === pack && w.tags?.sourceSceneId) {
      const list = taggedFrom.get(w.tags.sourceSceneId) ?? [];
      list.push(w.id);
      taggedFrom.set(w.tags.sourceSceneId, list);
    }
  }

  const plan: BackfillPlan = {
    pack,
    plan_id: '',
    summary: {
      world_scenes_checked: world.length,
      pack_scenes: packById.size,
      will_tag: 0,
      already_tagged: 0,
      needs_review: 0,
      conflicts: 0,
    },
    will_tag: [],
    already_tagged: [],
    needs_review: [],
    conflicts: [],
  };

  for (const w of world) {
    const idHits = packById.get(w.id) ?? [];
    const first = idHits[0];
    const base = (source: BackfillPackScene | undefined): BackfillEntry => ({
      scene_id: w.id,
      scene_name: w.name,
      active: w.active,
      token_count: w.token_count,
      duplicate_source: w.duplicate_source,
      match: {
        by_id: idHits.length > 0,
        same_background: !!source && sameBackground(w.background, source.background),
        same_name: !!source && sameSceneName(w.name, source.name),
      },
      source: source ? refOf(pack, source) : null,
    });

    const tagPack = w.tags?.sourcePack ?? null;
    const tagScene = w.tags?.sourceSceneId ?? null;
    const hasTags = !!(tagPack || tagScene);

    if (hasTags && tagPack === pack) {
      const tagged = tagScene ? packById.get(tagScene) : undefined;
      if (tagged?.length) {
        plan.already_tagged.push({ ...base(tagged[0]), reason: 'already tagged from this pack' });
      } else if (!opts.partialPack) {
        plan.conflicts.push({
          ...base(first),
          reason: `tagged as adopted from scene ${tagScene} of this pack, but the pack has no such scene`,
        });
      }
      continue;
    }
    if (hasTags) {
      if (idHits.length) {
        plan.conflicts.push({
          ...base(first),
          reason: `has the same id as a scene in this pack, but is tagged as coming from ${tagPack} scene ${tagScene}`,
        });
      }
      continue;
    }

    if (idHits.length > 1) {
      plan.needs_review.push({
        ...base(first),
        candidates: idHits.map(s => refOf(pack, s)),
        reason: 'its id appears in more than one Adventure entry of this pack; not tagged',
      });
      continue;
    }
    if (idHits.length === 1) {
      const entry = base(first);
      const others = (taggedFrom.get(first.scene_id) ?? []).filter(id => id !== w.id);
      if (others.length) {
        plan.conflicts.push({
          ...entry,
          reason: `another world scene (${others.join(', ')}) is already tagged as adopted from this package scene`,
        });
      } else if (entry.match.same_background) {
        plan.will_tag.push({
          ...entry,
          tags: { sourcePack: pack, sourceSceneId: first.scene_id, adoptedFor: first.scene_id },
        });
      } else {
        plan.needs_review.push({
          ...entry,
          reason:
            'same id as a package scene but a different background image (it may have been rebuilt); not tagged',
        });
      }
      continue;
    }

    const weak = packScenes.filter(
      s => sameBackground(w.background, s.background) || sameSceneName(w.name, s.name)
    );
    if (weak.length) {
      plan.needs_review.push({
        ...base(weak[0]),
        candidates: weak.map(s => refOf(pack, s)),
        reason:
          'matches a package scene by background or name only, under a different id (likely a copy); not tagged',
      });
    }
  }

  const invalid = new Set(opts.invalidWorldIds ?? []);
  for (const [id, hits] of packById) {
    if (!invalid.has(id) || (only && !only.has(id))) continue;
    const src = hits[0];
    plan.conflicts.push({
      scene_id: id,
      scene_name: src.name,
      active: false,
      token_count: 0,
      duplicate_source: null,
      match: { by_id: true, same_background: false, same_name: false },
      source: refOf(pack, src),
      reason:
        "the world stores a scene with this id that failed Foundry's data checks, so it cannot be read or tagged; repair or delete it first",
    });
  }

  plan.summary.will_tag = plan.will_tag.length;
  plan.summary.already_tagged = plan.already_tagged.length;
  plan.summary.needs_review = plan.needs_review.length;
  plan.summary.conflicts = plan.conflicts.length;
  plan.plan_id = backfillPlanId(plan.will_tag);
  return plan;
}

/** The dotted-path update apply mode writes for one will_tag entry. Only flags.aidm keys. */
export function backfillUpdatePayload(entry: BackfillEntry): Record<string, string> {
  if (!entry.tags) throw new Error(`scene ${entry.scene_id} has no planned tags`);
  return {
    'flags.aidm.sourcePack': entry.tags.sourcePack,
    'flags.aidm.sourceSceneId': entry.tags.sourceSceneId,
    'flags.aidm.adoptedFor': entry.tags.adoptedFor,
    'flags.aidm.sourceTaggedBy': 'adventure-source-backfill',
  };
}

/**
 * Accepts the pack id in the forms callers already have: a pack collection id
 * ("module.PackName"), a list-installed-packages package id ("module.PackName:adventureId"), or a
 * scene ref ("module.PackName.adventureId.sceneId"). Returns the pack collection id and, when the
 * input named one, the Adventure id.
 */
export function parsePackArg(raw: unknown): { pack: string; adventureId: string | null } | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  if (s.includes(':')) {
    const [pack, adv] = s.split(':');
    return pack ? { pack, adventureId: adv || null } : null;
  }
  const parts = s.split('.');
  if (parts.length >= 3) return { pack: `${parts[0]}.${parts[1]}`, adventureId: parts[2] || null };
  if (parts.length === 2) return { pack: s, adventureId: null };
  return null;
}
