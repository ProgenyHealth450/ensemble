/**
 * Tests for the minimal CommonMark-ish renderer used by the
 * refinement-review UI. The renderer tags every block element with
 * `data-source-line` so comments can anchor to a precise line range.
 *
 * Loaded via vm.runInNewContext because the module attaches itself
 * to `window` (it's an in-browser IIFE).
 *
 * @jest-environment node
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'lib', 'refinement-review', 'ui', 'markdown.js'),
  'utf8'
);

function loadRenderer() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx, { filename: 'markdown.js' });
  return ctx.window.RRMarkdown;
}

describe('refinement-review markdown renderer', () => {
  test('renders headings with data-source-line', () => {
    const RR = loadRenderer();
    const html = RR.render('# Top\n\n## Section\n');
    expect(html).toMatch(/<h1 data-source-line="1">Top<\/h1>/);
    expect(html).toMatch(/<h2 data-source-line="3">Section<\/h2>/);
  });

  test('renders paragraphs and lists with line numbers', () => {
    const RR = loadRenderer();
    const md = `Intro line.\n\n- one\n- two\n- three\n\nA paragraph.`;
    const html = RR.render(md);
    expect(html).toMatch(/<p data-source-line="1">Intro line\.<\/p>/);
    expect(html).toMatch(/<ul data-source-line="3">/);
    expect(html).toMatch(/<li data-source-line="3">one<\/li>/);
    // List items inherit the parent list's start line so the anchor
    // covers the whole range — sensible for PRD/TRD review comments.
    expect(html).toMatch(/<li data-source-line="3">three<\/li>/);
    expect(html).toMatch(/<p data-source-line="7">A paragraph\.<\/p>/);
  });

  test('renders fenced code with line number on <pre>', () => {
    const RR = loadRenderer();
    const html = RR.render('paragraph above\n\n```js\nconst x = 1;\n```\n');
    expect(html).toMatch(/<pre data-source-line="3"><code data-lang="js">const x = 1;<\/code><\/pre>/);
  });
  test('renders blockquote, hr, ordered list', () => {
    const RR = loadRenderer();
    // md lines:  1:> a quoted line   2:> still quoted
    //            3:blank            4:---                5:blank
    //            6:1. first         7:2. second
    const md = `> a quoted line\n> still quoted\n\n---\n\n1. first\n2. second\n`;
    const html = RR.render(md);
    expect(html).toMatch(/<blockquote data-source-line="1">/);
    // Inline body, no inner <p> wrapping.
    expect(html).toMatch(/<blockquote data-source-line="1">a quoted line\nstill quoted<\/blockquote>/);
    expect(html).toMatch(/<hr data-source-line="4" \/>/);
    expect(html).toMatch(/<ol data-source-line="6">/);
    expect(html).toMatch(/<li data-source-line="6">first<\/li>/);
    expect(html).toMatch(/<li data-source-line="6">second<\/li>/);
  });

  test('escapes HTML in headings, paragraphs, code spans', () => {
    const RR = loadRenderer();
    const html = RR.render('## <script>alert(1)</script>\n\nA `<b>` tag.\n');
    expect(html).toMatch(/&lt;script&gt;/);
    expect(html).toMatch(/<code>&lt;b&gt;<\/code>/);
    expect(html).not.toMatch(/<script>alert/);
  });

  test('renders inline: links, bold, italic, code', () => {
    const RR = loadRenderer();
    const html = RR.render('See [docs](https://x) for **details** with *flair*.\n');
    expect(html).toMatch(/<a href="https:\/\/x" rel="noopener">docs<\/a>/);
    expect(html).toMatch(/<strong>details<\/strong>/);
    expect(html).toMatch(/<em>flair<\/em>/);
  });

  test('every block carries a data-source-line', () => {
    const RR = loadRenderer();
    const md = [
      '# Title',
      '',
      'Intro paragraph.',
      '',
      '## Section',
      '',
      '- item',
      '',
      '> quoted',
      '',
      '```',
      'code',
      '```',
      '',
    ].join('\n');
    const html = RR.render(md);
    // Pull every top-level block tag and ensure each has data-source-line.
    const blockTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'pre', 'blockquote', 'hr'];
    for (const tag of blockTags) {
      const matches = html.match(new RegExp(`<${tag}[^>]*>`, 'g')) || [];
      for (const m of matches) {
        expect(m).toMatch(/data-source-line="\d+"/);
      }
    }
  });

  test('handles CRLF line endings', () => {
    const RR = loadRenderer();
    const html = RR.render('one\r\n\r\ntwo\r\n');
    expect(html).toMatch(/<p data-source-line="1">one<\/p>/);
    expect(html).toMatch(/<p data-source-line="3">two<\/p>/);
  });

  test('returns empty string on empty input', () => {
    const RR = loadRenderer();
    expect(RR.render('')).toBe('');
    expect(RR.render(null)).toBe('');
    expect(RR.render(undefined)).toBe('');
  });
});
