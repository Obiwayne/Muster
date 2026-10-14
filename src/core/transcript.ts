// Token use from a Claude Code session transcript (the JSONL file the hooks get as transcript_path).
// Each API request leaves one or more assistant lines carrying message.usage; streamed parts repeat the same
// message id, so the last line per id counts.
import type { TokenCounts } from '../types.js';

export interface TranscriptUsage {
  /** Tokens in the context on the latest request: input + cache write + cache read. */
  context: number;
  /** Every request of the session, summed. */
  totals: TokenCounts;
}

interface RawUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export const emptyCounts = (): TokenCounts => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, requests: 0 });

export function addCounts(a: TokenCounts | undefined, b: TokenCounts | undefined): TokenCounts {
  const x = a ?? emptyCounts();
  const y = b ?? emptyCounts();
  return { input: x.input + y.input, cacheWrite: x.cacheWrite + y.cacheWrite, cacheRead: x.cacheRead + y.cacheRead, output: x.output + y.output, requests: x.requests + y.requests };
}

/** All tokens sent and received, without weighting. */
export const totalTokens = (c: TokenCounts | undefined) => (c ? c.input + c.cacheWrite + c.cacheRead + c.output : 0);

/** input + cache write + cache read of one request's usage record. */
export function contextOf(u: RawUsage | undefined): number {
  return u ? n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) : 0;
}

/** Usage of the main conversation in a transcript (subagent sidechains are left out). Undefined when it has no usage yet. */
export function transcriptUsage(jsonl: string): TranscriptUsage | undefined {
  const byId = new Map<string, RawUsage>();
  let last: RawUsage | undefined;
  let anon = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let entry: { type?: string; isSidechain?: boolean; message?: { id?: string; usage?: RawUsage } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a line still being written
    }
    const usage = entry.message?.usage;
    if (entry.type !== 'assistant' || entry.isSidechain || !usage) continue;
    byId.set(entry.message?.id ?? `#${anon++}`, usage);
    last = usage;
  }
  if (!last) return undefined;
  const totals = emptyCounts();
  for (const u of byId.values()) {
    totals.input += n(u.input_tokens);
    totals.cacheWrite += n(u.cache_creation_input_tokens);
    totals.cacheRead += n(u.cache_read_input_tokens);
    totals.output += n(u.output_tokens);
    totals.requests++;
  }
  return { context: contextOf(last), totals };
}

/** "84k", "1.2M": a token count for a status line. */
export function formatTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return String(v);
}
