import { describe, expect, it } from 'vitest';
import { STARTER_GUIDELINES } from './starters.js';

describe('starter guidelines', () => {
  it('concept asks for 3-5 name candidates checked on GitHub and npm', () => {
    const g = STARTER_GUIDELINES.concept;
    expect(g).toContain('Name candidates');
    expect(g).toContain('3-5 product names');
    expect(g).toContain('gh repo view <owner>/<name>');
    expect(g).toContain('npm view <name>');
    expect(g).toContain('free or taken');
  });
  it('approval tells Obi to choose the name and optionally create the GitHub repo', () => {
    expect(STARTER_GUIDELINES.approval).toContain('Choose the product name (Settings → Project), then Create GitHub repo if you want one.');
  });
  it('qa is the strict 1-5 rubric: five items, lowest score wins, review only', () => {
    const g = STARTER_GUIDELINES.qa;
    for (const k of ['correct', 'tested', 'clean', 'scoped', 'safe']) expect(g).toContain(`**${k}**`);
    expect(g).toContain('only 5/5 passes');
    expect(g).toContain('The overall score is the lowest item');
    expect(g).toContain('you never edit code');
    expect(g).toContain('`qa_verdict`');
    expect(g).toMatch(/every score under 5 has at least one finding/);
  });
});
