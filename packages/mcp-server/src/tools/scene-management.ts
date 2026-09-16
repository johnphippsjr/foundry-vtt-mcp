import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface SceneManagementToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

/**
 * Scene provisioning tools (Phase B board-prep + the adoption lane, decision gate 5).
 * Adventure-agnostic: these tools take whatever name/grid/flags/package data the caller
 * supplies and never reference any specific module or adventure.
 *
 * scene-create / scene-update follow the same shape the existing get-current-scene /
 * list-scenes tools already use (module handler under foundry-mcp-bridge.<name>, raw
 * result forwarded through backend.ts's single content-wrap -- these methods deliberately
 * do NOT self-wrap in {content:[...]}), so results are single-wrapped like the majority
 * of tools in this file, not double-wrapped like the newer combat tools.
 */
export class SceneManagementTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: SceneManagementToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'SceneManagementTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'scene-create',
        description:
          "Create a new Foundry VTT scene. Provide a name, an optional background image path, optional grid settings (type/size/offsetX/offsetY), and optional flags (e.g. a pipeline identity marker for idempotency). Returns the new scene's id.",
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Scene name.' },
            background: {
              type: 'string',
              description: 'Background image path/URL for the scene, if known.',
            },
            grid: {
              type: 'object',
              description: 'Grid settings to set on creation.',
              properties: {
                type: {
                  type: 'number',
                  description: 'Foundry grid type constant (e.g. 1 = square).',
                },
                size: { type: 'number', description: 'Pixels per grid cell.' },
                offsetX: { type: 'number', description: 'Grid horizontal offset in pixels.' },
                offsetY: { type: 'number', description: 'Grid vertical offset in pixels.' },
              },
            },
            flags: {
              type: 'object',
              description:
                'Arbitrary flags object to set on the scene (namespaced, e.g. {"aidm": {"pipeline": {"module": "...", "location": "...", "kind": "..."}}}).',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'scene-update',
        description:
          'Update an existing Foundry VTT scene: rename it, change its background image, write grid settings (type/size/offsetX/offsetY), merge flags (e.g. marking a scan-derived scene superseded), and/or set fog-of-war/vision fields (tokenVision, environment.globalLight/darknessLevel, fog exploration). Partial update: only the fields you provide change. Locate the scene with "id" (exact scene id) or "scene_identifier" (name or id, same lookup switch-scene uses); "name" in the payload is always the NEW name to set, never the locator.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Exact scene id to update.' },
            scene_identifier: {
              type: 'string',
              description: 'Scene name or id to locate the scene, if "id" is not given.',
            },
            name: { type: 'string', description: 'New name to set on the scene (rename).' },
            background: { type: 'string', description: 'New background image path/URL.' },
            grid: {
              type: 'object',
              description: 'Grid fields to update; only the provided sub-fields change.',
              properties: {
                type: { type: 'number' },
                size: { type: 'number' },
                offsetX: { type: 'number' },
                offsetY: { type: 'number' },
              },
            },
            flags: {
              type: 'object',
              description:
                'Flags to merge onto the scene (namespaced object); existing sibling keys under the same namespace are preserved.',
            },
            tokenVision: {
              type: 'boolean',
              description: 'Whether tokens on this scene use vision (Scene.tokenVision, v13).',
            },
            environment: {
              type: 'object',
              description:
                'Ambience/lighting fields under Scene.environment (v13 schema; replaces the old flat globalLight/darkness fields from pre-v12). Only the provided sub-fields change.',
              properties: {
                darknessLevel: {
                  type: 'number',
                  description: '0 (midday, max illumination) to 1 (midnight, max darkness).',
                },
                darknessLevelLock: { type: 'boolean' },
                cycle: { type: 'boolean', description: 'Whether darkness cycles automatically.' },
                globalLight: {
                  type: 'object',
                  description: 'Global (unconditional) light for the whole scene.',
                  properties: {
                    enabled: { type: 'boolean' },
                    bright: { type: 'boolean' },
                    alpha: { type: 'number' },
                    color: { type: ['string', 'null'] },
                  },
                },
              },
            },
            fog: {
              type: 'object',
              description: 'Fog-of-war fields under Scene.fog (v13 schema).',
              properties: {
                exploration: {
                  type: 'boolean',
                  description: 'Whether fog exploration is enabled.',
                },
                overlay: { type: ['string', 'null'], description: 'Fog overlay image path.' },
                reset: { type: ['number', 'null'], description: 'Fog reset timestamp/version.' },
                colors: {
                  type: 'object',
                  properties: {
                    explored: { type: ['string', 'null'] },
                    unexplored: { type: ['string', 'null'] },
                  },
                },
              },
            },
          },
        },
      },
      {
        name: 'list-installed-packages',
        description:
          'List installed compendium packages (Adventure-document packs and standalone Scene packs) and the scenes each one contains. Use this to discover adoptable pre-built content (the adoption lane) before importing a scene with adventure-import.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'adventure-import',
        description:
          "Import one scene from an installed package into the world (the adoption lane). SCENES ONLY: for an Adventure-document ref it imports the whole Adventure entry's scene set in one batch (so a region teleport to a sibling floor resolves) and never imports or changes any other document type (actors, items, journals, folders). NEVER OVERWRITES: if a scene in that set already exists in the world under the same id, it is reused only when it carries this package's source tags (flags.aidm.sourcePack/sourceSceneId); a scene id that belongs to a stored world scene Foundry could not load (invalid data) also blocks it; otherwise the whole call is refused with success:false, an error naming each scene, and a conflicts list, and nothing is imported or changed (run adventure-source-backfill to tag scenes adopted earlier). For a 3-part ref from a Scene pack the scene is created under a new id, and the call is refused when a world scene already has the pack scene's id without matching tags; an earlier untagged adoption under a different id cannot be detected there. Every scene it creates is tagged, so a repeat call returns it unchanged (reused:true). Actors the scene's tokens need but the world lacks are reported under unresolved.actor_ids; they are created only when import_missing_actors is true (create only, from Adventure documents in the same module or a module it requires; an existing actor, or a stored actor Foundry could not load, is never changed). Warning: this also re-creates an actor the DM deleted on purpose, if a token still points at it. Calls run one at a time. All-or-nothing: if anything is still unresolved, every document this call created is deleted again before the reply is sent; reused documents are never touched. Provide the package id and the scene \"ref\" string exactly as returned by list-installed-packages. Returns {success, scene_id, scene_name, reused, imported:{scenes,actors}, unresolved:{scene_refs,actor_ids}, invalid_actor_ids?, error, cleanup?, conflicts?}; invalid_actor_ids lists token actor ids whose stored actor Foundry could not load (never created over, and it does not make the call fail); cleanup ({deleted:[{type,id}], failed:[{id,type,error}]}) is present only when something was rolled back; conflicts ([{scene_id, scene_name, reason, tagged_source, world_scene_ids}]) is present only when the import was refused to protect existing scenes.",
        inputSchema: {
          type: 'object',
          properties: {
            package: {
              type: 'string',
              description: 'Package id, as returned by list-installed-packages.',
            },
            scene_ref: {
              type: 'string',
              description: 'Scene ref string, as returned by list-installed-packages.',
            },
            import_missing_actors: {
              type: 'boolean',
              description:
                "Default false. When true, also create actors that the imported scenes' tokens need and the world lacks (create only; an existing actor is never changed). It also re-creates an actor the DM deleted on purpose, if a token still points at it. When false, missing actors are reported under unresolved.actor_ids and the import fails and rolls back.",
            },
          },
          required: ['package', 'scene_ref'],
        },
      },
      {
        name: 'scene-integrity',
        description:
          "Read-only check of a scene already in the world: walks its regions/behaviors for unresolved Scene-uuid references and diffs its tokens' actorIds against game.actors, WITHOUT importing or creating anything. Use this to check a world that was built before this fix, or as a standing gate. Returns the same {success, scene_id, scene_name, unresolved:{scene_refs,actor_ids}, invalid_actor_ids, error} shape as adventure-import (reused is always true, imported is always empty since nothing is imported).",
        inputSchema: {
          type: 'object',
          properties: {
            scene_id: { type: 'string', description: 'Exact scene id to check.' },
            scene_identifier: {
              type: 'string',
              description: 'Scene name or id to locate the scene, if "scene_id" is not given.',
            },
          },
        },
      },
      {
        name: 'adventure-source-backfill',
        description:
          'Find world scenes that came from a scene in one installed Adventure pack but carry no source tags (adopted before the tags existed), and tag them so adventure-import reuses them instead of refusing. DRY RUN BY DEFAULT: without apply:true it only reads and reports, and changes nothing. A world scene is tagged only when it has the same id as exactly one package scene AND the same background image; weaker matches (same id but a different background, or a name/background match under a different id) are listed under needs_review and never tagged; scenes whose existing tags disagree are listed under conflicts and never changed. To write, call again with apply:true and the plan_id the dry run returned; apply refuses if the plan it rebuilds from live state has a different plan_id, and that refusal returns only a reason and the summary counts (no plan_id). plan_id is not a secret (it is a short hash of the scene ids and tags to write), so it does not prove a dry run was read; it guarantees that apply writes exactly the tag list a dry run of the current world shows, and nothing else. Apply runs one at a time with adventure-import. A pack scene whose id belongs to a stored world scene Foundry could not load is listed under conflicts. Apply writes only flags.aidm.sourcePack, sourceSceneId, adoptedFor and sourceTaggedBy. Returns {success, mode, changed, scope, pack, plan_id, summary, will_tag, already_tagged, needs_review, conflicts, next_step?, applied?:{tagged,failed}, error?}.',
        inputSchema: {
          type: 'object',
          properties: {
            pack: {
              type: 'string',
              description:
                'Adventure pack id ("module.PackName"). Also accepts a list-installed-packages package id ("module.PackName:adventureId") or a scene ref, which limits the check to that Adventure entry.',
            },
            scene_ids: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Optional. Only check (and, with apply, only tag) these world scene ids.',
            },
            apply: {
              type: 'boolean',
              description: 'Default false (dry run). true writes the tags listed under will_tag.',
            },
            plan_id: {
              type: 'string',
              description:
                'Required with apply:true. The plan_id from a dry run of this same request.',
            },
          },
          required: ['pack'],
        },
      },
    ];
  }

  async handleSceneCreate(args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.scene-create', {
      name: args?.name,
      background: args?.background,
      grid: args?.grid,
      flags: args?.flags,
    });
  }

  async handleSceneUpdate(args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.scene-update', {
      id: args?.id,
      scene_identifier: args?.scene_identifier,
      name: args?.name,
      background: args?.background,
      grid: args?.grid,
      flags: args?.flags,
      tokenVision: args?.tokenVision,
      environment: args?.environment,
      fog: args?.fog,
    });
  }

  async handleListInstalledPackages(_args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.list-installed-packages', {});
  }

  async handleAdventureImport(args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.adventure-import', {
      package: args?.package,
      scene_ref: args?.scene_ref,
      import_missing_actors: args?.import_missing_actors === true,
    });
  }

  async handleSceneIntegrity(args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.scene-integrity', {
      scene_id: args?.scene_id,
      scene_identifier: args?.scene_identifier,
    });
  }

  // Dry run unless the caller passes apply === true exactly. plan_id is forwarded untouched so the
  // browser-side handler can compare it with the plan it rebuilds from live state.
  async handleAdventureSourceBackfill(args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.adventure-source-backfill', {
      pack: args?.pack ?? args?.package,
      scene_ids: Array.isArray(args?.scene_ids) ? args.scene_ids : undefined,
      apply: args?.apply === true,
      plan_id: args?.plan_id,
    });
  }
}
