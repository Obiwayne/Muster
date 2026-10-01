import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MusterConfig } from '../types.js';
import { vellumStatus } from './vellum.js';

const cfg = (vellum?: MusterConfig['vellum']) => ({ vellum }) as MusterConfig;
const fake = fileURLToPath(new URL('./fixtures/fake-vellum.mjs', import.meta.url));

describe('vellumStatus', () => {
  it('parses JSON files from list_files', async () => {
    const s = await vellumStatus(cfg({ command: 'x', args: [] }), async () => '[{"id":"A"}]');
    expect(s).toEqual({ configured: true, connected: true, files: [{ id: 'A' }] });
  });
  it('keeps non-JSON text', async () => {
    expect((await vellumStatus(cfg({ command: 'x', args: [] }), async () => 'hello')).files).toBe('hello');
  });
  it('reports a failing call as not connected', async () => {
    const s = await vellumStatus(cfg({ command: 'x', args: [] }), async () => { throw new Error('Vellum app is not running'); });
    expect(s).toMatchObject({ configured: true, connected: false, error: 'Vellum app is not running', files: [] });
  });
  it('talks to a real MCP server over stdio', async () => {
    const s = await vellumStatus(cfg({ command: process.execPath, args: [fake] }));
    expect(s).toMatchObject({ connected: true, files: [{ id: 'F1' }] });
  });
});
