/**
 * Shared test helpers for team-based execution model tests.
 *
 * Extracts functions that were previously duplicated across multiple test files.
 * Each function is exported as a named export for selective import.
 */

'use strict';
const { parseSubState } = require('../../lib/parse-sub-state');



// ---------------------------------------------------------------------------
// parseTeamConfig - Team YAML parser
// ---------------------------------------------------------------------------

/**
 * Parses the `team:` section of a command YAML (already loaded as a JS object)
 * and returns a normalized team configuration.
 *
 * The 8-role schema accepts the following role names:
 *   - lead         (REQUIRED)  - tech-lead-orchestrator
 *   - builder      (REQUIRED)  - backend/frontend/infra/etc. developers
 *   - architect    (REQUIRED)  - per-task design (architect agent)
 *   - reviewer     (optional)  - code-reviewer
 *   - qa           (optional)  - qa-orchestrator
 *   - advisor      (optional)  - cross-cutting solution quality review
 *   - pm           (optional)  - in-pipeline requirement clarification
 *   - documentation (REQUIRED) - documentation-specialist (PR-boundary doc hook)
 *
 * Required roles: lead, builder, architect, documentation.
 * Optional roles: reviewer, qa, advisor, pm.
 *
 * @param {Object|undefined|null} yamlTeamSection - The `team:` object from parsed YAML
 * @returns {{ teamMode: boolean, teamRoles: Object, reviewerEnabled: boolean, qaEnabled: boolean, advisorEnabled: boolean, pmEnabled: boolean }}
 * @throws {Error} if required roles (lead, builder, architect, documentation) are missing
 */
function parseTeamConfig(yamlTeamSection) {
  if (!yamlTeamSection) {
    return {
      teamMode: false,
      teamRoles: {},
      reviewerEnabled: false,
      qaEnabled: false,
      advisorEnabled: false,
      pmEnabled: false,
    };
  }

  const roles = yamlTeamSection.roles || [];
  const teamRoles = {};

  for (const role of roles) {
    const agents =
      role.agents ||
      (role.agent ? [role.agent] : []);

    teamRoles[role.name] = {
      agents,
      owns: role.owns || [],
    };
  }

  if (!teamRoles.lead) {
    throw new Error("team.roles must include a 'lead' role");
  }
  if (!teamRoles.builder) {
    throw new Error("team.roles must include a 'builder' role");
  }
  if (!teamRoles.architect) {
    throw new Error("team.roles must include an 'architect' role");
  }
  if (!teamRoles.documentation) {
    throw new Error("team.roles must include a 'documentation' role");
  }

  return {
    teamMode: true,
    teamRoles,
    reviewerEnabled: !!teamRoles.reviewer,
    qaEnabled: !!teamRoles.qa,
    advisorEnabled: !!teamRoles.advisor,
    pmEnabled: !!teamRoles.pm,
  };
}
/**
 * Valid state transitions for the bead sub-state machine.
 *
 * open               -> in_progress       (builder claims task)
 * in_progress        -> in_design         (builder escalates: needs-design)
 * in_progress        -> in_review         (builder submits for review)
 * in_progress        -> in_qa             (lead skips review via skip-review)
 * in_progress        -> closed            (lead skips all stages)
 * in_progress        -> in_clarification  (any role needs clarification)
 * in_design          -> in_progress       (architect returns design)
 * in_review          -> in_progress       (reviewer rejects)
 * in_review          -> in_advisory       (reviewer approves; advisor must review)
 * in_review          -> in_clarification  (reviewer escalates to pm)
 * in_advisory        -> in_qa             (advisor approves)
 * in_advisory        -> in_progress       (advisor vetoes)
 * in_qa              -> closed            (QA passes)
 * in_qa              -> in_progress       (QA rejects)
 * in_qa              -> in_clarification  (QA escalates to pm)
 * in_clarification   -> in_progress       (PM returns clarification)
 * closed             -> in_advisory       (advisor can re-open a closed task)
 */
