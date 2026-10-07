// muster-mcp entry: `node dist/mcp/index.js` (stdio). Role and identity come from the environment.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Role } from '../types.js';
import { createMusterServer } from './server.js';

const envRole = process.env.MUSTER_ROLE;
const role: Role = envRole === 'captain' || envRole === 'design' || envRole === 'research' || envRole === 'qa' || envRole === 'media' ? envRole : 'crew';
const agentId = process.env.MUSTER_AGENT || (role === 'captain' ? 'captain' : 'unknown');

const server = createMusterServer({ role, agentId });
await server.connect(new StdioServerTransport());
