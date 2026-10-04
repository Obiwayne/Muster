// /api/phone/* (you only): forwards to the phone gateway's admin API (/admin/*), starting the gateway when it
// isn't running. The desktop's Settings → Phone only talks to its own orchestrator. See docs/PHONE.md.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PhoneLink } from '../phone/link.js';
import { sendJson } from './api.js';
import type { Caller } from './auth.js';

const MAX_BODY = 256 * 1024;

function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function handlePhone(req: IncomingMessage, res: ServerResponse, url: URL, caller: Caller, link: PhoneLink): Promise<void> {
  if (!caller.human) return sendJson(res, 403, { error: `Only you can manage the phone link; ${caller.actor} is an agent` });
  const rest = url.pathname.slice('/api/phone'.length).replace(/\/+$/, '');
  if (!rest || !/^\/[A-Za-z0-9._~%/-]+$/.test(rest) || rest.split('/').some((s) => s === '..' || s === '.')) return sendJson(res, 404, { error: `No route ${url.pathname}` });
  const method = req.method ?? 'GET';
  try {
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readRaw(req);
    const r = await link.forward(method, `/admin${rest}${url.search}`, body?.trim() ? body : body === undefined ? undefined : '{}');
    res.writeHead(r.status, { 'content-type': r.contentType, 'cache-control': 'no-store' });
    res.end(r.body);
  } catch (e) {
    // The gateway didn't start or didn't answer: the desktop shows "Start phone service" (which retries GET status).
    sendJson(res, 503, { error: `Phone gateway: ${e instanceof Error ? e.message : String(e)}` });
  }
}
