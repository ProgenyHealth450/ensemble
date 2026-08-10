'use strict';

const { batchByReq, isReqComplete, renderCheckpointSummary } = require('../lib/req-batcher');

const STORY = {
  reqs: [
    {
      id: 'REQ-001',
      acs: [
        { id: 'AC-001-1', text: 'Given a user, when they log in, then they see a dashboard' },
        { id: 'AC-001-2', text: 'Given a user, when they log out, then they see a login page' },
      ],
    },
    {
      id: 'REQ-002',
      acs: [
        { id: 'AC-002-1', text: 'Given an admin, when they delete a user, then it is removed' },
        { id: 'AC-002-2', text: 'Given an admin, when they delete a user, then an audit log is written' },
      ],
    },
  ],
};

describe('batchByReq (AC-004-1: checkpoint triggers once every AC under a REQ is confirmed)', () => {
  test('one REQ fully confirmed, another partially -> allDone flips correctly, in REQ order', () => {
    const result = batchByReq(STORY, ['AC-001-1', 'AC-001-2', 'AC-002-1']);

    expect(result.map((r) => r.reqId)).toEqual(['REQ-001', 'REQ-002']);
    expect(result[0].allDone).toBe(true);
    expect(result[1].allDone).toBe(false);
  });

  test('checkpointSummary is meaningful: names the REQ and a completion count', () => {
    const result = batchByReq(STORY, ['AC-001-1', 'AC-001-2']);
    const summary = result[0].checkpointSummary;

    expect(summary).toBeTruthy();
    expect(summary).toContain('REQ-001');
    expect(summary).toContain('2/2 ACs confirmed');
  });

  test('zero-AC REQ is trivially allDone with an explicit message, not a crash or silent drop', () => {
    const emptyReq = { reqs: [{ id: 'REQ-003', acs: [] }] };
    const result = batchByReq(emptyReq, []);

    expect(result).toHaveLength(1);
    expect(result[0].allDone).toBe(true);
    expect(result[0].checkpointSummary).toContain('REQ-003');
    expect(result[0].checkpointSummary.toLowerCase()).toContain('no acs found');
  });
});

describe('batchByReq (AC-004-2: progress preserved for resume)', () => {
  test('a REQ done before resume stays done, and a REQ completed after resume flips to done', () => {
    // Mid-session: only REQ-001 fully confirmed so far.
    const midSession = batchByReq(STORY, ['AC-001-1', 'AC-001-2']);
    expect(midSession[0].allDone).toBe(true);
    expect(midSession[1].allDone).toBe(false);

    // After resume, more ACs landed (REQ-002 now also complete). REQ-001 must
    // not regress, and REQ-002 must now be reported done.
    const afterResume = batchByReq(STORY, ['AC-001-1', 'AC-001-2', 'AC-002-1', 'AC-002-2']);
    expect(afterResume[0].allDone).toBe(true);
    expect(afterResume[1].allDone).toBe(true);
  });
});

describe('batchByReq / isReqComplete / renderCheckpointSummary (purity)', () => {
  test('same inputs produce same outputs across repeated calls', () => {
    const confirmed = ['AC-001-1', 'AC-001-2'];

    const first = batchByReq(STORY, confirmed);
    const second = batchByReq(STORY, confirmed);
    expect(second).toEqual(first);

    const acs = STORY.reqs[0].acs;
    expect(isReqComplete(acs, confirmed)).toBe(isReqComplete(acs, confirmed));
    expect(renderCheckpointSummary('REQ-001', acs, confirmed)).toBe(
      renderCheckpointSummary('REQ-001', acs, confirmed)
    );

    // Confirm the original STORY fixture wasn't mutated by any prior call.
    expect(STORY.reqs[0].acs).toHaveLength(2);
    expect(STORY.reqs[1].acs).toHaveLength(2);
  });
});
