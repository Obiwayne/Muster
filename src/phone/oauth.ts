// OAuth for the remote connector (docs/REMOTE.md, milestone 2): a single-owner authorization server inside the gateway.
// - Discovery: /.well-known/oauth-protected-resource[/mcp] and /.well-known/oauth-authorization-server.
// - Clients: CIMD (client_id is an https URL to a metadata document; what claude.ai prefers) or DCR (POST /register).
//   Either way every redirect URI must be claude.ai's callback or a loopback URL (Claude Code).
// - /authorize shows a consent page that asks for the code from Muster Settings → Remote access: 6 characters,
//   2 minutes, single use, a new code kills the old one. 5 wrong codes in a minute lock logins for 10 minutes.
// - /token: authorization_code (PKCE S256 required) and refresh_token (rotated; a reused old refresh token revokes the
//   whole grant). Access tokens 1 h, refresh tokens 30 d; only sha256 hashes are stored (remote.json).
// - Every failed login (wrong/expired code, lockout, bad PKCE, bad refresh) is written to the audit log.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { sameToken } from '../core/tokens.js';
import { displayCode, Pairing } from './pairing.js';
import { sha256hex, writePrivate } from './store.js';

export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
export const AUTH_CODE_TTL_MS = 60_000;
export const LOCK_MS = 10 * 60_000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 60_000;
const SCOPES = ['muster:read', 'muster:write'];
const MAX_FORM = 16 * 1024;
const MAX_CLIENTS = 50;

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  kind: 'dcr' | 'cimd';
  createdAt: string;
}

export interface Grant {
  id: string;
  clientId: string;
  clientName: string;
  scope: string;
  resource: string;
  accessHash: string;
  accessExpiresAt: string;
  refreshHash: string;
  refreshExpiresAt: string;
  /** The refresh token before the last rotation: seeing it again means it leaked, so the grant is revoked. */
  prevRefreshHash?: string;
  createdAt: string;
  lastUsedAt: string;
}

interface AuthFile {
  clients: OAuthClient[];
  grants: Grant[];
}

/** What Settings lists under Remote access: one row per connection, each with its own Disconnect. */
export interface GrantSummary {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface OAuthOptions {
  dir: string;
  pcName: string;
  now: () => Date;
  audit: (entry: Record<string, unknown>) => void;
  /** Who made the request, for the audit log. The caller decides whether a tunnel's forwarded header can be trusted
   *  (remote.ts: only for requests that came through the configured tunnel). Default: the socket address. */
  ipOf?: (req: IncomingMessage) => { ip: string; ipFrom: string };
  /** Logins just locked (5 wrong codes in a minute): tell the user on the desktop. */
  onLock?: (info: { until: string; ip: string; ipFrom: string; client: string }) => void;
  /** CIMD: fetch a client's metadata document (test seam). */
  fetchMetadata?: (url: string) => Promise<unknown>;
}

/** claude.ai's callback, or a loopback http URL on any port (Claude Code). */
export function allowedRedirect(uri: string): boolean {
  if (uri === CLAUDE_CALLBACK) return true;
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]') && !u.username && !u.password;
  } catch {
    return false;
  }
}

const b64url = (buf: Buffer) => buf.toString('base64url');
const token = (prefix: string) => `${prefix}_${b64url(randomBytes(32))}`;
const s256 = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function defaultFetchMetadata(url: string): Promise<unknown> {
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`metadata document answered ${r.status}`);
  const text = await r.text();
  if (text.length > 64 * 1024) throw new Error('metadata document too large');
  return JSON.parse(text);
}

function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_FORM) {
        fail(new OAuthError(413, 'invalid_request', 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (String(req.headers['content-type'] ?? '').includes('application/json')) {
        try {
          const v = JSON.parse(text || '{}');
          return ok(Object.fromEntries(Object.entries(v ?? {}).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)])));
        } catch {
          return fail(new OAuthError(400, 'invalid_request', 'Body is not valid JSON'));
        }
      }
      ok(Object.fromEntries(new URLSearchParams(text)));
    });
    req.on('error', fail);
  });
}

function json(res: ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(data));
}

interface PendingCode {
  clientId: string;
  clientName: string;
  redirectUri: string;
  challenge: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

export class RemoteAuth {
  private readonly file: string;
  private data: AuthFile;
  private readonly pairing: Pairing;
  private fails: number[] = [];
  private lockedUntil = 0;
  private readonly codes = new Map<string, PendingCode>();
  private readonly cimd = new Map<string, { client: OAuthClient; until: number }>();
  private lastSave = 0;