const VALID_TRANSITIONS = {
  open: ['in_progress'],
  in_progress: ['in_design', 'in_review', 'in_qa', 'closed', 'in_clarification'],
  in_design: ['in_progress'],
  in_review: ['in_progress', 'in_advisory', 'in_clarification'],
  in_advisory: ['in_qa', 'in_progress'],
  in_qa: ['closed', 'in_progress', 'in_clarification'],
  in_clarification: ['in_progress'],
  closed: ['in_advisory'],
};

// ---------------------------------------------------------------------------
// validateTransition - State machine validator
// ---------------------------------------------------------------------------

/**
 * Returns true if transitioning from currentState to targetState is allowed.
 *
 * @param {string} currentState
 * @param {string} targetState
 * @returns {boolean}
 */
function validateTransition(currentState, targetState) {
  const allowed = VALID_TRANSITIONS[currentState] || [];
  return allowed.includes(targetState);
}

// ---------------------------------------------------------------------------
// countRejections - Rejection cycle counter
// ---------------------------------------------------------------------------

/**
 * Count how many times verdict:rejected appears in a comment list output.
 * Used to detect when the rejection cycle limit (MAX_REJECTIONS) has been hit.
 *
 * Respects lead-reset:true baseline -- if present, only rejections AFTER the
 * most recent lead-reset:true line are counted.
 *
 * @param {string} commentListOutput - Raw stdout from `br comment list`
 * @returns {number}
 */
function countRejections(commentListOutput) {
  if (!commentListOutput || typeof commentListOutput !== 'string') return 0;
  const lines = commentListOutput.split('\n');
  let baselineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('lead-reset:true')) baselineIndex = i;
  }
  const relevantLines = lines.slice(baselineIndex + 1);
  return (relevantLines.join('\n').match(/verdict:rejected/g) || []).length;
}

// ---------------------------------------------------------------------------
// requiresEscalation - Escalation threshold check
// ---------------------------------------------------------------------------

/** Maximum rejection cycles before lead escalation is required. */
const MAX_REJECTIONS = 2;

/**
 * Returns true when the rejection count has reached or exceeded MAX_REJECTIONS,
 * indicating that the lead must intervene before re-assigning the task.
 *
 * @param {number} rejectionCount
 * @returns {boolean}
 */
function requiresEscalation(rejectionCount) {
  return rejectionCount >= MAX_REJECTIONS;
}

// ---------------------------------------------------------------------------
// selectBuilder - Keyword-based builder selection
// ---------------------------------------------------------------------------

const BACKEND_KEYWORDS = ['backend', 'api', 'database', 'server', 'model', 'migration'];
const FRONTEND_KEYWORDS = ['frontend', 'ui', 'component', 'react', 'vue', 'css'];
const INFRA_KEYWORDS = ['infra', 'deploy', 'docker', 'k8s', 'aws'];
const DOCS_KEYWORDS = ['docs', 'documentation', 'readme'];

/**
 * Selects the most appropriate builder agent for a task based on keywords.
 *
 * @param {string[]} taskKeywords
 * @param {string[]} builderAgents
 * @returns {string} selected agent name
 */
function selectBuilder(taskKeywords, builderAgents) {
  for (const kw of taskKeywords) {
    if (BACKEND_KEYWORDS.includes(kw) && builderAgents.includes('backend-developer')) return 'backend-developer';
    if (FRONTEND_KEYWORDS.includes(kw) && builderAgents.includes('frontend-developer')) return 'frontend-developer';
    if (INFRA_KEYWORDS.includes(kw) && builderAgents.includes('infrastructure-developer')) return 'infrastructure-developer';
    if (DOCS_KEYWORDS.includes(kw) && builderAgents.includes('backend-developer')) return 'backend-developer';
  }
  return builderAgents[0]; // Default to first builder
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  parseSubState,
  parseTeamConfig,
  VALID_TRANSITIONS,
  validateTransition,
  countRejections,
  MAX_REJECTIONS,
  requiresEscalation,
  selectBuilder,
  BACKEND_KEYWORDS,
  FRONTEND_KEYWORDS,
  INFRA_KEYWORDS,
  DOCS_KEYWORDS,
};
