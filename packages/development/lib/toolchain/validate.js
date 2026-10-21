'use strict';

/**
 * Adapter manifest validation (TRD-2026-8d825f54 TRD-005/TRD-008, PRD REQ-005, REQ-022,
 * REQ-023).
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
 *
 * `validateAllowlist(manifest)` checks that every capability and health check's `run` argv
 * (including variant run templates) calls a binary declared in the manifest's `binaries` and
 * a subcommand declared in that binary's `allowlist[].sub` (TRD-008, PRD REQ-023 AC-023-1,
 * AC-023-3). `scanCredentials(files)` rejects literal credentials in adapter manifests,
 * `SKILL.md` and toolchain config files: well-known secret token prefixes anywhere in the
 * file, and credential-shaped keys (`password`, `secret`, `token`, `api_key`, `apikey`,
 * `access_key`, `private_key`, `client_secret`, `auth`, `bearer`) set to literal values;
 * environment variable names (`env: [NAME]`, `${NAME}` interpolation, a bare uppercase
 * identifier) are permitted (TRD-008, PRD REQ-022 AC-022-1).
 *
 * ## Known limits
 *
 * `validateAllowlist` enforces the allowlist at binary-plus-subcommand level by design: it
 * checks `run[0]` (the binary) and `run[1]` (the subcommand) only. Later argv elements — flags,
 * option values, substituted template arguments, script names — are not constrained by this
 * static check; the runtime runner (TRD-010) validates substituted arguments against each
 * capability's declared contract input types before every call. Do not add argument-level
 * constraints to the static validator.
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

const CREDENTIAL_PREFIX_PATTERNS = [
  /ghp_[A-Za-z0-9]{36,}/,
  /gho_[A-Za-z0-9]{36,}/,
  /ghu_[A-Za-z0-9]{36,}/,
  /ghs_[A-Za-z0-9]{36,}/,
  /ghr_[A-Za-z0-9]{36,}/,
  /glpat-[A-Za-z0-9_-]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /ASIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z-_]{35}/,
  /xox[baprs]-[0-9A-Za-z-]{10,}/
];

/**
 * Credential-shaped key names: a literal (non-env-reference) value on one of these keys is
 * rejected by `scanCredentials` (TRD-008, PRD REQ-022 AC-022-1).
 */
const CREDENTIAL_KEY_NAMES = [
  'password',
  'secret',
  'token',
  'api_key',
  'apikey',
  'access_key',
  'private_key',
  'client_secret',
  'auth',
  'bearer'
];

const CREDENTIAL_KEY_LINE = new RegExp(`^\\s*(?:-\\s*)?(${CREDENTIAL_KEY_NAMES.join('|')})\\s*:\\s*(.+?)\\s*$`, 'i');

/**
 * Decide whether a credential-shaped key's value names an environment variable rather than
 * holding a literal credential: `${NAME}` interpolation or a bare uppercase identifier (PRD
 * REQ-022: "permitting env var names").
 *
 * @param {string} rawValue the value half of a `key: value` line, already trimmed
 * @returns {boolean}
 */
function isEnvReference(rawValue) {
  const unquoted = rawValue.replace(/^['"]|['"]$/g, '');
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(unquoted) || /^[A-Z][A-Z0-9_]*$/.test(unquoted);
}

const YAML_FILE_PATTERN = /\.ya?ml$/i;
const FENCE_LINE = /^\s*```/;

/**
 * Extract the lines inside fenced code blocks (opening/closing `` ``` `` markers) of a
 * Markdown file. Used to scope the credential-shaped key/value heuristic to code examples in
 * `SKILL.md`, not prose, which otherwise produces false positives on sentences or
 * documentation labels that happen to look like `key: value` (TRD-008 review finding; PRD
 * REQ-022).
 *
 * @param {string} content full Markdown file content
 * @returns {string[]} lines found strictly between fence markers
 */
function extractFencedCodeBlockLines(content) {
  const lines = [];
  let inFence = false;
  for (const line of content.split(/\r?\n/)) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      lines.push(line);
    }
  }
  return lines;
}

/**
 * Validate that every capability and health check's `run` argv (including per-capability
 * `variants` run templates) starts with a binary declared in `manifest.binaries` and that its
 * second element is a subcommand declared in that binary's `allowlist[].sub` entry (TRD-008,
 * PRD REQ-023 AC-023-1, AC-023-3). See `## Known limits` in the module doc above: argv
 * elements beyond `run[0]`/`run[1]` are not constrained here.
 *
 * @param {object} manifest a parsed adapter manifest (see adapter-manifest-schema.json)
 * @returns {{valid: true, errors: []} | {valid: false, errors: string[]}}
 */
