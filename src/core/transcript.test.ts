import { describe, expect, it } from 'vitest';
import { formatTokens, transcriptUsage } from './transcript.js';

const line = (o: object) => JSON.stringify(o);
const asst = (id: string, usage: object, extra: object = {}) => line({ type: 'assistant', message: { id, usage }, ...extra });

describe('transcriptUsage', () => {
  it('counts each request once, takes the context from the latest one and leaves out sidechains', () => {
    const jsonl = [
      line({ type: 'user', message: { content: 'hi' } }),
      asst('m1', { input_tokens: 10, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 0, output_tokens: 5 }),
      asst('m1', { input_tokens: 10, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 0, output_tokens: 50 }), // streamed again
      asst('s1', { input_tokens: 999_999, output_tokens: 1 }, { isSidechain: true }),
      asst('m2', { input_tokens: 3, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 20_000, output_tokens: 7 }),
      '{"type":"assistant","message":{"usage"', // half-written line
    ].join('\n');
    const u = transcriptUsage(jsonl)!;
    expect(u.context).toBe(21_003);
    expect(u.totals).toEqual({ input: 13, cacheWrite: 21_000, cacheRead: 20_000, output: 57, requests: 2 });
  });

  it('is undefined before the first request', () => {
    expect(transcriptUsage(line({ type: 'user' }))).toBeUndefined();
  });

  it('formats token counts', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(120_000)).toBe('120k');
    expect(formatTokens(1_250_000)).toBe('1.3M');
  });
});
