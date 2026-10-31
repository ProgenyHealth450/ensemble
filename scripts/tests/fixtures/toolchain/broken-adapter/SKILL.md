# Fixture Broken Tracker Adapter

Static test fixture for TRD-009 (PRD REQ-008, AC-008-3): a deliberately broken `tracker`
adapter used by `scripts/tests/toolchain-fixtures.test.js` to prove the toolchain
validators can fail. Not a real, installable adapter. Contains NO real secret: the string
below is an obviously fake token that only matches a well-known secret-token scan pattern
for test purposes.

This fixture carries exactly three deliberate defects, one per validator under test:

1. `tracker.close` (required by the tracker category contract) is not implemented --
   `validateConformance` must fail naming it.
2. `tracker.show`'s run template calls `rogue-tool`, which is not declared in `binaries`
   -- `validateAllowlist` must fail naming it.
3. This file embeds a fake credential-shaped token -- `scanCredentials` must fail naming
   this file: ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE12

## Vocabulary

- show: read a single work item by id
- create: create a new work item
- update: update fields on an existing work item
