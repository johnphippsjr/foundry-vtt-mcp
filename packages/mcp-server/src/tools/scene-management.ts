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
          'Import one scene from an installed package into the world (the adoption lane). For an Adventure-document ref, this imports the WHOLE Adventure entry\'s scene set in one batch (never just the one scene) so cross-scene references (e.g. a region teleport to a sibling floor) resolve, then imports any actors the scene\'s tokens need from other Adventure documents in the same module (or a module it requires). Idempotent: a repeat call for a scene already adopted from this pack returns it unchanged rather than re-importing. All-or-nothing: if anything is still unresolved, every document this call created (scenes, actors, and any other document type it made) is deleted again before the reply is sent, so a failed import never leaves broken half-imported scenes behind for a user to find and clean up by hand -- reused/already-adopted documents from an earlier call are never touched. Provide the package id and the scene "ref" string exactly as returned by list-installed-packages. Returns {success, scene_id, scene_name, reused, imported:{scenes,actors}, unresolved:{scene_refs,actor_ids}, error, cleanup?}; success is false if anything is still unresolved, with error naming it; cleanup ({deleted:[{type,id}], failed:[{id,type,error}]}) is present only when something was rolled back -- failed lists, by id, anything the rollback itself could not remove.',
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
          },
          required: ['package', 'scene_ref'],
        },
      },
      {
        name: 'scene-integrity',
        description:
          "Read-only check of a scene already in the world: walks its regions/behaviors for unresolved Scene-uuid references and diffs its tokens' actorIds against game.actors, WITHOUT importing or creating anything. Use this to check a world that was built before this fix, or as a standing gate. Returns the same {success, scene_id, scene_name, unresolved:{scene_refs,actor_ids}, error} shape as adventure-import (reused is always true, imported is always empty since nothing is imported).",
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
    });
  }

  async handleSceneIntegrity(args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.scene-integrity', {
      scene_id: args?.scene_id,
      scene_identifier: args?.scene_identifier,
    });
  }
}
