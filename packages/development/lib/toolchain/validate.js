'use strict';

/**
 * Adapter manifest validation (TRD-2026-8d825f54 TRD-005, PRD REQ-005).
 *
 * `validateManifest(dir)` structurally validates one adapter directory's `adapter.yaml`
 * against `packages/development/toolchain/schemas/adapter-manifest-schema.json`, requires a
 * `## Vocabulary` block in the adapter's `SKILL.md` (AC-005-2: an adapter is a provider skill,
 * so its vocabulary must be visible in prose, not only in the manifest), and checks that every
 * capability's `variants` selector argument is declared as an input of that capability in its
 * category contract (`packages/development/toolchain/categories/<category>.yaml`, loaded via
 * `./contracts`). This is purely structural/self-consistency validation of one manifest; it
 * does not check conformance against a category contract's full capability set (that is
 * `validateConformance`, TRD-007).
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Ajv = require('ajv');

const { loadContracts } = require('./contracts');

const ADAPTER_MANIFEST_SCHEMA_PATH = path.join(
  __dirname,
  '..',
  '..',
  'toolchain',
  'schemas',
  'adapter-manifest-schema.json'
);

const VOCABULARY_HEADING = /^##\s+Vocabulary\b/m;

let compiledValidator = null;

/**
 * Lazily compile and cache the ajv validator for the adapter manifest schema.
 * @returns {import('ajv').ValidateFunction}
 */
function getValidator() {
  if (!compiledValidator) {
    const schema = JSON.parse(fs.readFileSync(ADAPTER_MANIFEST_SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv({ allErrors: true });
    compiledValidator = ajv.compile(schema);
  }
  return compiledValidator;
}

/**
 * Describe one ajv validation error as a short human-readable fragment that names the
 * offending property (contracts.js / config.js convention).
 *
 * @param {import('ajv').ErrorObject} error
 * @returns {string}
 */
function describeAjvError(error) {
  if (error.keyword === 'required' && error.params && error.params.missingProperty) {
    return `missing required property '${error.params.missingProperty}'`;
  }
  if (error.keyword === 'additionalProperties' && error.params && error.params.additionalProperty) {
    return `unexpected property '${error.params.additionalProperty}'`;
  }
  const atPath = error.instancePath ? error.instancePath.replace(/^\//, '') : '(root)';
  return `${atPath}: ${error.message || 'invalid'}`;
}

/**
 * Require a `## Vocabulary` heading in an adapter's `SKILL.md` (PRD AC-005-2).
 *
 * @param {string} skillMdPath absolute path to the adapter's `SKILL.md`
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function checkVocabularyBlock(skillMdPath) {
  let content;
  try {
    content = fs.readFileSync(skillMdPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: `${skillMdPath}: missing or unreadable (${error.code || error.message}); a '## Vocabulary' block is required`
    };
  }
  if (!VOCABULARY_HEADING.test(content)) {
    return { ok: false, error: `${skillMdPath}: missing required '## Vocabulary' heading` };
  }
  return { ok: true };
}

/**
 * Structurally validate one adapter directory: its `adapter.yaml` against
 * `adapter-manifest-schema.json`, its `SKILL.md` for a `## Vocabulary` block, declared
 * categories against the manifest's own `contract` map, and every capability's `variants`
 * selector argument against the declared inputs of that capability in its category contract.
 *
 * @param {string} dir adapter directory containing `adapter.yaml` and `SKILL.md`
 * @returns {{valid: true, errors: []} | {valid: false, errors: string[]}}
 */
function validateManifest(dir) {
  const manifestPath = path.join(dir, 'adapter.yaml');
  const skillMdPath = path.join(dir, 'SKILL.md');
  const errors = [];

  if (!fs.existsSync(manifestPath)) {
    return { valid: false, errors: [`${manifestPath}: missing (no adapter.yaml)`] };
  }

  let manifest;
  try {
    manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { valid: false, errors: [`${manifestPath}: invalid YAML (${error.message})`] };
  }
  const validate = getValidator();
  if (!validate(manifest)) {
    for (const error of validate.errors) {
      errors.push(`${manifestPath}: ${describeAjvError(error)}`);
    }
  }

  const vocabularyResult = checkVocabularyBlock(skillMdPath);
  if (!vocabularyResult.ok) {
    errors.push(vocabularyResult.error);
  }

  if (manifest && typeof manifest === 'object') {
    if (Array.isArray(manifest.categories) && manifest.contract && typeof manifest.contract === 'object') {
      const categorySet = new Set(manifest.categories);
      for (const category of manifest.categories) {
        if (manifest.contract[category] == null) {
          errors.push(`${manifestPath}: declared category '${category}' has no matching 'contract' entry`);
        }
      }
      for (const contractCategory of Object.keys(manifest.contract)) {
        if (!categorySet.has(contractCategory)) {
          errors.push(
            `${manifestPath}: 'contract' entry for category '${contractCategory}' is not declared in 'categories'`
          );
        }
      }
    }

    if (manifest.capabilities && typeof manifest.capabilities === 'object') {
      const contracts = loadContracts();
      for (const [capabilityId, capability] of Object.entries(manifest.capabilities)) {
        if (!capability || typeof capability !== 'object' || !capability.variants) {
          continue;
        }
        const category = capabilityId.split('.')[0];
        const contract = contracts[`${category}.yaml`];
        const declaredCapability = contract && contract.capabilities && contract.capabilities[capabilityId];
        if (!declaredCapability) {
          errors.push(
            `${manifestPath}: capability '${capabilityId}' declares 'variants' but is not declared in the '${category}' category contract`
          );
          continue;
        }
        const declaredInputs = declaredCapability.inputs || [];
        for (const selectorArg of Object.keys(capability.variants)) {
          if (!declaredInputs.includes(selectorArg)) {
            errors.push(
              `${manifestPath}: capability '${capabilityId}' variants selector '${selectorArg}' is not declared as a contract input`
            );
          }
        }
      }
    }
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

module.exports = {
  validateManifest,
  checkVocabularyBlock,
  ADAPTER_MANIFEST_SCHEMA_PATH
};
