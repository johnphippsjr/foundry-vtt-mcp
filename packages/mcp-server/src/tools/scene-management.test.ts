/**
 * scene-management MCP tool layer tests (adventure-import / scene-integrity, board #1311).
 *
 * The real import/resolution logic runs browser-side (foundry-module/src/queries.ts,
 * adventure-import-utils.ts -- see that package's own vitest suite), so these cover only the MCP
 * tool layer: the tool is advertised with the documented return shape, and a call forwards the
 * caller's args to the bridge query unchanged (field names are a fixed contract the ingest-side
 * worker codes against directly).
 */

import { describe, it, expect, vi } from 'vitest';
import { SceneManagementTools } from './scene-management.js';

function makeTools(queryImpl?: (method: string, data: any) => unknown) {
  const query = vi.fn(queryImpl ?? (async () => ({ success: true })));
  const logger: any = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: () => logger };
  const foundryClient: any = { query };
  const tools = new SceneManagementTools({ foundryClient, logger });
  return { tools, query };
}

describe('adventure-import tool', () => {
  it('is advertised with package and scene_ref required', () => {
    const { tools } = makeTools();
    const def = tools.getToolDefinitions().find(d => d.name === 'adventure-import');
    expect(def).toBeDefined();
    expect(def!.inputSchema.required).toEqual(['package', 'scene_ref']);
  });

  it('forwards package and scene_ref unchanged to the bridge query', async () => {
    const { tools, query } = makeTools();
    await tools.handleAdventureImport({
      package: 'curse-of-strahd-by-claygolem.cos-scenes',
      scene_ref: 'Scene.curse-of-strahd-by-claygolem.cos-scenes.abc123.def456',
    });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.adventure-import', {
      package: 'curse-of-strahd-by-claygolem.cos-scenes',
      scene_ref: 'Scene.curse-of-strahd-by-claygolem.cos-scenes.abc123.def456',
      // board #1714: scenes-only by default; actor creation is opt-in and always sent explicitly
      import_missing_actors: false,
    });
  });

  it('forwards import_missing_actors only when it is exactly true (board #1714)', async () => {
    const { tools, query } = makeTools();
    await tools.handleAdventureImport({
      package: 'p',
      scene_ref: 'a.b.c.d',
      import_missing_actors: true,
    });
    await tools.handleAdventureImport({
      package: 'p',
      scene_ref: 'a.b.c.d',
      import_missing_actors: 'yes',
    });
    expect(query.mock.calls[0][1].import_missing_actors).toBe(true);
    expect(query.mock.calls[1][1].import_missing_actors).toBe(false);
  });

  it('advertises import_missing_actors as an optional boolean and says it never overwrites', () => {
    const { tools } = makeTools();
    const def: any = tools.getToolDefinitions().find(d => d.name === 'adventure-import');
    expect(def.inputSchema.properties.import_missing_actors.type).toBe('boolean');
    expect(def.inputSchema.required).not.toContain('import_missing_actors');
    expect(def.description).toContain('SCENES ONLY');
    expect(def.description).toContain('NEVER OVERWRITES');
    // board #1714 review: the opt-in must warn that it re-creates actors the DM deleted
    expect(def.inputSchema.properties.import_missing_actors.description).toContain(
      'deleted on purpose'
    );
    expect(def.description).toContain('deleted on purpose');
  });

  it('forwards a refusal with its conflicts list unmodified (board #1714)', async () => {
    const shape = {
      success: false,
      scene_id: null,
      scene_name: null,
      reused: false,
      imported: { scenes: [], actors: [] },
      unresolved: { scene_refs: [], actor_ids: [] },
      error: 'Refused: importing would overwrite or duplicate 1 existing world scene(s).',
      conflicts: [
        {
          scene_id: 'FBot4IT6IOGsSq8A',
          scene_name: 'Curse of Strahd: Death House',
          reason: 'id-taken-untagged',
          tagged_source: null,
          world_scene_ids: ['FBot4IT6IOGsSq8A'],
        },
      ],
    };
    const { tools } = makeTools(async () => shape);
    const result = await tools.handleAdventureImport({ package: 'p', scene_ref: 'a.b.c.d' });
    expect(result).toEqual(shape);
  });

  it('returns whatever the bridge query returns, unmodified (the fixed return contract)', async () => {
    const shape = {
      success: false,
      scene_id: 'x',
      scene_name: 'Death House',
      reused: false,
      imported: { scenes: ['x', 'y'], actors: [] },
      unresolved: { scene_refs: [], actor_ids: ['missing1'] },
      error: '1 unresolved actor id(s): missing1',
    };
    const { tools } = makeTools(async () => shape);
    const result = await tools.handleAdventureImport({ package: 'p', scene_ref: 'a.b.c.d' });
    expect(result).toEqual(shape);
  });

  it('forwards the cleanup field unmodified when the bridge rolled back a failed import (board #1311)', async () => {
    // adventure-import deletes what it created before reporting success:false (see
    // bridge/README.md's 0008 entry / queries.ts _rollbackCreatedDocuments) and reports the
    // outcome under a `cleanup` field. This tool layer must pass that through exactly like every
    // other field -- it has no business reshaping or dropping it.
    const shape = {
      success: false,
      scene_id: 'targetScene1',
      scene_name: 'Broken Tower',
      reused: false,
      imported: { scenes: ['targetScene1', 'siblingScene1'], actors: ['actorA'] },
      unresolved: { scene_refs: [], actor_ids: ['missing1'] },
      error: '1 unresolved actor id(s): missing1',
      cleanup: {
        deleted: [
          { type: 'Actor', id: 'actorA' },
          { type: 'Scene', id: 'siblingScene1' },
          { type: 'Scene', id: 'targetScene1' },
        ],
        failed: [],
      },
    };
    const { tools } = makeTools(async () => shape);
    const result = await tools.handleAdventureImport({ package: 'p', scene_ref: 'a.b.c.d' });
    expect(result).toEqual(shape);
    expect(result.cleanup.deleted).toHaveLength(3);
    expect(result.cleanup.failed).toEqual([]);
  });

  it('forwards a partially-failed cleanup unmodified, ids and errors intact', async () => {
    const shape = {
      success: false,
      scene_id: 'targetScene1',
      scene_name: 'Broken Tower',
      reused: false,
      imported: { scenes: ['targetScene1'], actors: [] },
      unresolved: {
        scene_refs: [
          {
            scene_id: 'targetScene1',
            region_id: 'r1',
            behavior_id: 'b1',
            target: 'Scene.missingSceneId12345',
          },
        ],
        actor_ids: [],
      },
      error:
        '1 unresolved scene/region reference(s): Scene.missingSceneId12345 (scene targetScene1, region r1, behavior b1)',
      cleanup: {
        deleted: [],
        failed: [{ id: 'targetScene1', type: 'Scene', error: 'Scene.targetScene1 does not exist' }],
      },
    };
    const { tools } = makeTools(async () => shape);
    const result = await tools.handleAdventureImport({ package: 'p', scene_ref: 'a.b.c.d' });
    expect(result.cleanup.failed).toEqual([
      { id: 'targetScene1', type: 'Scene', error: 'Scene.targetScene1 does not exist' },
    ]);
  });
});

