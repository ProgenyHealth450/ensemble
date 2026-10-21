'use strict';

/**
 * Per-repository local-CI gate configuration validator.
 *
 * Pure: the caller supplies the config source (YAML text or an already-parsed
 * object). FAIL CLOSED: a missing config is a problem (never another repo's
 * defaults), every unknown key, missing required key, wrong type or job that is
 * both included and excluded is reported by name, and no approval set is
 * returned unless the config is fully valid.
 *
 * Result: { ok:true, problems:[], approvalSet } or { ok:false, problems:[...] }.
 * approvalSet = { workflows:[{file, jobs:[{id, matrix}]}],
 *   checks:[{workflow, job, matrix}], excluded:[{workflow, job, reason}],
 *   statusContext, appId, botReview:{ skipped, logins } }
 */

const yaml = require('js-yaml');

const TOP_REQUIRED = ['workflows', 'status_context', 'app_id'];
const TOP_ALLOWED = ['workflows', 'excluded', 'status_context', 'app_id', 'bot_reviewers'];

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isText(v) {
  return typeof v === 'string' && v.trim() !== '';
}
function isScalar(v) {
  return isText(v) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';
}

function checkKeys(obj, allowed, required, where, problems) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) problems.push(`${where}: unknown key "${key}"`);
  }
  for (const key of required) {
    if (!(key in obj)) problems.push(`${where}: missing required key "${key}"`);
  }
}

function expandMatrix(matrix) {
  let combos = [{}];
  for (const key of Object.keys(matrix)) {
    const next = [];
    for (const combo of combos) {
      for (const value of matrix[key]) next.push({ ...combo, [key]: value });
    }
    combos = next;
  }
  return combos;
}

function validateWorkflows(list, problems) {
  const workflows = [];
  if (!Array.isArray(list) || list.length === 0) {
    problems.push('workflows: must be a non-empty list');
    return workflows;
  }
  list.forEach((wf, i) => {
    const where = `workflows[${i}]`;
    if (!isObject(wf)) {
      problems.push(`${where}: must be a mapping`);
      return;
    }
    checkKeys(wf, ['file', 'jobs'], ['file', 'jobs'], where, problems);
    if ('file' in wf && !isText(wf.file)) problems.push(`${where}.file: must be non-empty text`);
    const jobs = [];
    if ('jobs' in wf) {
      if (!Array.isArray(wf.jobs) || wf.jobs.length === 0) {
        problems.push(`${where}.jobs: must be a non-empty list`);
      } else {
        wf.jobs.forEach((job, j) => {
          const jw = `${where}.jobs[${j}]`;
          if (!isObject(job)) {
            problems.push(`${jw}: must be a mapping`);
            return;
          }
          checkKeys(job, ['id', 'matrix'], ['id'], jw, problems);
          if ('id' in job && !isText(job.id)) problems.push(`${jw}.id: must be non-empty text`);
          let matrix = {};
          if ('matrix' in job) {
            if (!isObject(job.matrix) || Object.keys(job.matrix).length === 0) {
              problems.push(`${jw}.matrix: must be a non-empty mapping of lists`);
            } else {
              for (const [k, v] of Object.entries(job.matrix)) {
                if (!Array.isArray(v) || v.length === 0 || !v.every(isScalar)) {
                  problems.push(`${jw}.matrix.${k}: must be a non-empty list of scalar values`);
                }
              }
              matrix = job.matrix;
            }
          }
          if (isText(job.id)) jobs.push({ id: job.id, matrix });
        });
      }
    }
    if (isText(wf.file)) workflows.push({ file: wf.file, jobs });
  });
  return workflows;
}

function validateExcluded(list, problems) {
  const excluded = [];
  if (list === undefined) return excluded;
  if (!Array.isArray(list)) {
    problems.push('excluded: must be a list');
    return excluded;
  }
  list.forEach((ex, i) => {
    const where = `excluded[${i}]`;
    if (!isObject(ex)) {
      problems.push(`${where}: must be a mapping`);
      return;
    }
    checkKeys(ex, ['workflow', 'job', 'reason'], ['workflow', 'job', 'reason'], where, problems);
    for (const k of ['workflow', 'job', 'reason']) {
      if (k in ex && !isText(ex[k])) problems.push(`${where}.${k}: must be non-empty text`);
    }
    if (isText(ex.workflow) && isText(ex.job) && isText(ex.reason)) {
      excluded.push({ workflow: ex.workflow, job: ex.job, reason: ex.reason });
    }
  });
  return excluded;
}

function validateBots(value, problems) {
  if (value === undefined || value === null) return { skipped: true, logins: [] };
  if (!Array.isArray(value) || !value.every(isText)) {
    problems.push('bot_reviewers: must be a list of non-empty logins');
    return { skipped: true, logins: [] };
  }
  const logins = value.map((l) => l.trim());
  return { skipped: logins.length === 0, logins };
}

function validateConfig(source) {
  if (source === undefined || source === null || (typeof source === 'string' && source.trim() === '')) {
    return {
      ok: false,
      problems: ['local CI config is missing (expected .ensemble/local-ci.yaml); no defaults are assumed'],
    };
  }

  let config = source;
  if (typeof source === 'string') {
    try {
      config = yaml.load(source);
    } catch (err) {
      return { ok: false, problems: [`local CI config is not valid YAML: ${err.message}`] };
    }
    if (config === undefined || config === null) {
      return {
        ok: false,
        problems: ['local CI config is missing (expected .ensemble/local-ci.yaml); no defaults are assumed'],
      };
    }
  }
  if (!isObject(config)) {
    return { ok: false, problems: ['local CI config: top level must be a mapping'] };
  }

  const problems = [];
  checkKeys(config, TOP_ALLOWED, TOP_REQUIRED, 'config', problems);

  const workflows = 'workflows' in config ? validateWorkflows(config.workflows, problems) : [];
  const excluded = validateExcluded(config.excluded, problems);

  if ('status_context' in config && !isText(config.status_context)) {
    problems.push('status_context: must be non-empty text');
  }
  let appId = '';
  if ('app_id' in config) {
    const id = config.app_id;
    if (isText(id)) appId = id.trim();
    else if (Number.isInteger(id) && id > 0) appId = String(id);
    else problems.push('app_id: must be a positive integer or non-empty placeholder text');
  }
  const botReview = validateBots(config.bot_reviewers, problems);

  for (const ex of excluded) {
    const wf = workflows.find((w) => w.file === ex.workflow);
    if (wf && wf.jobs.some((j) => j.id === ex.job)) {
      problems.push(`job "${ex.job}" in ${ex.workflow} is both included and excluded`);
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  const checks = [];
  for (const wf of workflows) {
    for (const job of wf.jobs) {
      for (const matrix of expandMatrix(job.matrix)) {
        checks.push({ workflow: wf.file, job: job.id, matrix });
      }
    }
  }

  return {
    ok: true,
    problems: [],
    approvalSet: {
      workflows,
      checks,
      excluded,
      statusContext: config.status_context.trim(),
      appId,
      botReview,
    },
  };
}

module.exports = { validateConfig };
