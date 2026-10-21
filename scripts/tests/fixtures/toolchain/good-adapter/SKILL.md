# Fixture Good Tracker Adapter

Static test fixture for TRD-009 (PRD REQ-008, AC-008-3): a conforming `tracker` adapter
used by `scripts/tests/toolchain-fixtures.test.js` to prove the toolchain validators
(`validateManifest`, `checkVocabularyBlock`, `validateAllowlist`, `scanCredentials`,
`validateConformance`) all pass with zero errors on a well-formed adapter. This is not a
real, installable adapter: `fixture-tool` does not exist as a binary and is never invoked.

## Vocabulary

- show: read a single work item by id
- create: create a new work item
- update: update fields on an existing work item
- close: close a work item
