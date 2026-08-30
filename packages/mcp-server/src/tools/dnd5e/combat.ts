import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

interface CombatToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

/**
 * D&D 5E combat tools (Phase 1). The LLM decides intent ("goblin attacks Tulkas with its
 * scimitar"); Midi-QOL in Foundry rolls the attack, checks the hit, rolls + applies damage.
 * These call module handlers registered in foundry-module/src/queries.ts.
 */
export class CombatTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor(options: CombatToolsOptions) {
    this.foundryClient = options.foundryClient;
    this.logger = options.logger;
  }

  private wrap(result: any) {
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  async handleDiagEval(args: { js: string }) {
    return this.wrap(await this.foundryClient.query('foundry-mcp-bridge.diagEval', { js: args?.js }));
  }

  getToolDefinitions() {
    return [
      { name: 'diag-eval', description: 'INTERNAL diagnostic: run JS in the GM browser and return the JSON result.', inputSchema: { type: 'object', properties: { js: { type: 'string' } }, required: ['js'] } },
      {
        name: 'start-combat',
        description:
          'Begin a combat encounter on the active scene. Adds the given tokens (by name or id) as combatants and rolls initiative; if no tokens are given, adds all tokens on the scene. Returns the initiative order.',
        inputSchema: {
          type: 'object',
          properties: {
            tokens: {
              type: 'array',
              items: { type: 'string' },
              description: 'Token names or ids to add to combat. Omit to add all tokens on the scene.',
            },
          },
        },
      },
      {
        name: 'end-combat',
        description: 'End the active combat encounter.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'next-turn',
        description: 'Advance the active combat to the next turn. Returns the current combatant.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get-combat-state',
        description:
          'Get the current combat state: round, whose turn it is, and the initiative order with each combatant\'s HP.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'execute-attack',
        description:
          'Resolve an attack. The Foundry engine (Midi-QOL) rolls the attack vs the target\'s AC, rolls damage on a hit, and applies it automatically. Provide the attacker token (name or id), the weapon/attack item name on that attacker, and the target token(s) (name or id). Returns the damage applied and each target\'s HP before/after.',
        inputSchema: {
          type: 'object',
          properties: {
            attacker: { type: 'string', description: 'Attacker token name or id on the active scene.' },
            item: { type: 'string', description: 'Name of the weapon/attack item on the attacker (e.g. "Scimitar").' },
            targets: {
              type: 'array',
              items: { type: 'string' },
              description: 'Target token name(s) or id(s).',
            },
          },
          required: ['attacker', 'item', 'targets'],
        },
      },
    ];
  }

  async handleStartCombat(args: any) {
    return this.wrap(await this.foundryClient.query('foundry-mcp-bridge.startCombat', { tokens: args?.tokens }));
  }
  async handleEndCombat(_args: any) {
    return this.wrap(await this.foundryClient.query('foundry-mcp-bridge.endCombat', {}));
  }
  async handleNextTurn(_args: any) {
    return this.wrap(await this.foundryClient.query('foundry-mcp-bridge.nextTurn', {}));
  }
  async handleGetCombatState(_args: any) {
    return this.wrap(await this.foundryClient.query('foundry-mcp-bridge.getCombatState', {}));
  }
  async handleExecuteAttack(args: any) {
    return this.wrap(
      await this.foundryClient.query('foundry-mcp-bridge.executeAttack', {
        attacker: args?.attacker,
        item: args?.item,
        targets: args?.targets || [],
      })
    );
  }
}
