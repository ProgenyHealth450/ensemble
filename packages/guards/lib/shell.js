'use strict';
// Minimal shell splitter: commands on && || ; | & newline outside quotes; words with quotes removed.

function splitCommands(src) {
  const cmds = [];
  let words = [];
  let cur = '';
  let has = false; // current word started (allows empty quoted words)
  let q = null;
  const endWord = () => { if (has) words.push(cur); cur = ''; has = false; };
  const endCmd = () => { endWord(); if (words.length) cmds.push(words); words = []; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < src.length) { cur += src[++i]; }
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\') { if (i + 1 < src.length) { cur += src[++i]; has = true; } continue; }
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
  return words.slice(i);
}

// Recursively expand `bash -c "..."` / `sh -c "..."` / `eval "..."`.
function commandsOf(src, depth = 0) {
  const out = [];
  for (const raw of splitCommands(src)) {
    const w = stripPrefix(raw);
    if (!w.length) continue;
    out.push(w);
    if (depth < 3) {
      const base = w[0].split('/').pop();
      if (/^(bash|sh|zsh)$/.test(base)) {
        const ci = w.findIndex((x) => /^-[A-Za-z]*c$/.test(x));
        if (ci >= 0 && w[ci + 1]) out.push(...commandsOf(w[ci + 1], depth + 1));
      } else if (base === 'eval' && w[1]) out.push(...commandsOf(w.slice(1).join(' '), depth + 1));
    }
  }
  return out;
}

module.exports = { splitCommands, stripPrefix, commandsOf };
