'use strict';

const { parseSubState } = require('../lib/parse-sub-state');

describe('parseSubState shared module', () => {
  describe('br-comment format', () => {
    test('parses latest status line and decodes reason', () => {
      const raw = [
        'status:in_review builder:backend-developer files:src/api.ts',
        'status:in_progress reviewer:code-reviewer verdict:rejected reason:missing-input-validation',
        'status:in_advisory reviewer:code-reviewer advisor:advisor verdict:approved',
      ].join('\n');

      expect(parseSubState(raw, 'br-comment')).toEqual({
        state: 'in_advisory',
        metadata: {
          reviewer: 'code-reviewer',
          advisor: 'advisor',
          verdict: 'approved',
        },
      });
    });

    test('parses clarification and decodes URL-encoded text', () => {
      const raw = 'status:in_progress pm:pm clarification:use%20the%20task%20description%20literal';
      expect(parseSubState(raw, 'br-comment')).toEqual({
        state: 'in_progress',
        metadata: {
          pm: 'pm',
          clarification: 'use the task description literal',
        },
      });
    });

    test('returns null for malformed input without status token', () => {
      expect(parseSubState('just a normal comment', 'br-comment')).toBeNull();
    });
  });

  describe('git-trailer format', () => {
    test('parses trailer block and normalizes keys', () => {
      const raw = [
        'Implements TRD-123.',
        '',
        'Status: in_qa',
        'Builder: backend-developer',
        'Reviewer: code-reviewer',
        'Advisor: advisor',
        'Verdict: approved',
        'Files: src/api.ts,src/api.test.ts',
        'Lead: tech-lead-orchestrator',
      ].join('\n');

      expect(parseSubState(raw, 'git-trailer')).toEqual({
        state: 'in_qa',
        metadata: {
          builder: 'backend-developer',
          reviewer: 'code-reviewer',
          advisor: 'advisor',
          verdict: 'approved',
          files: 'src/api.ts,src/api.test.ts',
          lead: 'tech-lead-orchestrator',
        },
      });
    });

    test('uses the latest Status block when multiple exist', () => {
      const raw = [
        'Status: in_review',
        'Builder: backend-developer',
        '',
        'Status: in_clarification',
        'PM: pm',
        'Clarification: use the PRD non-goals section',
      ].join('\n');

      expect(parseSubState(raw, 'git-trailer')).toEqual({
        state: 'in_clarification',
        metadata: {
          pm: 'pm',
          clarification: 'use the PRD non-goals section',
        },
      });
    });

    test('returns null when Status trailer is absent', () => {
      const raw = [
        'Builder: backend-developer',
        'Reviewer: code-reviewer',
      ].join('\n');
      expect(parseSubState(raw, 'git-trailer')).toBeNull();
    });
  });

  describe('shape parity', () => {
    test('returns the same normalized shape for equivalent br-comment and git-trailer representations', () => {
      const brComment = 'status:in_qa builder:backend-developer reviewer:code-reviewer verdict:approved';
      const gitTrailer = [
        'Status: in_qa',
        'Builder: backend-developer',
        'Reviewer: code-reviewer',
        'Verdict: approved',
      ].join('\n');

      expect(parseSubState(brComment, 'br-comment')).toEqual(
        parseSubState(gitTrailer, 'git-trailer')
      );
    });
  });

  describe('format validation', () => {
    test('throws on unsupported format', () => {
      expect(() => parseSubState('Status: in_qa', 'json')).toThrow(
        'Unsupported parseSubState format: json'
      );
    });
  });
});
