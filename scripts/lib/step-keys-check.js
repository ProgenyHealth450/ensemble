'use strict';
/**
 * Step-key render gate.
 *
 * A command YAML workflow step may only carry keys the command transformer
 * renders (RENDERED_STEP_KEYS). Anything else -- historically `instructions`,
 * `tool`, `conditional`, `trigger`, `agent`, `model`, `retry` -- never reaches
 * the model, so authors believed they were shipping behavior that was silently
 * dropped (fix-issue shipped ~2,800 unrendered words for months).
 */

const { RENDERED_STEP_KEYS } = require('./command-transformer');

/**
 * @param {object} commandData Parsed command YAML
 * @param {string} filePath Path used in messages
 * @returns {string[]} One message per unrendered key (file, phase, step, key)
 */
function checkStepKeys(commandData, filePath) {
  const failures = [];
  const phases = commandData && commandData.workflow && commandData.workflow.phases;
  if (!Array.isArray(phases)) return failures;

  for (const phase of phases) {
    for (const step of (phase && phase.steps) || []) {
      for (const key of Object.keys(step || {})) {
        if (!RENDERED_STEP_KEYS.includes(key)) {
          failures.push(
            `${filePath}: phase ${phase.order} ("${phase.name}") step ${step.order}: ` +
            `key '${key}' is never rendered by the command transformer (rendered: ${RENDERED_STEP_KEYS.join(', ')}); ` +
            `move needed content into description/actions or delete it`
          );
        }
      }
    }
  }
  return failures;
}

module.exports = { checkStepKeys };
