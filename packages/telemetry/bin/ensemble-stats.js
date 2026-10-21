#!/usr/bin/env node
'use strict';

/**
 * ensemble-stats: summarise local usage telemetry.
 *
 * Usage: ensemble-stats [--dir <project>] [--inventory [--repo <root>]] [--json]
 */

const fs = require('fs');
const path = require('path');

const KINDS = ['command', 'skill', 'agent'];

function parseArgs(argv) {
  const opts = { dir: process.cwd(), inventory: false, json: false, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--inventory') opts.inventory = true;
    else if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--repo') opts.repo = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

// "ensemble:foo" and "ensemble-development:foo" both count as "foo".
function normalize(name) {
  const i = name.lastIndexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

function readUsage(dir) {
  const file = path.join(dir, '.ensemble', 'telemetry', 'usage.jsonl');
  const counts = { command: new Map(), skill: new Map(), agent: new Map() };
  if (!fs.existsSync(file)) return counts;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || !counts[rec.kind] || typeof rec.name !== 'string') continue;
    const n = normalize(rec.name);
    counts[rec.kind].set(n, (counts[rec.kind].get(n) || 0) + 1);
  }
  return counts;
}

function ranking(map) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function yamlName(file) {
  const m = /^\s*name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(fs.readFileSync(file, 'utf8'));
  return m ? m[1].trim() : null;
}

function skillName(file) {
  const text = fs.readFileSync(file, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const m = fm && /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(fm[1]);
  return m ? m[1].trim() : path.basename(path.dirname(file));
}

function walkSkills(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSkills(p, out);
    else if (e.name === 'SKILL.md') out.push(p);
  }
}

// Generated/mirror packages duplicate source components.
const SKIP_PACKAGES = new Set(['full', 'pi', 'codex', 'opencode']);

function readInventory(repo) {
  const inv = { command: new Set(), skill: new Set(), agent: new Set() };
  const pkgRoot = path.join(repo, 'packages');
  if (!fs.existsSync(pkgRoot)) throw new Error(`No packages/ directory under ${repo}`);
  for (const pkg of fs.readdirSync(pkgRoot)) {
    if (SKIP_PACKAGES.has(pkg)) continue;
    const base = path.join(pkgRoot, pkg);
    for (const [kind, sub] of [['command', 'commands'], ['agent', 'agents']]) {
      const d = path.join(base, sub);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.yaml')) continue;
        const n = yamlName(path.join(d, f)) || path.basename(f, '.yaml');
        inv[kind].add(normalize(n));
      }
    }
    const skills = [];
    walkSkills(path.join(base, 'skills'), skills);
    for (const f of skills) inv.skill.add(normalize(skillName(f)));
  }
  return inv;
}

function build(opts) {
  const usage = readUsage(opts.dir);
  const result = { usage: {}, zeroUse: null };
  for (const k of KINDS) result.usage[k] = ranking(usage[k]);
  if (opts.inventory) {
    const inv = readInventory(opts.repo || opts.dir);
    result.zeroUse = {};
    for (const k of KINDS) result.zeroUse[k] = [...inv[k]].filter((n) => !usage[k].has(n)).sort();
  }
  return result;
}

function render(result) {
  const lines = [];
  for (const k of KINDS) {
    lines.push(`${k}s (by use):`);
    if (!result.usage[k].length) lines.push('  (none)');
    for (const { name, count } of result.usage[k]) lines.push(`  ${String(count).padStart(5)}  ${name}`);
  }
  if (result.zeroUse) {
    for (const k of KINDS) {
      lines.push(`zero-use ${k}s (${result.zeroUse[k].length}):`);
      for (const n of result.zeroUse[k]) lines.push(`  ${n}`);
    }
  }
  return lines.join('\n') + '\n';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('Usage: ensemble-stats [--dir <project>] [--inventory [--repo <root>]] [--json]\n');
    return;
  }
  const result = build(opts);
  process.stdout.write(opts.json ? JSON.stringify(result, null, 2) + '\n' : render(result));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`ensemble-stats: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { build, readUsage, readInventory, normalize };
