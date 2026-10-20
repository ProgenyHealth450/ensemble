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
const EXP_NEXT = /[A-Za-z0-9_{(@*#?!$'"]/;
// An unquoted `{a,b}` / `{a..b}` brace expression expands to several words in bash.
const BRACE_EXPR = /\{.*(,|\.\.)/;
function splitCommands(src, subs = []) {
  const cmds = [];
  let words = [];
  let wexp = [];
  let cur = '';
  let unq = ''; // unquoted, unescaped text of the current word (brace-expansion detection)
  let has = false; // current word started (allows empty quoted words)
  let exp = false;
  let q = null;
  const endWord = () => {
    if (has) { words.push(cur); wexp.push(exp || BRACE_EXPR.test(unq)); }
    cur = ''; unq = ''; has = false; exp = false;
  };
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
    cur += c; unq += c; has = true;
  }
  endCmd();
  return cmds;
}

const WRAPPERS = new Set(['env', 'command', 'sudo', 'time', 'nohup', 'exec', 'builtin']);
// Reserved words / grouping tokens that can precede a simple command (`do git push`, `{ git push`).
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}']);
const INTERPRETERS = /^(bash|sh|zsh|dash|ksh)$/;

// Strip leading VAR=val, wrapper words, reserved words and function-definition prefixes
// (`function f {`), so the underlying simple command is what gets classified.
function stripPrefix(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w) || RESERVED.has(w)) i++;
    else if (w === 'function') i += 2;
    else break;
  }
  // Leftover wrapper options (`sudo -u x git push`, `env -i sh`): resume at the first word that
  // is a command we analyze.
  if (i < words.length && words[i].startsWith('-')) {
    const j = words.findIndex((x, k) => k > i && /^(git|br|eval|xargs|bash|sh|zsh|dash|ksh)$/.test(x.split('/').pop()));
    if (j > i) i = j;
  }
  const out = words.slice(i);
  if (words.exp) out.exp = words.exp.slice(i);
  return out;
}

// Max substitution / `bash -c` / `eval` bodies, and cumulative bytes of analyzed text, per
// command. Beyond either the result is flagged `truncated` and callers MUST fail closed.
const MAX_NODES = 200;
const MAX_BYTES = 1 << 20;

// Where the script word of `bash [options] ...` is: {c: -c given, s: -s given, idx: first positional}.
function shellArgs(w) {
  let c = false, s = false, i = 1;
  for (; i < w.length; i++) {
    const x = w[i];
    if (x === '--') { i++; break; }
    if (/^[-+][Oo]$/.test(x) || x === '--rcfile' || x === '--init-file') { i++; continue; }
    if (/^[-+][A-Za-z]+$/.test(x)) {
      if (x[0] === '-' && x.includes('c')) c = true;
      if (x[0] === '-' && x.includes('s')) s = true;
      continue;
    }
    if (x.startsWith('--') && x !== '--') continue;
    break;
  }
  return { c, s, idx: i };
}

// Expands $(...) / backtick bodies and `bash -c "..."` / `sh -c "..."` / `eval "..."` payloads
// (nested, in execution order). `out.truncated` is true when a budget was exceeded.
// `out.opaque` is true when some interpreter/xargs/eval/source receives input that cannot be
// analyzed (stdin, here-string, process substitution, an expansion as the script).
function commandsOf(src) {
  const out = [];
  let nodes = 0;
  let bytes = 0;
  const walk = (s) => {
    bytes += s.length;
    if (nodes++ >= MAX_NODES || bytes > MAX_BYTES) { out.truncated = true; return; }
    const subs = [];
    const cmds = splitCommands(s, subs);
    for (const body of subs) walk(body);
    for (const raw of cmds) {
      const w = stripPrefix(raw);
      if (!w.length) continue;
      out.push(w);
      const base = w[0].split('/').pop();
      const redirected = w.some((x, k) => k > 0 && x.startsWith('<'));
      if (INTERPRETERS.test(base)) {
        const { c, s: stdinFlag, idx } = shellArgs(w);
        if (c) {
          if (w[idx] !== undefined) {
            walk(w[idx]);
            if (w.exp && w.exp[idx]) out.opaque = true;
          }
        } else if (redirected || stdinFlag || idx >= w.length || w[idx] === '-') out.opaque = true;
      } else if (base === 'eval') {
        if (w[1]) walk(w.slice(1).join(' '));
        if (redirected || (w.exp && w.exp.slice(1).some(Boolean))) out.opaque = true;
      } else if (base === 'source' || base === '.') {
        if (redirected || (w.exp && w.exp.slice(1).some(Boolean))) out.opaque = true;
      } else if (base === 'xargs') out.opaque = true;
    }
  };
  walk(src);
  return out;
}

module.exports = { splitCommands, stripPrefix, commandsOf, MAX_BYTES };
