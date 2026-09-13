/**
 * Pure helper for cleaning up stale Combat documents (board #1652).
 *
 * Root cause this replaces: this app's own combat lifecycle never runs more than one live fight
 * at a time (handleStartCombat only ever creates a new Combat when `game.combat` -- the world's
 * one currently-ACTIVE combat pointer -- is null), yet the only place anything ever DELETED a
 * Combat document was handleEndCombat, and it too only ever read `game.combat`. The moment a
 * fight ended WITHOUT handleEndCombat running (a crashed eval run, a turn-budget cutoff, a party
 * that fled the scene without a formal retreat, or simply Foundry's own behavior of deactivating
 * -- never deleting -- the previous combat when a new one is created with `active: true`), that
 * Combat document became permanently unreachable: it is no longer `game.combat`, so no code path
 * in this app could ever target it for deletion again. Verified live on the Death House world
 * (board #1645/#1652): 6 Combat documents existed, 1 active, 5 orphaned exactly this way.
 *
 * Fix: both handleStartCombat (before creating a new combat) and handleEndCombat (after handling
 * whichever combat WAS active) sweep every Combat document in the world and delete every one
 * except the single one they intend to keep (usually none -- this app's model has no legitimate
 * reason for more than one Combat document to exist at any moment it is not itself running a
 * fight). This file carries no dependency on Foundry's browser globals (game, Combat, ...), the
 * same discipline combat-scoping-utils.ts and adventure-import-utils.ts already follow in this
 * package, specifically so the selection rule can be unit tested with plain vitest. All the
 * Foundry-specific work -- reading game.combats.contents, calling documentClass.deleteDocuments --
 * happens in queries.ts and is handed in here as a plain list of ids.
 *
 * Generic by construction: nothing here names an adventure, a module, or a scene.
 */

/**
 * Which Combat document ids should be deleted right now, given every Combat id currently in the
 * world and the one id (if any) that must be kept. Returns every id in `allIds` except `keepId`
 * -- including a `keepId` that is not actually present in `allIds` (nothing to keep, so nothing
 * is excluded), and including duplicate ids exactly as given (never assumes `allIds` is already a
 * deduplicated set; the caller's `game.combats.contents` never contains duplicates in practice,
 * but this function makes no fragile assumption about that). Pass `null` for `keepId` to mean
 * "keep nothing -- delete every Combat document that exists".
 */
export function staleCombatIdsToDelete(allIds: string[], keepId: string | null): string[] {
  if (!allIds.length) return [];
  if (keepId == null) return [...allIds];
  return allIds.filter(id => id !== keepId);
}
