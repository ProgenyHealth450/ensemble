'use strict';

const fs = require('fs');
const path = require('path');
const { parsePrdAcs } = require('../lib/prd-ac-parser');

const SAMPLE_LF = fs.readFileSync(
  path.join(__dirname, 'fixtures/PRD-sample.md'),
  'utf8'
);
const toCrlf = (text) => text.replace(/\n/g, '\r\n');

describe('parsePrdAcs (LF, snake_case frontmatter — baseline)', () => {
  const prd = parsePrdAcs(SAMPLE_LF);

  test('resolves frontmatter', () => {
    expect(prd.documentId).toBe('PRD-2026-sample01');
    expect(prd.label).toBe('sample-feature');
  });

  test('extracts both REQs with their ACs', () => {
    expect(prd.reqs.map((r) => r.id)).toEqual(['REQ-001', 'REQ-002']);
    expect(prd.reqs[0].acs.map((a) => a.id)).toEqual(['AC-001-1', 'AC-001-2']);
    expect(prd.reqs[1].acs.map((a) => a.id)).toEqual(['AC-002-1']);
  });

  test('accepts both bold and plain AC marker forms with trimmed text', () => {
    expect(prd.reqs[0].acs[0].text).toBe(
      'Given a user, when they do X, then Y happens.'
    );
    expect(prd.reqs[0].acs[1].text).toBe('Given something else, then Z.');
  });
});

describe('parsePrdAcs (AC-002-1: CRLF line endings)', () => {
  const prd = parsePrdAcs(toCrlf(SAMPLE_LF));

  test('extracts identical REQ/AC structure as the LF fixture', () => {
    expect(prd.reqs.map((r) => r.id)).toEqual(['REQ-001', 'REQ-002']);
    expect(prd.reqs[0].acs.map((a) => a.id)).toEqual(['AC-001-1', 'AC-001-2']);
    expect(prd.reqs[1].acs.map((a) => a.id)).toEqual(['AC-002-1']);
  });

  test('resolves frontmatter identically to the LF fixture', () => {
    expect(prd.documentId).toBe('PRD-2026-sample01');
    expect(prd.label).toBe('sample-feature');
  });
});

const TITLE_CASE_FRONTMATTER = `---
Document ID: PRD-2026-titlecase
Label: title-case-feature
---
# Title Case Frontmatter

### REQ-001: Only Requirement

- AC-001-1: Given a thing, then it works.
`;

describe('parsePrdAcs (AC-002-2: Title-Case frontmatter)', () => {
  test('resolves "Document ID:" / "Label:" to documentId/label', () => {
    const prd = parsePrdAcs(TITLE_CASE_FRONTMATTER);
    expect(prd.documentId).toBe('PRD-2026-titlecase');
    expect(prd.label).toBe('title-case-feature');
  });

  test('combined with CRLF line endings, still resolves both fields', () => {
    const prd = parsePrdAcs(toCrlf(TITLE_CASE_FRONTMATTER));
    expect(prd.documentId).toBe('PRD-2026-titlecase');
    expect(prd.label).toBe('title-case-feature');
    expect(prd.reqs[0].acs.map((a) => a.id)).toEqual(['AC-001-1']);
  });
});

describe('parsePrdAcs (edge cases)', () => {
  test('a REQ heading with zero ACs yields acs: [] rather than throwing or vanishing', () => {
    const prd = parsePrdAcs(
      '### REQ-005: Empty\n### REQ-006: Next\n- AC-006-1: something.\n'
    );
    expect(prd.reqs.map((r) => r.id)).toEqual(['REQ-005', 'REQ-006']);
    expect(prd.reqs[0].acs).toEqual([]);
    expect(prd.reqs[1].acs.map((a) => a.id)).toEqual(['AC-006-1']);
  });

  test('a PRD with no frontmatter block resolves documentId/label to null without throwing', () => {
    const prd = parsePrdAcs(
      '# No Frontmatter\n### REQ-001: X\n- AC-001-1: something.\n'
    );
    expect(prd.documentId).toBeNull();
    expect(prd.label).toBeNull();
    expect(prd.reqs[0].acs.map((a) => a.id)).toEqual(['AC-001-1']);
  });

  test('an AC-shaped bullet before any REQ heading is dropped, not attributed to a later REQ', () => {
    const prd = parsePrdAcs(
      '- AC-999-1: orphan, not under any requirement.\n### REQ-001: Title\n- AC-001-1: real ac.\n'
    );
    expect(prd.reqs).toHaveLength(1);
    expect(prd.reqs[0].id).toBe('REQ-001');
    expect(prd.reqs[0].acs.map((a) => a.id)).toEqual(['AC-001-1']);
  });
});

describe('parsePrdAcs (sanity check against the real PRD)', () => {
  test('parses PRD-2026-da72aa86 without error and finds all 17 REQs', () => {
    const realPrdPath = path.join(
      __dirname,
      '../../../docs/PRD/PRD-2026-da72aa86-interactive-playwright-test-authoring.md'
    );
    const realPrd = fs.readFileSync(realPrdPath, 'utf8');
    expect(() => parsePrdAcs(realPrd)).not.toThrow();
    const prd = parsePrdAcs(realPrd);
    expect(prd.reqs).toHaveLength(17);
  });
});
