import { describe, expect, it } from 'vitest';
import { formatStatusLine } from './statusline.js';

describe('formatStatusLine', () => {
  it('shows both windows, rounded', () => {
    const line = formatStatusLine(
      { rate_limits: { five_hour: { used_percentage: 61.6, resets_at: 1790000000 }, seven_day: { used_percentage: 38 } }, cost: { total_cost_usd: 1.2 } },
      'crew-2',
    );
    expect(line).toBe('muster · crew-2 · 5h 62% · wk 38%');
  });
  it('omits missing parts', () => {
    expect(formatStatusLine({ rate_limits: { seven_day: { used_percentage: 10 } } }, 'captain')).toBe('muster · captain · wk 10%');
    expect(formatStatusLine({}, 'crew-3')).toBe('muster · crew-3');
    expect(formatStatusLine({})).toBe('muster');
    expect(formatStatusLine({ rate_limits: { five_hour: {} } }, 'x')).toBe('muster · x');
  });
});
