import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface WallLightingToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

/**
 * Wall/lighting provisioning tools (Phase E board-prep, the audited gap: no wall/light tools
 * existed anywhere in the fork before this). Adventure-agnostic: these tools take whatever
 * geometry/config data the caller supplies and never reference any specific module or adventure.
 *
 * Follows the exact same shape as SceneManagementTools (0002): module handler under
 * foundry-mcp-bridge.<name>, raw result forwarded through backend.ts's single content-wrap --
 * these methods deliberately do NOT self-wrap in {content:[...]}, so results are single-wrapped
 * like the majority of tools in this file, not double-wrapped like the newer combat tools.
 *
 * Field names (c/move/sight/sound/door/ds/dir/threshold for walls; x/y/config for lights;
 * tokenVision/environment/fog for scenes) are the real v13 WallDocument/AmbientLightDocument/
 * Scene schema names, verified against the official v13 API docs -- see bridge/README.md's 0004
 * entry for the citation trail.
 */
export class WallLightingTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: WallLightingToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WallLightingTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'walls-create',
        description:
          'Create one or more walls on a scene in a single batched call. Each wall needs "c": [x1,y1,x2,y2] (the wall segment); move/sight/sound/light/dir/door/ds/doorSound/threshold are the same field names Foundry\'s own Wall Configuration sheet writes. Returns the created count and ids.',
        inputSchema: {
          type: 'object',
          properties: {
            sceneId: {
              type: 'string',
              description: 'Scene id or name (same locator scene-update uses) to add walls to.',
            },
            walls: {
              type: 'array',
              description: 'Walls to create, applied in one batch.',
              items: {
                type: 'object',
                properties: {
                  c: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 4,
                    maxItems: 4,
                    description: 'Wall coordinates [x1, y1, x2, y2].',
                  },
                  move: {
                    type: 'number',
                    description:
                      'Movement restriction: NONE=0, NORMAL=20 (CONST.WALL_MOVEMENT_TYPES).',
                  },
                  sight: {
                    type: 'number',
                    description:
                      'Sight restriction: NONE=0, LIMITED=10, NORMAL=20, PROXIMITY=30, DISTANCE=40 (CONST.WALL_SENSE_TYPES).',
                  },
                  sound: {
                    type: 'number',
                    description: 'Sound restriction, same enum as sight (CONST.WALL_SENSE_TYPES).',
                  },
                  light: {
                    type: 'number',
                    description:
                      'Illumination restriction, same enum as sight (CONST.WALL_SENSE_TYPES).',
                  },
                  dir: {
                    type: 'number',
                    description:
                      'Direction of effect: BOTH=0, LEFT=1, RIGHT=2 (CONST.WALL_DIRECTIONS).',
                  },
                  door: {
                    type: 'number',
                    description: 'Door type: NONE=0, DOOR=1, SECRET=2 (CONST.WALL_DOOR_TYPES).',
                  },
                  ds: {
                    type: 'number',
                    description:
                      'Door state (only meaningful when door != 0): CLOSED=0, OPEN=1, LOCKED=2 (CONST.WALL_DOOR_STATES).',
                  },
                  doorSound: { type: 'string', description: 'Door sound effect key, if any.' },
                  threshold: {
                    type: 'object',
                    description:
                      'Proximity/distance threshold config for the sense restrictions above.',
                    properties: {
                      light: { type: 'number' },
                      sight: { type: 'number' },
                      sound: { type: 'number' },
                      attenuation: { type: 'boolean' },
                    },
                  },
                },
                required: ['c'],
              },
            },
          },
          required: ['sceneId', 'walls'],
        },
      },
      {
        name: 'walls-delete',
        description:
          'Delete walls from a scene by id, in a single batched call. Idempotent: ids that no longer exist are reported back under notFoundIds rather than causing an error, so a re-prep pass can safely replace a prior draft.',
        inputSchema: {
          type: 'object',
          properties: {
            sceneId: { type: 'string', description: 'Scene id or name to delete walls from.' },
            ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Wall ids to delete, as returned by walls-create or list-walls.',
            },
          },
          required: ['sceneId', 'ids'],
        },
      },
      {
        name: 'list-walls',
        description:
          'List the walls on a scene, with their coordinates/restriction fields and the bounding box (minX/minY/maxX/maxY) spanned by all of them.',
        inputSchema: {
          type: 'object',
          properties: {
            sceneId: { type: 'string', description: 'Scene id or name to list walls for.' },
          },
          required: ['sceneId'],
        },
      },
      {
        name: 'lights-create',
        description:
          'Create one or more ambient lights on a scene in a single batched call. Each light needs numeric "x"/"y"; "config" carries the LightData appearance fields (bright, dim, angle, color, alpha, luminosity, saturation, contrast, shadows, attenuation, animation, darkness, ...), the same names Foundry\'s own Light Configuration sheet writes. Returns the created count and ids.',
        inputSchema: {
          type: 'object',
          properties: {
            sceneId: {
              type: 'string',
              description: 'Scene id or name (same locator scene-update uses) to add lights to.',
            },
            lights: {
              type: 'array',
              description: 'Lights to create, applied in one batch.',
              items: {
                type: 'object',
                properties: {
                  x: { type: 'number', description: 'Light origin x-coordinate.' },
                  y: { type: 'number', description: 'Light origin y-coordinate.' },
                  rotation: { type: 'number' },
                  elevation: { type: 'number' },
                  hidden: { type: 'boolean' },
                  walls: {
                    type: 'boolean',
                    description: 'Whether this light is constrained by walls (default true).',
                  },
                  vision: {
                    type: 'boolean',
                    description: 'Whether this light also provides a source of vision.',
                  },
                  config: {
                    type: 'object',
                    description:
                      'LightData appearance fields, passed through as Foundry defines them.',
                    properties: {
                      bright: { type: 'number' },
                      dim: { type: 'number' },
                      angle: { type: 'number' },
                      color: { type: ['string', 'null'] },
                      alpha: { type: 'number' },
                      luminosity: { type: 'number' },
                      saturation: { type: 'number' },
                      contrast: { type: 'number' },
                      shadows: { type: 'number' },
                      attenuation: { type: 'number' },
                    },
                  },
                },
                required: ['x', 'y'],
              },
            },
          },
          required: ['sceneId', 'lights'],
        },
      },
      {
        name: 'lights-delete',
        description:
          'Delete ambient lights from a scene by id, in a single batched call. Idempotent: ids that no longer exist are reported back under notFoundIds rather than causing an error, so a re-prep pass can safely replace a prior draft.',
        inputSchema: {
          type: 'object',
          properties: {
            sceneId: { type: 'string', description: 'Scene id or name to delete lights from.' },
            ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Light ids to delete, as returned by lights-create or list-lights.',
            },
          },
          required: ['sceneId', 'ids'],
        },
      },
      {
        name: 'list-lights',
        description:
          'List the ambient lights on a scene, with their position/config fields and the bounding box (minX/minY/maxX/maxY) spanned by all of their positions.',
        inputSchema: {
          type: 'object',
          properties: {
            sceneId: { type: 'string', description: 'Scene id or name to list lights for.' },
          },
          required: ['sceneId'],
        },
      },
    ];
  }

  async handleWallsCreate(args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.walls-create', {
      sceneId: args?.sceneId,
      walls: args?.walls,
    });
  }

  async handleWallsDelete(args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.walls-delete', {
      sceneId: args?.sceneId,
      ids: args?.ids,
    });
  }

  async handleListWalls(args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.list-walls', {
      sceneId: args?.sceneId,
    });
  }

  async handleLightsCreate(args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.lights-create', {
      sceneId: args?.sceneId,
      lights: args?.lights,
    });
  }

  async handleLightsDelete(args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.lights-delete', {
      sceneId: args?.sceneId,
      ids: args?.ids,
    });
  }

  async handleListLights(args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.list-lights', {
      sceneId: args?.sceneId,
    });
  }
}
