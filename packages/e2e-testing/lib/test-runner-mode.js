'use strict';

/**
 * TRD-011: mode-aware run-config resolution for
 * /ensemble:author-playwright-tests.
 *
 * Pure mapping/config-resolution logic only — this module does not launch
 * Playwright itself (that's runtime behavior when the real session runs
 * against a real target app). It answers one question: given the session's
 * mode (TRD-007's 'headed'|'headless' choice, threaded through
 * delegation-contract.js's `mode` field), what auth strategy and launch
 * config should the test run use?
 *
 * - headed: Sonia's own interactive Entra ID login. No stored credentials —
 *   she logs in live and watches the run (AC-013-3).
 * - headless: authenticate via the existing `cribs-e2e-auth-state.json`
 *   storage-state file — the same mechanism the unattended nightly
 *   regression suite already uses, since no human is present to log in
 *   interactively (AC-013-4, TRD-011 Implementation AC). That file lives in
 *   the consuming CRIBS project, not this repo — this module only ever
 *   references its path, never reads/creates it.
 *
 * Convention: plain functions over plain data, matching this package's
 * existing modules (ac-decision-loop.js, delegation-contract.js,
 * req-batcher.js) — strict validation, no silent defaulting.
 */

const VALID_MODES = ['headed', 'headless'];

/**
 * @typedef {Object} RunConfig
 * @property {'headed'|'headless'} mode
 * @property {boolean} headless - Playwright launch option mirroring mode
 * @property {Object} auth
 * @property {'interactive-entra-login'|'stored-storage-state'} auth.strategy
 * @property {string|null} auth.authStatePath - path to `cribs-e2e-auth-state.json`
 *   when mode is 'headless'; null when mode is 'headed' (no stored state used)
 */

/**
 * Resolve the auth/launch config a test run should use for the given mode.
 *
 * @param {'headed'|'headless'} mode - session-wide execution mode (TRD-007)
 * @param {string} [authStatePath] - path to the consuming project's stored
 *   `cribs-e2e-auth-state.json`; required when mode is 'headless', ignored
 *   when mode is 'headed'
 * @returns {RunConfig}
 * @throws {Error} if mode is not exactly 'headed'|'headless' (no silent
 *   default), or if mode is 'headless' with no authStatePath provided (can't
 *   run headless with no stored auth state — reported as a clear error
 *   rather than silently falling back to headed or crashing obscurely)
 */
function resolveRunConfig(mode, authStatePath) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid mode '${mode}': must be one of ${VALID_MODES.map((m) => `'${m}'`).join(', ')}`);
  }

  if (mode === 'headed') {
    return {
      mode: 'headed',
      headless: false,
      auth: { strategy: 'interactive-entra-login', authStatePath: null },
    };
  }

  // headless
  if (typeof authStatePath !== 'string' || authStatePath.trim() === '') {
    throw new Error(
      "headless mode requires authStatePath (path to the stored 'cribs-e2e-auth-state.json') — " +
        'cannot run headless with no stored auth state'
    );
  }

  return {
    mode: 'headless',
    headless: true,
    auth: { strategy: 'stored-storage-state', authStatePath },
  };
}

module.exports = { resolveRunConfig, VALID_MODES };

// ponytail self-check: `node packages/e2e-testing/lib/test-runner-mode.js`
// exercises both mode paths plus the invalid-mode and missing-authStatePath
// guards, without a separate test file (TRD-011-TEST is a later task).
if (require.main === module) {
  const assert = require('assert');

  // headed: no authStatePath needed, auth.authStatePath is explicitly null
  assert.deepStrictEqual(resolveRunConfig('headed'), {
    mode: 'headed',
    headless: false,
    auth: { strategy: 'interactive-entra-login', authStatePath: null },
  });
  // authStatePath is ignored (not required) when headed
  assert.deepStrictEqual(resolveRunConfig('headed', '/some/path.json').auth.authStatePath, null);

  // headless: authStatePath required and threaded through
  assert.deepStrictEqual(resolveRunConfig('headless', '/secure/cribs-e2e-auth-state.json'), {
    mode: 'headless',
    headless: true,
    auth: { strategy: 'stored-storage-state', authStatePath: '/secure/cribs-e2e-auth-state.json' },
  });

  // headless with no authStatePath -> clear error, not a silent fallback to headed
  assert.throws(() => resolveRunConfig('headless'), /requires authStatePath/);
  assert.throws(() => resolveRunConfig('headless', ''), /requires authStatePath/);
  assert.throws(() => resolveRunConfig('headless', '   '), /requires authStatePath/);

  // invalid/typo'd mode -> never silently defaulted (matches ac-decision-loop.js's philosophy)
  assert.throws(() => resolveRunConfig('slow'), /Invalid mode 'slow'/);
  assert.throws(() => resolveRunConfig('Headed')); // case-sensitive, no fuzzy match
  assert.throws(() => resolveRunConfig());

  console.log('test-runner-mode.js self-check passed');
}
