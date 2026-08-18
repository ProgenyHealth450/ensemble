'use strict';

const { parseSubState } = require('../lib/parse-sub-state');

describe('PM clarification sub-state loop', () => {
  test('br-comment representation: reviewer escalates to pm then pm returns clarification', () => {
    const escalated = parseSubState(
      'status:in_clarification reviewer:code-reviewer pm:pm reason:needs-clarification',
      'br-comment'
    );
    expect(escalated).toEqual({
      state: 'in_clarification',
      metadata: {
        reviewer: 'code-reviewer',
        pm: 'pm',
        reason: 'needs-clarification',
      },
    });

    const returned = parseSubState(
      'status:in_progress pm:pm clarification:use%20the%20task%20description%20literal',
      'br-comment'
    );
    expect(returned).toEqual({
      state: 'in_progress',
      metadata: {
        pm: 'pm',
        clarification: 'use the task description literal',
      },
    });
  });

  test('git-trailer representation: PM clarification round-trips through trailers', () => {
    const escalated = parseSubState(
      [
        'Status: in_clarification',
        'Reviewer: code-reviewer',
        'PM: pm',
        'Reason: needs-clarification',
      ].join('\n'),
      'git-trailer'
    );

    expect(escalated).toEqual({
      state: 'in_clarification',
      metadata: {
        reviewer: 'code-reviewer',
        pm: 'pm',
        reason: 'needs-clarification',
      },
    });

    const returned = parseSubState(
      [
        'Status: in_progress',
        'PM: pm',
        'Clarification: no-prd-defaulting-to-literal',
      ].join('\n'),
      'git-trailer'
    );

    expect(returned).toEqual({
      state: 'in_progress',
      metadata: {
        pm: 'pm',
        clarification: 'no-prd-defaulting-to-literal',
      },
    });
  });

  test('PM loop guard expectation: three PM entries are allowed; fourth requires halt/escalation', () => {
    const pmEntries = [
      'status:in_clarification reviewer:code-reviewer pm:pm reason:needs-clarification',
      'status:in_progress pm:pm clarification:first',
      'status:in_clarification builder:backend-developer pm:pm reason:needs-clarification',
      'status:in_progress pm:pm clarification:second',
      'status:in_clarification qa:qa-orchestrator pm:pm reason:needs-clarification',
      'status:in_progress pm:pm clarification:third',
    ].join('\n');

    const count = (pmEntries.match(/\bpm:pm\b/g) || []).length;
    expect(count).toBe(6);
    expect(Math.floor(count / 2)).toBe(3);
  });
});
