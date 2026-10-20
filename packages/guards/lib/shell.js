'use strict';
// Minimal shell splitter: commands on && || ; | & newline outside quotes; words with quotes removed.

// Index of the char that closes the substitution opening at src[i] ('$(' -> ')', '`' -> '`'), or -1.
function substitutionEnd(src, i) {
  if (src[i] === '`') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '`') return j;
    }
    return -1;
  }
  let depth = 1;
  let q = null;
  for (let j = i + 2; j < src.length; j++) {
    const c = src[j];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === '\\') { j++; continue; }
    if (q === '"') { if (c === '"') q = null; continue; }
    if (c === "'" || c === '"') q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return -1;
}

// `subs` (optional) collects the bodies of $(...) / `...` substitutions; the raw
// substitution text stays part of its enclosing word. Each returned command array carries
// `.exp`: per word, true when it contains a real shell expansion ($VAR, ${..}, $(..), `..`,
// $'..', $"..") outside single quotes / backslash escapes.
const EXP_NEXT = /[A-Za-z0-9_{(@*#?!$'"-]/;
function splitCommands(src, subs = []) {
  const cmds = [];
  let words = [];
  let wexp = [];
  let cur = '';
  let has = false; // current word started (allows empty quoted words)
  let exp = false;
  let q = null;
  const endWord = () => { if (has) { words.push(cur); wexp.push(exp); } cur = ''; has = false; exp = false; };
  const endCmd = () => { endWord(); if (words.length) { words.exp = wexp; cmds.push(words); } words = []; wexp = []; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < src.length) { cur += src[++i]; }
      else if (c === '`' || (c === '$' && src[i + 1] === '(')) {
        exp = true;
        const end = substitutionEnd(src, i);
        if (end >= 0) {
          subs.push(src.slice(i + (c === '`' ? 1 : 2), end));
          cur += src.slice(i, end + 1); i = end;
        } else cur += c;
      } else {
        if (c === '$' && i + 1 < src.length && src[i + 1] !== '"' && EXP_NEXT.test(src[i + 1])) exp = true;
        cur += c;
      }
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\') { if (i + 1 < src.length) { cur += src[++i]; has = true; } continue; }
    if (c === '`' || (c === '$' && src[i + 1] === '(')) {
      exp = true;
      const end = substitutionEnd(src, i);
      if (end >= 0) {
        subs.push(src.slice(i + (c === '`' ? 1 : 2), end));
        cur += src.slice(i, end + 1); has = true; i = end; continue;
      }
    }
    if (c === '$' && i + 1 < src.length && EXP_NEXT.test(src[i + 1])) exp = true;
    if (c === '#' && !has) { while (i < src.length && src[i] !== '\n') i++; endCmd(); continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '\n' || c === '\r' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '`') {
      // '>&' / '2>&1' style redirects are not command separators
      if (c === '&' && (src[i - 1] === '>' || src[i - 1] === '<')) { cur += c; has = true; continue; }
      endCmd();
      continue;
    }
    cur += c; has = true;
  }
  endCmd();
  return cmds;
}

const WRAPPERS = new Set(['env', 'command', 'sudo', 'time', 'nohup', 'exec', 'builtin']);

// Strip leading VAR=val and wrapper words.
function stripPrefix(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w)) i++;
    else break;
  }
  const out = words.slice(i);
  if (words.exp) out.exp = words.exp.slice(i);
  return out;
}

// Max substitution / `bash -c` / `eval` bodies analyzed per command. Beyond it the
// result is flagged `truncated` and callers MUST fail closed (never silently ignore the rest).
const MAX_NODES = 200;

// Expands $(...) / backtick bodies and `bash -c "..."` / `sh -c "..."` / `eval "..."` payloads
// (nested, in execution order). `out.truncated` is true when MAX_NODES was exceeded.
function commandsOf(src) {
  const out = [];
  let nodes = 0;
  const walk = (s) => {
    if (nodes++ >= MAX_NODES) { out.truncated = true; return; }
    const subs = [];
    const cmds = splitCommands(s, subs);
    for (const body of subs) walk(body);
    for (const raw of cmds) {
      const w = stripPrefix(raw);
      if (!w.length) continue;
      out.push(w);
      const base = w[0].split('/').pop();
      if (/^(bash|sh|zsh)$/.test(base)) {
        const ci = w.findIndex((x) => /^-[A-Za-z]*c$/.test(x));
        if (ci >= 0 && w[ci + 1]) walk(w[ci + 1]);
      } else if (base === 'eval' && w[1]) walk(w.slice(1).join(' '));
    }
  };
  walk(src);
  return out;
}

module.exports = { splitCommands, stripPrefix, commandsOf };
