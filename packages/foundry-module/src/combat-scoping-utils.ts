/**
 * Pure helpers for start-combat's default token scoping (board #1311, bridge fix 0006).
 *
 * Root cause this replaces: handleStartCombat's old default -- when no `tokens` were given, it
 * took literally `scene.tokens.contents`, every token placed on the scene. On a one-scene-per-
 * floor map (Death House and any adventure imported the same way) that pulls in every pre-placed
 * monster from every other room the moment combat starts anywhere on the floor -- on the Death
 * House sample, an Animated Armor from another room joined a Storage Room fight.
 *
 * These functions carry no dependency on Foundry's browser globals (game, CONFIG, canvas,
 * Region, ...), the same discipline adventure-import-utils.ts follows in this same package,
 * specifically so the selection rule itself can be unit tested with plain vitest. All the
 * Foundry-specific work -- finding a token's placed position, testing Scene Region containment,
 * running the wall-collision sight test -- happens in queries.ts and is handed in here as plain
 * data plus small injected accessor functions (the same injection style
 * adventure-import-utils.ts's moduleSearchScope(pack, readModule) already uses).
 */

/** Foundry's TOKEN_DISPOSITIONS.HOSTILE value (see constants.ts). Duplicated here, not imported,
 * to keep this file free of any import that could drag in a Foundry-global-touching module. */
export const TOKEN_DISPOSITION_HOSTILE = -1;

export interface CombatToken {
  id: string;
  name?: string;
  actorId?: string | null;
  /** Actor.type, e.g. "character" for a PC, "npc" for everything else. Undefined if the token has
   * no linked actor at all. */
  actorType?: string;
  disposition?: number;
  hidden?: boolean;
}

export type ExclusionReason = 'hidden' | 'out-of-room' | 'no-line-of-sight';

export interface ExcludedHostile {
  token: CombatToken;
  reason: ExclusionReason;
}

export interface DefaultCombatScopeDeps {
  /** Token name/id refs the caller explicitly named as "the party" for scoping purposes. Empty or
   * undefined means auto-detect: every token whose actorType is "character". */
  explicitPartyRefs?: string[] | undefined;
  /** Resolves one ref (a token id, or a case-insensitive token name) to a token id, or undefined
   * if nothing on the scene matches. */
  resolveRef: (ref: string) => string | undefined;
  /** True if the scene has at least one Scene Region defined at all. */
  regionsExistOnScene: boolean;
  /** Region ids (from the scene's own Region documents) that this token's current position falls
   * inside. Must return [] when regionsExistOnScene is false or the token's position is unknown --
   * never guess. */
  tokenRegionIds: (token: CombatToken) => string[];
  /** True if nothing (no wall) blocks sight between these two tokens' current positions. Must
   * return false, never throw, when a position is unknown or the collision test itself fails --
   * an unresolvable sight test must never silently admit a hostile. */
  hasLineOfSight: (a: CombatToken, b: CombatToken) => boolean;
}

export interface DefaultCombatScopeResult {
  party: CombatToken[];
  admitted: CombatToken[];
  excluded: ExcludedHostile[];
  /** Which rule decided hostile admission: 'region' (the party is standing inside at least one
   * Scene Region, so region-sharing decides), or 'line-of-sight' (the fallback used whenever the
   * party is not inside any region -- whether because the scene has none at all, or because the
   * party simply isn't standing in one of the regions the scene does have). */
  mode: 'region' | 'line-of-sight';
}

/**
 * The default token set for start-combat when no explicit token list is given: the party, plus
 * only the hostile, non-hidden tokens that are actually near the party -- sharing a Scene Region
 * with a party token when the party is standing inside one, otherwise in unobstructed line of
 * sight of a party token. This replaces the old "every token on the scene" default. Friendly and
 * neutral non-party tokens are left untouched either way (not admitted, not reported excluded --
 * they were never candidates).
 */
export function selectDefaultCombatants(
  allTokens: CombatToken[],
  deps: DefaultCombatScopeDeps
): DefaultCombatScopeResult {
  const explicitIds = new Set(
    (deps.explicitPartyRefs || [])
      .map(ref => deps.resolveRef(ref))
      .filter((id): id is string => !!id)
  );
  const party = explicitIds.size
    ? allTokens.filter(t => explicitIds.has(t.id))
    : allTokens.filter(t => t.actorType === 'character');
  const partyIds = new Set(party.map(t => t.id));

  const hostiles = allTokens.filter(
    t => t.disposition === TOKEN_DISPOSITION_HOSTILE && !partyIds.has(t.id)
  );

  const partyRegionIds = new Set<string>();
  if (deps.regionsExistOnScene) {
    for (const p of party) {
      for (const rid of deps.tokenRegionIds(p)) partyRegionIds.add(rid);
    }
  }
  const mode: 'region' | 'line-of-sight' = partyRegionIds.size > 0 ? 'region' : 'line-of-sight';

  const admitted: CombatToken[] = [];
  const excluded: ExcludedHostile[] = [];
  for (const h of hostiles) {
    if (h.hidden) {
      excluded.push({ token: h, reason: 'hidden' });
      continue;
    }
    if (mode === 'region') {
      const shares = deps.tokenRegionIds(h).some(rid => partyRegionIds.has(rid));
      if (shares) admitted.push(h);
      else excluded.push({ token: h, reason: 'out-of-room' });
    } else {
      const visible = party.some(p => deps.hasLineOfSight(p, h));
      if (visible) admitted.push(h);
      else excluded.push({ token: h, reason: 'no-line-of-sight' });
    }
  }

  return { party, admitted, excluded, mode };
}

/** Formats a scoping result for the tool's JSON reply, so the caller's log can show exactly which
 * tokens were admitted and which hostiles were excluded and why. */
export function formatScopingSummary(result: DefaultCombatScopeResult): {
  mode: DefaultCombatScopeResult['mode'];
  party: { id: string; name?: string | undefined }[];
  admitted: { id: string; name?: string | undefined }[];
  excluded: { id: string; name?: string | undefined; reason: ExclusionReason }[];
} {
  const brief = (t: CombatToken) => ({ id: t.id, name: t.name });
  return {
    mode: result.mode,
    party: result.party.map(brief),
    admitted: result.admitted.map(brief),
    excluded: result.excluded.map(e => ({ ...brief(e.token), reason: e.reason })),
  };
}
