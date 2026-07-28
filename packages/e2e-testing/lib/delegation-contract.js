'use strict';

/**
 * TRD-008: orchestrator <-> @playwright-tester delegation contract for
 * /ensemble:author-playwright-tests.
 *
 * Plain data shapes (no class hierarchy, no schema library) describing what
 * the author-playwright-tests session's orchestrating agent sends when it
 * delegates "propose/author one Playwright test for this AC" to
 * @playwright-tester, and what @playwright-tester must send back.
 *
 * Implementation AC (TRD-008): given a delegation request (AC text,
 * grounding diff, target env, mode), when @playwright-tester responds, the
 * response includes a proposed test, selectors used, and a run result OR an
 * explicit authoring-failure flag — never silently omitted.
 *
 * Follows this package's existing convention (pr-state.js,
 * implementation-grounding.js, resume-scan.js, prd-ac-parser.js): plain
 * exported functions over plain objects, no external validation library.
 *
 * Field-name mapping from the TRD's Architecture Design pseudocode (line 53,
 * `{ proposed_test, selectors, run_result: pass|fail, authoring_failure? }`)
 * to this module's camelCase shapes, for readers cross-referencing the TRD:
 * proposed_test -> proposedTest, selectors -> selectorsUsed,
 * run_result -> runResult, authoring_failure -> runResult.authoringFailure
 * (folded into runResult as a discriminated union rather than a sibling
 * optional field, so exactly one of pass/fail-or-authoring-failure is ever
 * set — see RunResult/AuthoringFailure typedefs below).
 */

/**
 * @typedef {Object} DelegationRequest
 * @property {string} acText - the PRD acceptance-criterion text to author a test for
 * @property {*} groundingDiff - the implementation-grounding.js result (or its `gap` shape)
 *   grounding this AC in the real implementing diff, not PRD prose alone
 * @property {string} targetEnv - QA environment base URL/identifier to run the test against
 * @property {'headed'|'headless'} mode - session-wide execution mode chosen at session start
 *   (TRD-007) — controls ONLY whether a human is watching, never the auth strategy (TRD-037)
 * @property {string} [authStatePath] - TRD-036/TRD-037: the environment-scoped auth-state path
 *   (test-runner-mode.js's deriveAuthStatePath() output), used regardless of mode when the
 *   consuming repo has one — many real harnesses reuse one stored auth state for every run,
 *   headed or headless alike; optional, since not every target needs one (headed can still fall
 *   back to a live interactive login when omitted; headless has no such fallback)
 */

/**
 * @typedef {Object} RunResult
 * A pass/fail outcome from actually executing the proposed test.
 * @property {boolean} passed
 * @property {string} [details] - failure details, console errors, etc. when passed is false
 * @property {boolean} [environmentMismatchSuspected] - TRD-035: only meaningful when passed
 *   is false. True when NONE of groundedMarkersChecked were found on the live page — the
 *   leading hypothesis for the failure should be "this environment may not be running the
 *   branch under test," not "the implementation is broken" (see grounded-marker-checker.js;
 *   found live-dogfooding this feature: a reachable-but-wrong environment produces failures
 *   indistinguishable from a real regression otherwise).
 * @property {string[]} [groundedMarkersChecked] - the candidate markers
 *   (grounded-marker-checker.js's extractGroundedMarkers() output) that were looked for on
 *   the live page when the test failed
 */

/**
 * @typedef {Object} AuthoringFailure
 * Explicit flag for when @playwright-tester could not author/run a test at
 * all (e.g. no locatable selector, unreachable env) — distinct from a test
 * that ran and failed. Must never be silently omitted in favor of a bare
 * failed RunResult.
 * @property {true} authoringFailure
 * @property {string} reason
 */