describe('scene-integrity tool', () => {
  it('is advertised and takes no required fields (either locator works)', () => {
    const { tools } = makeTools();
    const def = tools.getToolDefinitions().find(d => d.name === 'scene-integrity');
    expect(def).toBeDefined();
    expect(def!.inputSchema.properties).toHaveProperty('scene_id');
    expect(def!.inputSchema.properties).toHaveProperty('scene_identifier');
  });

  it('forwards scene_id and scene_identifier unchanged to the bridge query', async () => {
    const { tools, query } = makeTools();
    await tools.handleSceneIntegrity({ scene_id: 'abc', scene_identifier: 'Death House' });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.scene-integrity', {
      scene_id: 'abc',
      scene_identifier: 'Death House',
    });
  });

  it('never imports anything on its own -- it only ever calls the read-only scene-integrity query', async () => {
    const { tools, query } = makeTools();
    await tools.handleSceneIntegrity({ scene_id: 'abc' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe('foundry-mcp-bridge.scene-integrity');
  });
});

describe('adventure-source-backfill tool (board #1714)', () => {
  it('is advertised with pack required and apply/plan_id optional', () => {
    const { tools } = makeTools();
    const def: any = tools.getToolDefinitions().find(d => d.name === 'adventure-source-backfill');
    expect(def).toBeDefined();
    expect(def.inputSchema.required).toEqual(['pack']);
    expect(def.inputSchema.properties.apply.type).toBe('boolean');
    expect(def.inputSchema.properties.plan_id.type).toBe('string');
    expect(def.description).toContain('DRY RUN BY DEFAULT');
    expect(def.description).toContain('no plan_id');
  });

  it('is a dry run unless apply is exactly true', async () => {
    const { tools, query } = makeTools();
    await tools.handleAdventureSourceBackfill({ pack: 'm.P' });
    await tools.handleAdventureSourceBackfill({ pack: 'm.P', apply: 'true' });
    await tools.handleAdventureSourceBackfill({ pack: 'm.P', apply: 1 });
    for (const call of query.mock.calls) {
      expect(call[0]).toBe('foundry-mcp-bridge.adventure-source-backfill');
      expect(call[1].apply).toBe(false);
    }
  });

  it('forwards pack, scene_ids, apply and plan_id', async () => {
    const { tools, query } = makeTools();
    await tools.handleAdventureSourceBackfill({
      pack: 'm.P',
      scene_ids: ['a', 'b'],
      apply: true,
      plan_id: 'bf-2-deadbeef',
    });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.adventure-source-backfill', {
      pack: 'm.P',
      scene_ids: ['a', 'b'],
      apply: true,
      plan_id: 'bf-2-deadbeef',
    });
  });

  it('accepts package as another name for pack, and drops a non-array scene_ids', async () => {
    const { tools, query } = makeTools();
    await tools.handleAdventureSourceBackfill({ package: 'm.P:advId', scene_ids: 'a' });
    expect(query.mock.calls[0][1]).toEqual({
      pack: 'm.P:advId',
      scene_ids: undefined,
      apply: false,
      plan_id: undefined,
    });
  });
});