  constructor(private readonly opts: OAuthOptions) {
    this.file = join(opts.dir, 'remote.json');
    this.pairing = new Pairing(() => opts.now().getTime());
    this.data = this.load();
  }

  private load(): AuthFile {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8'));
      return { clients: Array.isArray(v.clients) ? v.clients : [], grants: Array.isArray(v.grants) ? v.grants : [] };
    } catch {
      return { clients: [], grants: [] };
    }
  }

  private save(): void {
    this.lastSave = this.t();
    writePrivate(this.file, JSON.stringify(this.data, null, 2));
  }

  private t(): number {
    return this.opts.now().getTime();
  }

  private iso(ms = this.t()): string {
    return new Date(ms).toISOString();
  }

  // ------------------------------------------------------------------ desktop (admin API)

  /** A fresh login code for the consent page; the previous one stops working. */
  issueCode(): { code: string; display: string; expiresAt: string } {
    const { code, expiresAt } = this.pairing.issue();
    this.opts.audit({ event: 'code_issued' });
    return { code, display: displayCode(code), expiresAt: this.iso(expiresAt) };
  }

  grants(): GrantSummary[] {
    const t = this.t();
    return this.data.grants.filter((g) => Date.parse(g.refreshExpiresAt) > t).map((g) => ({ id: g.id, clientName: g.clientName, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt }));
  }

  /** One connection, or every one when `id` is left out. Returns how many were revoked. */
  revoke(id?: string, reason = 'desktop'): number {
    const before = this.data.grants.length;
    this.data.grants = id ? this.data.grants.filter((g) => g.id !== id) : [];
    const n = before - this.data.grants.length;
    if (n) {
      this.save();
      this.opts.audit({ event: 'revoked', grant: id ?? 'all', count: n, reason });
    }
    return n;
  }

  /** The grant an access token belongs to, if it is live and was issued for this resource. */
  verify(accessToken: string, resource: string): Grant | null {
    const hash = sha256hex(accessToken);
    const t = this.t();
    const g = this.data.grants.find((x) => sameToken(x.accessHash, hash));
    if (!g || Date.parse(g.accessExpiresAt) <= t || g.resource !== resource) return null;
    g.lastUsedAt = this.iso(t);
    if (t - this.lastSave > 60_000) this.save();
    return g;
  }

  locked(): boolean {
    return this.t() < this.lockedUntil;
  }

  /** When the current login lock ends, or null. */
  lockedUntilIso(): string | null {
    return this.locked() ? this.iso(this.lockedUntil) : null;
  }

  private where(req: IncomingMessage): { ip: string; ipFrom: string } {
    return this.opts.ipOf?.(req) ?? { ip: req.socket.remoteAddress ?? '?', ipFrom: 'socket' };
  }

  // ------------------------------------------------------------------ HTTP

