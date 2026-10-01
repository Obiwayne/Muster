import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('escapes raw HTML', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(escapeHtml(`a&b"c'`)).toBe('a&amp;b&quot;c&#39;');
  });

  it('renders headings and paragraphs', () => {
    expect(renderMarkdown('# Title\n\nsome\ntext')).toBe('<h1>Title</h1>\n<p>some text</p>');
  });

  it('renders inline bold, italic and code', () => {
    expect(renderMarkdown('a **b** *c* `d*e*`')).toBe('<p>a <strong>b</strong> <em>c</em> <code>d*e*</code></p>');
  });

  it('renders lists', () => {
    expect(renderMarkdown('- a\n- b\n\n1. x\n2. y')).toBe('<ul><li>a</li><li>b</li></ul>\n<ol><li>x</li><li>y</li></ol>');
  });

  it('renders fenced code without interpreting its contents', () => {
    expect(renderMarkdown('```\n<b>**x**</b>\n```')).toBe('<pre><code>&lt;b&gt;**x**&lt;/b&gt;</code></pre>');
  });

  it('only links http(s) URLs', () => {
    expect(renderMarkdown('[ok](https://a.dev/x)')).toContain('<a href="https://a.dev/x"');
    expect(renderMarkdown('[bad](javascript:alert(1))')).not.toContain('<a');
  });

  it('renders quotes and rules', () => {
    expect(renderMarkdown('> hi\n---')).toBe('<blockquote>hi</blockquote>\n<hr>');
  });
});
