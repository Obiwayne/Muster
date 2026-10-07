// Typed client for the Media routes (/api/media/*, docs/MEDIA.md). Every write is yours (actor "you").
import type {
  MediaAbout, MediaImage, MediaKind, MediaPiece, MediaPlatform, MediaPost, MediaSection, MediaShot, MediaStore, MediaSuggestion, MediaSummary,
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

export interface NewPieceBody {
  kind: MediaKind;
  about: Pick<MediaAbout, 'kind' | 'ref'>[];
  note?: string;
  platforms?: MediaPlatform[];
  suggestionId?: string;
}

export interface EditPieceBody {
  title?: string;
  posts?: MediaPost[];
  sections?: MediaSection[];
  hooks?: string[];
  hookChosen?: number;
  shots?: MediaShot[];
  target?: string;
  images?: MediaImage[];
}

export const getMedia = () => req<MediaStore>('GET', '/api/media');
export const getMediaSummary = () => req<MediaSummary>('GET', '/api/media/summary');
export const createPiece = (body: NewPieceBody) => req<MediaPiece>('POST', '/api/media/pieces', { actor: YOU, ...body });
export const editPiece = (id: string, body: EditPieceBody) => req<MediaPiece>('POST', `/api/media/pieces/${enc(id)}/edit`, { actor: YOU, ...body });
export const askPiece = (id: string, text: string) => req<MediaPiece>('POST', `/api/media/pieces/${enc(id)}/ask`, { actor: YOU, text });
export const confirmClaim = (id: string, cid: string) => req<MediaPiece>('POST', `/api/media/pieces/${enc(id)}/claims/${enc(cid)}/confirm`, { actor: YOU });
export const approvePiece = (id: string) => req<MediaPiece>('POST', `/api/media/pieces/${enc(id)}/approve`, { actor: YOU });
export const usedPiece = (id: string) => req<MediaPiece>('POST', `/api/media/pieces/${enc(id)}/used`, { actor: YOU });
export const retryPiece = (id: string) => req<MediaPiece>('POST', `/api/media/pieces/${enc(id)}/retry`, { actor: YOU });
export const deletePiece = (id: string) => req<unknown>('DELETE', `/api/media/pieces/${enc(id)}`, { actor: YOU });
export const saveStyle = (text: string) => req<unknown>('PUT', '/api/media/style', { actor: YOU, text });
export const acceptSuggestion = (id: string) => req<{ pieces: MediaPiece[] }>('POST', `/api/media/suggestions/${enc(id)}/accept`, { actor: YOU });
export const dismissSuggestion = (id: string) => req<MediaSuggestion>('POST', `/api/media/suggestions/${enc(id)}/dismiss`, { actor: YOU });
export const dismissAllSuggestions = () => req<unknown>('POST', '/api/media/suggestions/dismiss-all', { actor: YOU });
