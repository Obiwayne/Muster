// Typed client for the competitive-intelligence routes (/api/intel/*) and the read-only research browser
// status (GET /api/browser). See docs/ARCHITECTURE.md § "Competitive intelligence". The human browser
// writes (login, Opera import, forget) live in browserapi.ts.
import type {
  BrowseMode, IntelArea, IntelCheck, IntelCompetitor, IntelJob, IntelProbe, IntelSiteSource, IntelStore, IntelSummary, ResearchBrowserStatus,
  ResearchIdea, WatchCadence,
} from '../../src/types';
import { ApiError, getToken, refreshToken } from './api';

export { ApiError };

async function req<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'x-muster-token': getToken(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the Muster orchestrator', 0);
  }
  if (res.status === 401 && !retried && (await refreshToken())) return req<T>(method, path, body, true);
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && data.error) || (typeof data === 'string' && data) || `${res.status} ${res.statusText}`;
    throw new ApiError(String(msg), res.status);
  }
  return data as T;
}

const enc = encodeURIComponent;
const YOU = 'you';

/** Body of POST /api/intel/competitors (actor is added here). */
export interface AddCompetitorBody {
  id?: string;
  name: string;
  url: string;
  tagline?: string;
  identity?: IntelCompetitor['identity'];
  sources: IntelSiteSource[];
  areas: IntelArea[];
  watch: WatchCadence;
  browse: BrowseMode;
  depth?: 'quick' | 'thorough';
  start?: true;
}

export type PatchCompetitorBody = Partial<Pick<IntelCompetitor, 'name' | 'url' | 'sources' | 'areas' | 'watch' | 'browse' | 'identity'>>;

export interface StartJobBody {
  kind: 'sweep' | 'competitor';
  competitorIds?: string[];
  areas?: IntelArea[];
  browse?: BrowseMode;
  depth?: 'quick' | 'thorough';
}

/** The answer to POST /api/intel/ask: with an ideaId it is the idea (like /api/research/ideas/:id/ask), else the updated thread. */
export type AskIntelResult = ResearchIdea | { captainThread: IntelStore['captainThread'] };

/**
 * GET /api/intel/report (Markdown). The API takes the token only in the x-muster-token header, so a bare link to this
 * path gets 401: download with `getReport()` (fetch + Blob), as Export report does.
 */
export function reportUrl(): string {
  return '/api/intel/report';
}

export const getIntel = () => req<IntelStore>('GET', '/api/intel');
export const getIntelSummary = () => req<IntelSummary>('GET', '/api/intel/summary');
export const probe = (url: string) => req<IntelProbe>('POST', '/api/intel/probe', { url });
export const addCompetitor = (body: AddCompetitorBody) =>
  req<{ competitor: IntelCompetitor; job?: IntelJob }>('POST', '/api/intel/competitors', { actor: YOU, ...body });
export const patchCompetitor = (id: string, body: PatchCompetitorBody) =>
  req<IntelCompetitor>('PATCH', `/api/intel/competitors/${enc(id)}`, { actor: YOU, ...body });
export const removeCompetitor = (id: string) => req<{ ok: boolean }>('DELETE', `/api/intel/competitors/${enc(id)}`, { actor: YOU });
export const startJob = (body: StartJobBody) => req<IntelJob>('POST', '/api/intel/jobs', { actor: YOU, ...body });
export const cancelJob = (id: string) => req<IntelJob>('POST', `/api/intel/jobs/${enc(id)}/cancel`, { actor: YOU });
export const requestCheck = (ideaId: string) => req<IntelCheck>('POST', '/api/intel/checks', { actor: YOU, ideaId });
export const askIntel = (text: string, ideaId?: string) =>
  req<AskIntelResult>('POST', '/api/intel/ask', { actor: YOU, text, ...(ideaId ? { ideaId } : {}) });
export const markChangesSeen = (ids?: string[]) =>
  req<{ ok: boolean }>('POST', '/api/intel/changes/seen', { actor: YOU, ...(ids ? { ids } : {}) });
/** Fetch the Markdown report as text (Export report downloads it). */
export async function getReport(): Promise<string> {
  const res = await fetch('/api/intel/report', { headers: { 'x-muster-token': getToken() } });
  if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
  return res.text();
}
/** A 404 (orchestrator without the research browser yet) reads as "not available", not an error. */
export const getBrowserStatus = (): Promise<ResearchBrowserStatus> =>
  req<ResearchBrowserStatus>('GET', '/api/browser').catch((e) => {
    if (e instanceof ApiError && e.status === 404) {
      return {
        available: false, problem: 'This Muster orchestrator has no research browser yet.', channel: 'chrome', profileDir: '', state: 'idle',
        sites: [], tools: [], opera: { found: false, allow: [] },
      } satisfies ResearchBrowserStatus;
    }
    throw e;
  });

/** Everything above as one object, for callers who prefer `intelApi.getIntel()`. */
export const intelApi = {
  getIntel, getIntelSummary, probe, addCompetitor, patchCompetitor, removeCompetitor, startJob, cancelJob, requestCheck, askIntel,
  markChangesSeen, reportUrl, getReport, getBrowserStatus,
};
