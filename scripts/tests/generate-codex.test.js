'use strict';
/**
 * Tests for scripts/generate-codex/index.js's parseFrontmatter CRLF fix.
 *
 * The delimiter regex requires a literal '\n' next to '---', so a
 * CRLF-sourced SKILL.md/agent .md (the norm on Windows checkouts with
 * core.autocrlf=true) silently discarded real frontmatter as if it were
 * part of the body.
 */

const { parseFrontmatter } = require('../generate-codex/index.js');

describe('parseFrontmatter — CRLF line endings', () => {
  const CRLF_CONTENT =
    '---\r\nname: my-agent\r\ndescription: A test agent\r\n---\r\n\r\n# Body\r\n';

  test('detects frontmatter despite \\r\\n around the delimiters', () => {
    const { data } = parseFrontmatter(CRLF_CONTENT);
    expect(data).toEqual({ name: 'my-agent', description: 'A test agent' });
  });

  test('extracts body content with the frontmatter block removed', () => {
    const { content } = parseFrontmatter(CRLF_CONTENT);
    expect(content.trim()).toBe('# Body');
  });

  test('LF content still parses the same as before (no regression)', () => {
    const lfContent = '---\nname: my-agent\ndescription: A test agent\n---\n\n# Body\n';
    expect(parseFrontmatter(lfContent).data).toEqual({ name: 'my-agent', description: 'A test agent' });
  });

  test('no-frontmatter CRLF content reports empty data, not a false match', () => {
    const { data, content } = parseFrontmatter('# Body only\r\n\r\nNo frontmatter here.\r\n');
    expect(data).toEqual({});
    expect(content).toContain('Body only');
  });
});
