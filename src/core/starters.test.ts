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
});
