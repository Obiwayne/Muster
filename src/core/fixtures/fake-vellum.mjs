// Minimal stand-in for the Vellum MCP server: list_files only.
// FAKE_PID_FILE: write our pid there. FAKE_HANG=1: never answer list_files. FAKE_FILES: the text list_files returns.
import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
const server = new McpServer({ name: 'fake-vellum', version: '0' });
server.registerTool('list_files', { description: 'files' }, async () => {
  if (process.env.FAKE_HANG) await new Promise(() => {});
  return { content: [{ type: 'text', text: process.env.FAKE_FILES ?? JSON.stringify([{ id: 'F1', name: 'Wall', pages: [{}, {}], updatedAt: 1700000000000 }]) }] };
});
await server.connect(new StdioServerTransport());