/**
 * @typedef {Object} DelegationResponse
 * @property {string} proposedTest - the authored Playwright test source
 * @property {string[]} selectorsUsed - selectors the proposed test relies on
 * @property {RunResult|AuthoringFailure} runResult - either a pass/fail run result
 *   or an explicit authoring-failure flag; one of the two is always present
 */

/** Throw a single clear error listing every problem found, or return true. */
function assertNoErrors(label, errors) {
  if (errors.length > 0) {
    throw new Error(`Invalid ${label}: ${errors.join('; ')}`);
  }
  return true;
}

/**
 * Validate a delegation request before handing it to @playwright-tester.
 *
 * @param {DelegationRequest} req
 * @returns {true} when valid
 * @throws {Error} listing every missing/invalid field, when invalid
 */
function validateDelegationRequest(req) {
  const errors = [];

  if (!req || typeof req !== 'object') {
    return assertNoErrors('delegation request', ['request must be an object']);
  }

  if (typeof req.acText !== 'string' || req.acText.trim() === '') {
    errors.push('acText must be a non-empty string');
  }
  if (req.groundingDiff === undefined || req.groundingDiff === null) {
    errors.push('groundingDiff is required (pass the implementation-grounding.js result, including its gap shape)');
  }
  if (typeof req.targetEnv !== 'string' || req.targetEnv.trim() === '') {
    errors.push('targetEnv must be a non-empty string');
  }
  if (req.mode !== 'headed' && req.mode !== 'headless') {
    errors.push("mode must be 'headed' or 'headless'");
  }
  if (req.authStatePath !== undefined && (typeof req.authStatePath !== 'string' || req.authStatePath.trim() === '')) {
    errors.push('authStatePath must be a non-empty string when present');
  }

  return assertNoErrors('delegation request', errors);
}

/**
 * Validate a delegation response from @playwright-tester before the
 * orchestrator acts on it.
 *
 * @param {DelegationResponse} res
 * @returns {true} when valid
 * @throws {Error} listing every missing/invalid field, when invalid
 */
function validateDelegationResponse(res) {
  const errors = [];

  if (!res || typeof res !== 'object') {
    return assertNoErrors('delegation response', ['response must be an object']);
  }

  if (typeof res.proposedTest !== 'string' || res.proposedTest.trim() === '') {
    errors.push('proposedTest must be a non-empty string');
  }
  if (!Array.isArray(res.selectorsUsed)) {
    errors.push('selectorsUsed must be an array (may be empty, but must be present)');
  }

  if (res.runResult === undefined || res.runResult === null || typeof res.runResult !== 'object') {
    errors.push(
      'runResult is required and must be either a pass/fail result object ({passed: boolean, ...}) ' +
        "or an explicit authoring-failure flag ({authoringFailure: true, reason: '...'}) — never omitted"
    );
  } else if (res.runResult.authoringFailure === true) {
    if (typeof res.runResult.reason !== 'string' || res.runResult.reason.trim() === '') {
      errors.push('runResult.authoringFailure requires a non-empty runResult.reason');
    }
  } else if (typeof res.runResult.passed !== 'boolean') {
    errors.push(
      'runResult must have a boolean `passed` field, or be an explicit ' +
        "{authoringFailure: true, reason: '...'} flag"
    );
  } else {
    if (
      res.runResult.environmentMismatchSuspected !== undefined &&
      typeof res.runResult.environmentMismatchSuspected !== 'boolean'
    ) {
      errors.push('runResult.environmentMismatchSuspected must be a boolean when present');
    }
    if (res.runResult.groundedMarkersChecked !== undefined && !Array.isArray(res.runResult.groundedMarkersChecked)) {
      errors.push('runResult.groundedMarkersChecked must be an array when present');
    }
    if (res.runResult.environmentMismatchSuspected === true && res.runResult.passed !== false) {
      errors.push('runResult.environmentMismatchSuspected may only be true when passed is false');
    }
  }

  return assertNoErrors('delegation response', errors);
}

module.exports = { validateDelegationRequest, validateDelegationResponse };
