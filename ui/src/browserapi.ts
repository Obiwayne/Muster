// Client for the human research-browser writes (docs/ARCHITECTURE.md § Competitive intelligence → Research browser):
// open/close the login window, import Opera cookies for allow-listed sites, forget a site, and the visible-window
// list shared by every project on this PC. Each answers with the
// fresh ResearchBrowserStatus. The read-only GET /api/browser lives in intelapi.ts (getBrowserStatus).
import type { ResearchBrowserStatus } from '../../src/types';
import { ApiError, getToken, refreshToken } from './api';

async function post(path: string, body: Record<string, unknown>, retried = false): Promise<ResearchBrowserStatus> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'x-muster-token': getToken(), 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'you', ...body }),
    });
  } catch {
    throw new ApiError('Cannot reach the Muster orchestrator', 0);
  }
  if (res.status === 401 && !retried && (await refreshToken())) return post(path, body, true);
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 404) throw new ApiError('This Muster orchestrator has no research browser yet. Restart it on the latest build.', 404);
    const msg = (data && typeof data === 'object' && data.error) || (typeof data === 'string' && data) || `${res.status} ${res.statusText}`;
    throw new ApiError(String(msg), res.status);
  }
  return data as ResearchBrowserStatus;
}

/** Open the headed login window on a known site's login page (or any URL) with Muster's research profile. */
export const openLogin = (target: { site?: string; url?: string } = {}) => post('/api/browser/login', target);
export const closeLogin = () => post('/api/browser/login/close', {});
/** Import Opera cookies for these domains (all allow-listed ones when omitted). Counts only, never values. */
export const operaImport = (domains?: string[]) => post('/api/browser/opera-import', domains ? { domains } : {});
/** Clear one site's cookies from the research profile. */
export const forgetSite = (site: string) => post('/api/browser/forget', { site });

/** Read this site in a visible window (or not), for every project on this PC. */
export const setSiteVisible = (domain: string, visible: boolean) => post('/api/browser/visible', { domain, visible });

export const browserApi = { openLogin, closeLogin, operaImport, forgetSite, setSiteVisible };
