import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCESS_TTL_MS, AUTH_CODE_TTL_MS, CLAUDE_CALLBACK, LOCK_MS, allowedRedirect } from './oauth.js';
import { startRemote, type Remote, type RemoteContext } from './remote.js';
import { fakeState } from './testfakes.js';

const PUBLIC = 'muster.example.test';
const CIMD_ID = 'https://claude.ai/oauth/mcp-client-metadata';
let dir: string;
let remote: Remote;
let clock = Date.parse('2026-10-05T12:00:00.000Z');
let metadataFetches = 0;

const ctx: RemoteContext = {
  projects: async () => [{ id: 'p1', name: 'StarCut', root: '/x', running: true, port: 1 }],
  state: async () => ({ state: fakeState([]), config: { projectName: 'StarCut' } as never, paused: false }),
  needs: async () => ({ projects: [], items: [] }),
};

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: any;
}

function http(method: string, path: string, opts: { host?: string; form?: Record<string, string>; json?: unknown; bearer?: string; ip?: string } = {}): Promise<Res> {
  return new Promise((ok, fail) => {
    const body = opts.form ? new URLSearchParams(opts.form).toString() : opts.json !== undefined ? JSON.stringify(opts.json) : '';
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${remote.port}`, accept: 'application/json, text/event-stream' };
    if (opts.form) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (opts.json !== undefined) headers['content-type'] = 'application/json';
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (opts.ip) headers['cf-connecting-ip'] = opts.ip;
    const req = request({ host: '127.0.0.1', port: remote.port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* html */
        }
        ok({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', fail);
    req.end(body);
  });
}

const audit = () => readFileSync(join(dir, 'remote.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const base = () => `http://127.0.0.1:${remote.port}`;
const listTools = (bearer: string, host?: string) => http('POST', '/mcp', { host, bearer, json: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });

async function register(name = 'Claude'): Promise<string> {
  const r = await http('POST', '/register', { json: { client_name: name, redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none' } });
  expect(r.status).toBe(201);
  return r.json.client_id;
}

function authParams(clientId: string, challenge: string, extra: Record<string, string> = {}): Record<string, string> {
  return { client_id: clientId, redirect_uri: CLAUDE_CALLBACK, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', resource: `${base()}/mcp`, ...extra };
}

/** Consent with a fresh desktop code → the authorization code from the redirect. */
async function consent(clientId: string, challenge: string): Promise<string> {
  const { code } = remote.auth.issueCode();
  const r = await http('POST', '/authorize', { form: { ...authParams(clientId, challenge), code, decision: 'allow' } });
  expect(r.status).toBe(302);
  const loc = new URL(String(r.headers.location));
  expect(`${loc.origin}${loc.pathname}`).toBe(CLAUDE_CALLBACK);
  expect(loc.searchParams.get('state')).toBe('st8');
  return loc.searchParams.get('code')!;
}

async function connect(clientId?: string): Promise<{ access: string; refresh: string; clientId: string }> {
  const id = clientId ?? (await register());
  const { verifier, challenge } = pkce();
  const code = await consent(id, challenge);
  const t = await http('POST', '/token', { form: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: id, redirect_uri: CLAUDE_CALLBACK, resource: `${base()}/mcp` } });
  expect(t.status).toBe(200);
  return { access: t.json.access_token, refresh: t.json.refresh_token, clientId: id };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'muster-oauth-'));
  remote = await startRemote(ctx, {
    port: 0,
    publicHost: PUBLIC,
    pcName: 'Obi',
    dir,
    now: () => new Date(clock),
    fetchMetadata: async (url) => {
      metadataFetches++;
      if (url !== CIMD_ID) throw new Error('not found');
      return { client_id: CIMD_ID, client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK, 'https://evil.example/cb'] };
    },
  });
});

beforeEach(() => {
  clock += LOCK_MS + 60_000; // every test starts unlocked, with any old code expired
  remote.auth.revoke();
});

afterAll(async () => {
  await remote.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('remote OAuth: discovery and clients', () => {
  it('answers /mcp without a token with 401 pointing at the resource metadata', async () => {
    const r = await listTools('');
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toBe(`Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('serves resource and authorization server metadata (CIMD + PKCE S256 + public clients)', async () => {
    const pr = await http('GET', '/.well-known/oauth-protected-resource/mcp');
    expect(pr.json).toMatchObject({ resource: `${base()}/mcp`, authorization_servers: [base()] });
    const tunnel = await http('GET', '/.well-known/oauth-protected-resource', { host: PUBLIC });
    expect(tunnel.json.resource).toBe(`https://${PUBLIC}/mcp`);
    const as = await http('GET', '/.well-known/oauth-authorization-server');
    expect(as.json).toMatchObject({
      issuer: base(),
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
  });

  it('DCR accepts only claude.ai or loopback redirect URIs', async () => {
    expect(allowedRedirect('http://localhost:53682/callback')).toBe(true);
    expect(allowedRedirect('http://127.0.0.1:9/cb')).toBe(true);
    expect(allowedRedirect('https://claude.ai.evil.example/api/mcp/auth_callback')).toBe(false);
    const bad = await http('POST', '/register', { json: { redirect_uris: ['https://evil.example/cb'] } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('invalid_redirect_uri');
    expect(await register()).toMatch(/^mc_/);
  });
});

describe('remote OAuth: the consent page and the desktop code', () => {
  it('shows the client and PC, escaping the client name', async () => {
    const id = await register('<img src=x onerror=alert(1)>');
    const r = await http('GET', `/authorize?${new URLSearchParams(authParams(id, pkce().challenge))}`);
    expect(r.status).toBe(200);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(r.text).not.toContain('<img');
    expect(r.text).toContain('Muster on <b>Obi</b>');
  });

  it('refuses a redirect_uri the client did not register, without redirecting', async () => {
    const id = await register();
    const r = await http('GET', `/authorize?${new URLSearchParams(authParams(id, pkce().challenge, { redirect_uri: 'http://localhost:1/cb' }))}`);
    expect(r.status).toBe(400);
    expect(r.headers.location).toBeUndefined();
  });

  it('a code works once, a new code kills the old one, and codes expire after 2 minutes; failures are logged', async () => {
    const id = await register();
    const { challenge } = pkce();
    const form = (code: string) => ({ ...authParams(id, challenge), code, decision: 'allow' });

    const first = remote.auth.issueCode();
    expect(first.display).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    expect(Date.parse(first.expiresAt) - clock).toBe(2 * 60_000);
    const second = remote.auth.issueCode();
    const old = await http('POST', '/authorize', { form: form(first.code), ip: '160.79.104.9' });
    expect(old.status).toBe(401);
    expect(old.text).toContain('Wrong code');

    expect((await http('POST', '/authorize', { form: form(second.display.toLowerCase()) })).status).toBe(302); // dash and case don't matter
    const again = await http('POST', '/authorize', { form: form(second.code) });
    expect(again.status).toBe(401); // single use

    const late = remote.auth.issueCode();
    clock += 2 * 60_000 + 1;
    const expired = await http('POST', '/authorize', { form: form(late.code) });
    expect(expired.text).toContain('expired');

    const fails = audit().filter((l) => l.event === 'login_failed');
    expect(fails.some((l) => l.reason === 'wrong' && l.ip === '160.79.104.9' && l.client === 'Claude')).toBe(true);
    expect(fails.some((l) => l.reason === 'expired')).toBe(true);
    expect(audit().some((l) => l.event === 'login_ok')).toBe(true);
  });

  it('5 wrong codes in a minute lock logins for 10 minutes, even for the right code', async () => {
    const id = await register();
    const { challenge } = pkce();
    for (let i = 0; i < 5; i++) await http('POST', '/authorize', { form: { ...authParams(id, challenge), code: 'AAAAAA', decision: 'allow' } });
    expect(remote.status().loginLocked).toBe(true);
    const good = remote.auth.issueCode();
    const r = await http('POST', '/authorize', { form: { ...authParams(id, challenge), code: good.code, decision: 'allow' } });
    expect(r.status).toBe(401);
    expect(r.text).toContain('locked');
    expect(audit().some((l) => l.event === 'login_failed' && l.lockedUntil)).toBe(true);
    expect(audit().some((l) => l.event === 'login_failed' && l.reason === 'locked')).toBe(true);
    clock += LOCK_MS + 1;
    expect(remote.status().loginLocked).toBe(false);
    await consent(id, challenge);
  });

  it('Cancel sends access_denied back to the client', async () => {
    const id = await register();
    const r = await http('POST', '/authorize', { form: { ...authParams(id, pkce().challenge), decision: 'deny' } });
    expect(r.status).toBe(302);
    expect(String(r.headers.location)).toContain('error=access_denied');
  });
});

describe('remote OAuth: tokens', () => {
  it('needs the right PKCE verifier; an authorization code works once; failures are logged', async () => {
    const id = await register();
    const { verifier, challenge } = pkce();
    const code = await consent(id, challenge);
    const bad = await http('POST', '/token', { form: { grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), client_id: id, redirect_uri: CLAUDE_CALLBACK } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('invalid_grant');
    // the failed attempt burned the code
    const retry = await http('POST', '/token', { form: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: id, redirect_uri: CLAUDE_CALLBACK } });
    expect(retry.status).toBe(400);
    expect(audit().some((l) => l.event === 'login_failed' && l.reason === 'bad_pkce')).toBe(true);
    expect(audit().some((l) => l.event === 'login_failed' && l.reason === 'bad_code')).toBe(true);
  });

  it('authorization codes expire after a minute', async () => {
    const id = await register();
    const { verifier, challenge } = pkce();
    const code = await consent(id, challenge);
    clock += AUTH_CODE_TTL_MS + 1;
    const r = await http('POST', '/token', { form: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: id, redirect_uri: CLAUDE_CALLBACK } });
    expect(r.status).toBe(400);
  });

  it('an access token opens /mcp for its own resource only, and expires after an hour', async () => {
    const { access } = await connect();
    expect(access).toMatch(/^mra_/);
    const ok = await listTools(access);
    expect(ok.status).toBe(200);
    expect(ok.json.result.tools.map((t: { name: string }) => t.name)).toContain('muster_status');
    expect((await listTools(access, PUBLIC)).status).toBe(401); // issued for the local URL, not the tunnel's
    expect(remote.status().connections).toHaveLength(1);
    clock += ACCESS_TTL_MS + 1;
    expect((await listTools(access)).status).toBe(401);
  });

  it('refresh rotates both tokens; reusing an old refresh token revokes the connection', async () => {
    const { access, refresh, clientId } = await connect();
    const r1 = await http('POST', '/token', { form: { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId } });
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(refresh);
    expect((await listTools(access)).status).toBe(401);
    expect((await listTools(r1.json.access_token)).status).toBe(200);

    const replay = await http('POST', '/token', { form: { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId } });
    expect(replay.status).toBe(400);
    expect((await listTools(r1.json.access_token)).status).toBe(401);
    expect(remote.status().connections).toHaveLength(0);
    expect(audit().some((l) => l.event === 'revoked' && l.reason === 'refresh token reused')).toBe(true);
  });

  it('the desktop revokes one connection, or all, in one call', async () => {
    const a = await connect();
    const b = await connect();
    const [first] = remote.status().connections;
    expect(remote.auth.revoke(first.id)).toBe(1);
    const alive = [await listTools(a.access), await listTools(b.access)].filter((r) => r.status === 200);
    expect(alive).toHaveLength(1);
    expect(remote.auth.revoke()).toBe(1);
    expect((await listTools(a.access)).status).toBe(401);
    expect((await listTools(b.access)).status).toBe(401);
    expect(remote.status().connections).toEqual([]);
    // a revoked connection can't refresh either
    expect((await http('POST', '/token', { form: { grant_type: 'refresh_token', refresh_token: b.refresh } })).status).toBe(400);
  });

  it('stores only hashes on disk', async () => {
    const { access, refresh } = await connect();
    const file = readFileSync(join(dir, 'remote.json'), 'utf8');
    expect(file).not.toContain(access);
    expect(file).not.toContain(refresh);
    expect(JSON.stringify(audit())).not.toContain(access);
  });

  it('CIMD: a URL client_id is read from its metadata document; disallowed redirects in it are dropped', async () => {
    const before = metadataFetches;
    const { access } = await connect(CIMD_ID);
    expect((await listTools(access)).status).toBe(200);
    expect(metadataFetches).toBe(before + 1); // cached for the token step and later logins
    const evil = await http('GET', `/authorize?${new URLSearchParams(authParams(CIMD_ID, pkce().challenge, { redirect_uri: 'https://evil.example/cb' }))}`);
    expect(evil.status).toBe(400);
    const unknown = await http('GET', `/authorize?${new URLSearchParams(authParams('https://nope.example/meta', pkce().challenge))}`);
    expect(unknown.status).toBe(400);
  });
});