function validateAllowlist(manifest) {
  const adapterId = (manifest && manifest.adapter) || '(unknown adapter)';
  const binaries = (manifest && Array.isArray(manifest.binaries) && manifest.binaries) || [];
  const allowlist = (manifest && Array.isArray(manifest.allowlist) && manifest.allowlist) || [];
  const errors = [];

  function checkRun(label, run) {
    if (!Array.isArray(run) || run.length === 0) {
      return;
    }
    const bin = run[0];
    if (!binaries.includes(bin)) {
      errors.push(`${adapterId}: ${label} calls binary '${bin}' which is not declared in 'binaries'`);
      return;
    }
    const entry = allowlist.find((candidate) => candidate && candidate.bin === bin);
    if (!entry) {
      errors.push(`${adapterId}: ${label} calls '${bin}' but '${bin}' has no 'allowlist' entry at all`);
      return;
    }
    const sub = run.length > 1 ? run[1] : undefined;
    if (sub === undefined) {
      errors.push(`${adapterId}: ${label} calls '${bin}' with no subcommand to validate against its allowlist`);
      return;
    }
    const allowedSubs = (Array.isArray(entry.sub) && entry.sub) || [];
    if (!allowedSubs.includes(sub)) {
      errors.push(
        `${adapterId}: ${label} calls '${bin} ${sub}' but subcommand '${sub}' is not in the allowlist for '${bin}'`
      );
    }
  }

  for (const check of (manifest && manifest.health) || []) {
    if (check && check.id) {
      checkRun(`health check '${check.id}'`, check.run);
    }
  }

  for (const [capabilityId, capability] of Object.entries((manifest && manifest.capabilities) || {})) {
    if (!capability || typeof capability !== 'object') {
      continue;
    }
    checkRun(`capability '${capabilityId}'`, capability.run);
    if (capability.variants && typeof capability.variants === 'object') {
      for (const [selectorArg, valueMap] of Object.entries(capability.variants)) {
        if (!valueMap || typeof valueMap !== 'object') {
          continue;
        }
        for (const [value, variantRun] of Object.entries(valueMap)) {
          checkRun(`capability '${capabilityId}' variant '${selectorArg}=${value}'`, variantRun);
        }
      }
    }
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

/**
 * Reject files containing literal credentials: a well-known secret token prefix anywhere in
 * the file, or a credential-shaped key (`password`, `secret`, `token`, `api_key`, `apikey`,
 * `access_key`, `private_key`, `client_secret`, `auth`, `bearer`) set to a literal
 * (non-env-reference) value (TRD-008, PRD REQ-022 AC-022-1). Environment variable names are
 * permitted: `env: [NAME]` entries are never scanned as key/value pairs, and `${NAME}`
 * interpolation or a bare uppercase identifier value is not treated as a literal.
 *
 * The well-known-prefix scan always runs on the whole file. The credential-shaped key/value
 * heuristic is scoped to reduce false positives: on YAML files (`adapter.yaml`, toolchain
 * config) it runs on every line; on `SKILL.md` and other Markdown files it runs only on lines
 * inside fenced code blocks, so prose or documentation labels that happen to look like
 * `key: value` (for example "Auth: handled by the CLI's credential helper") are not flagged.
 *
 * @param {string[]} files absolute paths to adapter.yaml, SKILL.md or toolchain config files
 * @returns {{valid: true, errors: []} | {valid: false, errors: string[]}}
 */
function scanCredentials(files) {
  const errors = [];
  for (const filePath of files) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      errors.push(`${filePath}: unreadable (${error.code || error.message})`);
      continue;
    }

    if (CREDENTIAL_PREFIX_PATTERNS.some((pattern) => pattern.test(content))) {
      errors.push(`${filePath}: contains a literal credential matching a well-known secret token pattern`);
      continue;
    }

    const linesToScan = YAML_FILE_PATTERN.test(filePath)
      ? content.split(/\r?\n/)
      : extractFencedCodeBlockLines(content);
    const offendingLine = linesToScan
      .map((line) => CREDENTIAL_KEY_LINE.exec(line))
      .find((match) => match && !isEnvReference(match[2]));
    if (offendingLine) {
      errors.push(
        `${filePath}: '${offendingLine[1]}' is set to a literal value; use an environment variable name instead`
      );
    }
  }
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

module.exports = {
  validateManifest,
  checkVocabularyBlock,
  validateAllowlist,
  scanCredentials,
  ADAPTER_MANIFEST_SCHEMA_PATH
};
