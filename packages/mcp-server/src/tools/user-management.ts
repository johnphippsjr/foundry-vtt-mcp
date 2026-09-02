import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface UserManagementToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

/**
 * User provisioning tools for the brain's join flow (Phase D). Deliberately scoped: these tools
 * can only create/see PLAYER and TRUSTED accounts. They exist so an invite-code join can seat a
 * player with their own Foundry login and character binding -- never to hand out GM access.
 * user-create and the role field on every tool refuse ASSISTANT(3) and GAMEMASTER(4) outright.
 *
 * Same pattern as the Phase B scene tools: module handler under foundry-mcp-bridge.<name>, raw
 * result forwarded through backend.ts's single content-wrap (no self-wrapping here).
 */
export class UserManagementTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: UserManagementToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'UserManagementTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'user-create',
        description:
          "Create a new Foundry VTT user for the join flow (seating a player who redeemed an invite code). Player-role scoping is deliberate: role must be PLAYER or TRUSTED -- this tool REFUSES to create an ASSISTANT or GAMEMASTER account, with a clear error, and never grants GM access. Returns the new user's id and name.",
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Login name for the new user.' },
            password: { type: 'string', description: 'Password to set on the new user.' },
            role: {
              description:
                'PLAYER or TRUSTED only (by name or Foundry role number 1/2). Any other value (including ASSISTANT/3 or GAMEMASTER/4) is refused.',
              oneOf: [
                { type: 'string', enum: ['PLAYER', 'TRUSTED'] },
                { type: 'number', enum: [1, 2] },
              ],
            },
          },
          required: ['name', 'password', 'role'],
        },
      },
      {
        name: 'user-update',
        description:
          "Update an existing Foundry VTT user for the join flow: set a new password and/or bind/clear their assigned character (user.character). Partial update -- only the fields you provide change. For the join flow's player-role users only; does not change a user's role.",
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'User id to update.' },
            password: { type: 'string', description: 'New password to set.' },
            character_id: {
              type: 'string',
              description:
                "Actor id to bind as this user's character (sets user.character). Pass an empty string to clear the binding.",
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'list-users',
        description:
          'List every user in the world with their numeric Foundry role AND its name (NONE/PLAYER/TRUSTED/ASSISTANT/GAMEMASTER), active/connected state, and their bound character id if any. Use this to verify a join-flow provisioning step: the new user exists, has the right role, and is bound to the right character.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'user-delete',
        description:
          'Delete a user -- for test-fixture teardown of throwaway join-flow accounts. Refuses to delete a GAMEMASTER-role user; this tool can never be used to remove a GM.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'User id to delete.' },
          },
          required: ['id'],
        },
      },
    ];
  }

  async handleUserCreate(args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.user-create', {
      name: args?.name,
      password: args?.password,
      role: args?.role,
    });
  }

  async handleUserUpdate(args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.user-update', {
      id: args?.id,
      password: args?.password,
      character_id: args?.character_id,
    });
  }

  async handleListUsers(_args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.list-users', {});
  }

  async handleUserDelete(args: any): Promise<any> {
    return await this.foundryClient.query('foundry-mcp-bridge.user-delete', {
      id: args?.id,
    });
  }
}
