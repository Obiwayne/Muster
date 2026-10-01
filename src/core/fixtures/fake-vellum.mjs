// Minimal stand-in for the Vellum MCP server: list_files only.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server = new McpServer({ name: 'fake-vellum', version: '0' });
server.registerTool('list_files', { description: 'files' }, async () => ({
  content: [{ type: 'text', text: JSON.stringify([{ id: 'F1', name: 'Wall', updatedAt: 1 }]) }],
}));
await server.connect(new StdioServerTransport());