  /** Handles the OAuth paths; false when `path` isn't one of them. `base` = https://<public host> or http://127.0.0.1:<port>. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, base: string): Promise<boolean> {
    const method = req.method ?? 'GET';
    const resource = `${base}/mcp`;
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      json(res, 200, { resource, authorization_servers: [base], scopes_supported: SCOPES, bearer_methods_supported: ['header'], resource_name: 'Muster' });
      return true;
    }
    if (path === '/.well-known/oauth-authorization-server') {
      json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        revocation_endpoint: `${base}/revoke`,
        scopes_supported: SCOPES,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: true,
      });
      return true;
    }
    if (path === '/register') {
      if (method !== 'POST') throw new OAuthError(405, 'invalid_request', 'POST only');
      json(res, 201, this.register(await readForm(req)));
      return true;
    }
    if (path === '/authorize') {
      if (method === 'GET') await this.authorizePage(req, res, Object.fromEntries(new URL(req.url ?? '/', base).searchParams), resource);
      else if (method === 'POST') await this.authorizeSubmit(req, res, await readForm(req), resource);
      else throw new OAuthError(405, 'invalid_request', 'GET or POST only');
      return true;
    }
    if (path === '/token') {
      if (method !== 'POST') throw new OAuthError(405, 'invalid_request', 'POST only');
      try {
        json(res, 200, this.token(await readForm(req), resource, req));
      } catch (e) {
        if (!(e instanceof OAuthError)) throw e;
        json(res, e.status, { error: e.code, error_description: e.message });
      }
      return true;
    }
    if (path === '/revoke') {
      if (method !== 'POST') throw new OAuthError(405, 'invalid_request', 'POST only');
      const f = await readForm(req);
      const hash = sha256hex(f.token ?? '');
      const g = this.data.grants.find((x) => sameToken(x.accessHash, hash) || sameToken(x.refreshHash, hash));
      if (g) this.revoke(g.id, 'client');
      json(res, 200, {});
      return true;
    }
    return false;
  }

  private register(body: Record<string, string>): Record<string, unknown> {
    let uris: unknown;
    try {
      uris = JSON.parse(body.redirect_uris ?? 'null');
    } catch {
      uris = null;
    }
    if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === 'string')) throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uris must be a list of URLs');
    const bad = (uris as string[]).filter((u) => !allowedRedirect(u));
    if (bad.length) throw new OAuthError(400, 'invalid_redirect_uri', `Not allowed: ${bad.join(', ')} (only ${CLAUDE_CALLBACK} or a loopback URL)`);
    const auth = body.token_endpoint_auth_method;
    if (auth && auth !== 'none') throw new OAuthError(400, 'invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none")');
    const client: OAuthClient = { id: `mc_${b64url(randomBytes(16))}`, name: (body.client_name || 'MCP client').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80), redirectUris: uris as string[], kind: 'dcr', createdAt: this.iso() };
    this.data.clients.push(client);
    // Keep the list bounded: drop the oldest clients that hold no grant.
    while (this.data.clients.length > MAX_CLIENTS) {
      const i = this.data.clients.findIndex((c) => !this.data.grants.some((g) => g.clientId === c.id));
      if (i < 0) break;
      this.data.clients.splice(i, 1);
    }
    this.save();
    this.opts.audit({ event: 'client_registered', client: client.name });
    return { client_id: client.id, client_id_issued_at: Math.floor(this.t() / 1000), client_name: client.name, redirect_uris: client.redirectUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
  }

  private async client(id: string): Promise<OAuthClient> {
    if (/^https:\/\//.test(id)) {
      const hit = this.cimd.get(id);
      if (hit && hit.until > this.t()) return hit.client;
      let doc: Record<string, unknown>;
      try {
        doc = (await (this.opts.fetchMetadata ?? defaultFetchMetadata)(id)) as Record<string, unknown>;
      } catch (e) {
        throw new OAuthError(400, 'invalid_client', `Could not read the client's metadata document: ${e instanceof Error ? e.message : e}`);
      }
      if (!doc || doc.client_id !== id) throw new OAuthError(400, 'invalid_client', 'The metadata document names a different client_id');
      const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((u): u is string => typeof u === 'string' && allowedRedirect(u)) : [];
      if (!uris.length) throw new OAuthError(400, 'invalid_client', 'The metadata document has no allowed redirect_uris');
      const name = typeof doc.client_name === 'string' && doc.client_name.trim() ? doc.client_name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) : new URL(id).hostname;
      const client: OAuthClient = { id, name, redirectUris: uris, kind: 'cimd', createdAt: this.iso() };
      this.cimd.set(id, { client, until: this.t() + 60 * 60_000 });
      return client;
    }
    const c = this.data.clients.find((x) => x.id === id);
    if (!c) throw new OAuthError(400, 'invalid_client', 'Unknown client_id');
    return c;
  }

  /** Checks the request parameters shared by GET and POST /authorize. Errors here are shown, never redirected. */
  private async checkAuthorize(p: Record<string, string>, resource: string): Promise<{ client: OAuthClient; scope: string }> {
    if (!p.client_id) throw new OAuthError(400, 'invalid_request', 'Missing client_id');
    const client = await this.client(p.client_id);
    if (!p.redirect_uri || !client.redirectUris.includes(p.redirect_uri)) throw new OAuthError(400, 'invalid_request', 'redirect_uri is not registered for this client');
    if (p.response_type !== 'code') throw new OAuthError(400, 'unsupported_response_type', 'response_type must be "code"');
    if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge ?? '')) throw new OAuthError(400, 'invalid_request', 'PKCE with S256 is required');
    if (p.resource && p.resource.replace(/\/+$/, '') !== resource) throw new OAuthError(400, 'invalid_target', `resource must be ${resource}`);
    const asked = (p.scope ?? '').split(/\s+/).filter(Boolean);
    const scope = (asked.length ? asked.filter((s) => SCOPES.includes(s)) : SCOPES).join(' ') || SCOPES[0];
    return { client, scope };
  }

  private async authorizePage(req: IncomingMessage, res: ServerResponse, p: Record<string, string>, resource: string, error = ''): Promise<void> {
    let client: OAuthClient;
    try {
      ({ client } = await this.checkAuthorize(p, resource));
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      this.opts.audit({ event: 'login_failed', reason: 'bad_request', detail: e.message, ...this.where(req) });
      return this.page(res, 400, 'This sign-in link is not valid', `<p class="err">${esc(e.message)}</p>`);
    }
    const hidden = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']
      .filter((k) => p[k] !== undefined)
      .map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`)
      .join('');
    const locked = this.locked();
    const body = `
      <p><b>${esc(client.name)}</b> wants to connect to Muster on <b>${esc(this.opts.pcName)}</b>. It will be able to read your projects' status and what needs you.</p>
      <p>Open Muster on the PC, go to <b>Settings → Phone → Remote access</b> and press <b>New code</b>. Codes work once and last 2 minutes.</p>
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
      <form method="post" action="/authorize">${hidden}
        <input name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="K7M-4QX" maxlength="9" ${locked ? 'disabled' : 'autofocus'} required>
        <div class="row"><button type="submit" name="decision" value="allow" ${locked ? 'disabled' : ''}>Connect</button><button type="submit" name="decision" value="deny" class="ghost" formnovalidate>Cancel</button></div>
      </form>`;
    this.page(res, error ? 401 : 200, 'Connect to Muster', body);
  }

  private async authorizeSubmit(req: IncomingMessage, res: ServerResponse, f: Record<string, string>, resource: string): Promise<void> {
    let checked: { client: OAuthClient; scope: string };
    try {
      checked = await this.checkAuthorize(f, resource);
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      this.opts.audit({ event: 'login_failed', reason: 'bad_request', detail: e.message, ...this.where(req) });
      return this.page(res, 400, 'This sign-in link is not valid', `<p class="err">${esc(e.message)}</p>`);
    }
    const back = (params: Record<string, string>) => {
      const u = new URL(f.redirect_uri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (f.state) u.searchParams.set('state', f.state);
      res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' });
      res.end();
    };
    if (f.decision === 'deny') {
      this.opts.audit({ event: 'login_denied', client: checked.client.name, ...this.where(req) });
      return back({ error: 'access_denied' });
    }
    const ip = this.where(req);
    if (this.locked()) {
      this.opts.audit({ event: 'login_failed', reason: 'locked', client: checked.client.name, ...ip });
      return this.authorizePage(req, res, f, resource, `Too many wrong codes. Logins are locked until ${new Date(this.lockedUntil).toLocaleTimeString()}.`);
    }
    const result = this.pairing.redeem(f.code);
    if (result !== 'ok') {
      const t = this.t();
      this.fails = this.fails.filter((x) => t - x < FAIL_WINDOW_MS);
      this.fails.push(t);
      const lockNow = this.fails.length >= MAX_FAILS;
      if (lockNow) {
        this.lockedUntil = t + LOCK_MS;
        this.fails = [];
      }
      this.opts.audit({ event: 'login_failed', reason: result === 'limited' ? 'locked' : result, client: checked.client.name, ...ip, ...(lockNow ? { lockedUntil: this.iso(this.lockedUntil) } : {}) });
      if (lockNow) this.opts.onLock?.({ until: this.iso(this.lockedUntil), ...ip, client: checked.client.name });
      const msg = lockNow ? 'Too many wrong codes. Logins are locked for 10 minutes.' : result === 'expired' ? 'That code has expired. Make a new one in Muster.' : 'Wrong code.';
      return this.authorizePage(req, res, f, resource, msg);
    }
    const code = b64url(randomBytes(32));
    this.codes.set(sha256hex(code), { clientId: checked.client.id, clientName: checked.client.name, redirectUri: f.redirect_uri, challenge: f.code_challenge, scope: checked.scope, resource, expiresAt: this.t() + AUTH_CODE_TTL_MS });
    this.opts.audit({ event: 'login_ok', client: checked.client.name, ...ip });
    back({ code });
  }

  private token(f: Record<string, string>, resource: string, req: IncomingMessage): Record<string, unknown> {
    const t = this.t();
    const ip = this.where(req);
    const fail = (reason: string, message: string, code = 'invalid_grant'): never => {
      this.opts.audit({ event: 'login_failed', reason, ...ip });
      throw new OAuthError(400, code, message);
    };
    for (const [k, v] of this.codes) if (v.expiresAt <= t) this.codes.delete(k);

    if (f.grant_type === 'authorization_code') {
      const key = sha256hex(f.code ?? '');
      const pending = this.codes.get(key);
      this.codes.delete(key); // single use, even when the rest of the request is wrong
      if (!pending) return fail('bad_code', 'Unknown or expired authorization code');
      if (pending.clientId !== f.client_id) return fail('client_mismatch', 'client_id does not match the code');
      if (pending.redirectUri !== f.redirect_uri) return fail('redirect_mismatch', 'redirect_uri does not match the code');
      if (!f.code_verifier || !sameToken(s256(f.code_verifier), pending.challenge)) return fail('bad_pkce', 'PKCE verification failed');
      if (f.resource && f.resource.replace(/\/+$/, '') !== pending.resource) return fail('bad_resource', 'resource does not match the code', 'invalid_target');
      const access = token('mra');
      const refresh = token('mrr');
      const g: Grant = {
        id: `g${b64url(randomBytes(6))}`,
        clientId: pending.clientId,
        clientName: pending.clientName,
        scope: pending.scope,
        resource: pending.resource,
        accessHash: sha256hex(access),
        accessExpiresAt: this.iso(t + ACCESS_TTL_MS),
        refreshHash: sha256hex(refresh),
        refreshExpiresAt: this.iso(t + REFRESH_TTL_MS),
        createdAt: this.iso(t),
        lastUsedAt: this.iso(t),
      };
      this.data.grants.push(g);
      this.save();
      this.opts.audit({ event: 'connected', grant: g.id, client: g.clientName });
      return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: g.scope };
    }

    if (f.grant_type === 'refresh_token') {
      const hash = sha256hex(f.refresh_token ?? '');
      const reused = this.data.grants.find((x) => x.prevRefreshHash && sameToken(x.prevRefreshHash, hash));
      if (reused) {
        this.revoke(reused.id, 'refresh token reused');
        return fail('refresh_reused', 'This refresh token was already used; the connection has been revoked');
      }
      const g = this.data.grants.find((x) => sameToken(x.refreshHash, hash));
      if (!g || Date.parse(g.refreshExpiresAt) <= t) return fail('bad_refresh', 'Unknown, expired or revoked refresh token');
      if (f.client_id && f.client_id !== g.clientId) return fail('client_mismatch', 'client_id does not match the refresh token');
      const access = token('mra');
      const refresh = token('mrr');
      g.prevRefreshHash = g.refreshHash;
      g.accessHash = sha256hex(access);
      g.accessExpiresAt = this.iso(t + ACCESS_TTL_MS);
      g.refreshHash = sha256hex(refresh);
      g.refreshExpiresAt = this.iso(t + REFRESH_TTL_MS);
      g.lastUsedAt = this.iso(t);
      this.save();
      return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: g.scope };
    }
    return fail('bad_grant_type', 'grant_type must be authorization_code or refresh_token', 'unsupported_grant_type');
  }

  private page(res: ServerResponse, status: number, title: string, body: string): void {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
    });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f12;color:#e6e7ea;font:15px/1.5 system-ui,sans-serif}
main{width:min(420px,calc(100vw - 32px));background:#16181d;border:1px solid #262a33;border-radius:14px;padding:28px}
h1{font-size:18px;margin:0 0 12px}.brand{color:#a99cff;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}
p{color:#b4b8c2;margin:0 0 12px}b{color:#e6e7ea}.err{color:#ff8a8a}
input[name=code]{width:100%;box-sizing:border-box;font:600 22px/1 ui-monospace,monospace;letter-spacing:.2em;text-align:center;text-transform:uppercase;padding:12px;border-radius:10px;border:1px solid #333845;background:#0e0f12;color:#fff;margin:4px 0 14px}
.row{display:flex;gap:8px}button{flex:1;padding:11px;border-radius:10px;border:0;font:600 14px system-ui;background:#7c6cff;color:#fff;cursor:pointer}
button.ghost{background:transparent;border:1px solid #333845;color:#b4b8c2}button:disabled{opacity:.5}
</style></head><body><main><div class="brand">Muster</div><h1>${esc(title)}</h1>${body}</main></body></html>`);
  }
}
