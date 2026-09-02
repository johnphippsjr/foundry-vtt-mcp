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
          'Update an existing Foundry VTT scene: rename it, change its background image, write grid settings (type/size/offsetX/offsetY), and/or merge flags (e.g. marking a scan-derived scene superseded). Partial update: only the fields you provide change. Locate the scene with "id" (exact scene id) or "scene_identifier" (name or id, same lookup switch-scene uses); "name" in the payload is always the NEW name to set, never the locator.',
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
          'Import one scene from an installed package into the world (the adoption lane). Provide the package id and the scene "ref" string exactly as returned by list-installed-packages. Returns the id of the resulting world scene.',
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
}
