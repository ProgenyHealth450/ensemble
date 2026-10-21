#!/usr/bin/env node
'use strict';
/**
 * Advisory PR size check: counts changed hand-written lines (generated output
 * excluded) between two refs and warns when over a threshold. Exits 0 unless
 * --strict is passed.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_THRESHOLD = 400;

/** Resolve a path git reports for a rename (`a => b` or `pre/{a => b}/post`) to { oldPath, newPath }. */
function resolveRename(p) {
  const join = (...parts) => parts.join('').replace(/\/\//g, '/');
  const brace = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) {
    return { oldPath: join(brace[1], brace[2], brace[4]), newPath: join(brace[1], brace[3], brace[4]) };
  }
  const plain = p.match(/^(.*) => (.*)$/);
  return plain ? { oldPath: plain[1], newPath: plain[2] } : { oldPath: p, newPath: p };
}

/** Parse `git diff --numstat -M` output into [{ path (new), oldPath, added, deleted, binary }]. */
function parseNumstat(text) {
  const files = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    const { oldPath, newPath } = resolveRename(m[3]);
    files.push({
      path: newPath,
      oldPath,
      added: binary ? 0 : Number(m[1]),
      deleted: binary ? 0 : Number(m[2]),
      binary,
    });
  }
  return files;
}

const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'mix.lock', 'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'bun.lock', 'bun.lockb']);

/**
 * True when a path is generated output. Generated command/agent Markdown is
 * only recognised when its source YAML exists (per `exists(path)`): commands/ensemble/X.md
 * has commands/X.yaml; agents/X.md has agents/X.yaml.
 */
function isGenerated(filePath, exists = () => false) {
  const p = filePath.replace(/\\/g, '/');
  if (/^packages\/(pi|codex|opencode)\//.test(p)) return true;
  if (/(^|\/)bundle\//.test(p)) return true;
  if (p.startsWith('.beads/')) return true;
  if (p.endsWith('.min.js')) return true;
  if (LOCKFILES.has(path.posix.basename(p))) return true;

  let m = p.match(/^(packages\/[^/]+\/commands)\/ensemble\/([^/]+)\.md$/);
  if (m) return exists(`${m[1]}/${m[2]}.yaml`);
  m = p.match(/^(packages\/[^/]+\/agents)\/([^/]+)\.md$/);
  if (m) return exists(`${m[1]}/${m[2]}.yaml`);
  return false;
}

/**
 * Aggregate files into hand-written vs generated totals and flag over-threshold.
 * `existsAt(side, path)` tells whether a path exists on the 'old' (base) or
 * 'new' (head) side; a renamed file counts as generated only if generated on both sides.
 */
function summarize(files, threshold = DEFAULT_THRESHOLD, existsAt = () => false) {
  let handWritten = 0;
  let generated = 0;
  let binaryFiles = 0;
  const handFiles = [];
  for (const f of files) {
    const lines = f.added + f.deleted;
    if (f.binary) binaryFiles++;
    const generatedNew = isGenerated(f.path, (p) => existsAt('new', p));
    const renamed = f.oldPath && f.oldPath !== f.path;
    const isGen = renamed ? generatedNew && isGenerated(f.oldPath, (p) => existsAt('old', p)) : generatedNew;
    if (isGen) {
      generated += lines;
    } else {
      handWritten += lines;
      if (lines > 0) handFiles.push({ path: f.path, lines });
    }
  }
  handFiles.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  return {
    handWritten,
    generated,
    binaryFiles,
    threshold,
    over: handWritten > threshold,
    top: handFiles.slice(0, 5),
  };
}

function formatReport(s) {
  const out = [
    `Hand-written changed lines: ${s.handWritten} (threshold ${s.threshold})`,
    `Generated changed lines:    ${s.generated} (excluded)`,
  ];
  if (s.binaryFiles) out.push(`Binary files:               ${s.binaryFiles}`);
  if (s.top.length) {
    out.push('Largest hand-written files:');
    for (const t of s.top) out.push(`  ${String(t.lines).padStart(6)}  ${t.path}`);
  }
  return out.join('\n');
}

function parseArgs(argv) {
  const opts = { base: null, head: 'HEAD', threshold: DEFAULT_THRESHOLD, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') opts.base = argv[++i];
    else if (a === '--head') opts.head = argv[++i];
    else if (a === '--threshold') opts.threshold = Number(argv[++i]);
    else if (a === '--strict') opts.strict = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.base) throw new Error('--base <ref> is required');
  if (!Number.isFinite(opts.threshold) || opts.threshold < 0) throw new Error('--threshold must be a non-negative number');
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const numstat = git(['diff', '--numstat', '-M', '--find-renames', `${opts.base}...${opts.head}`]);
  // `base...head` diffs from the merge base, so the old side lives there.
  const oldRef = git(['merge-base', opts.base, opts.head]).trim();
  const refs = { old: oldRef, new: opts.head };
  const existsAt = (side, p) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${refs[side]}:${p}`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const s = summarize(parseNumstat(numstat), opts.threshold, existsAt);
  const report = formatReport(s);
  console.log(report);

  if (s.over) {
    const msg = `PR changes ${s.handWritten} hand-written lines (target < ${s.threshold}). Consider splitting it; see CONTRIBUTING.md#pr-flow. This check is advisory.`;
    console.log(`::warning title=PR size::${msg}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## PR size (advisory)\n\n${msg}\n\n\`\`\`\n${report}\n\`\`\`\n`
      );
    }
  }
  return opts.strict && s.over ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    // Advisory tool: usage/git errors are reported but never fail the PR unless --strict.
    console.error(`pr-size: ${err.message}`);
    process.exitCode = process.argv.includes('--strict') ? 2 : 0;
  }
}

module.exports = { parseNumstat, isGenerated, summarize, formatReport, parseArgs, DEFAULT_THRESHOLD };
