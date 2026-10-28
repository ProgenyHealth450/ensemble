'use strict';
/**
 * Guard: a generated command/agent Markdown file must have a source YAML.
 *
 * When a YAML source is deleted the generator does not remove its output, so the
 * stale Markdown stays registered in every runtime. Generated files carry the
 * `DO NOT EDIT - Generated from <name>.yaml` marker; hand-maintained files
 * (e.g. packages/core/commands/ensemble/init-project.md) do not, so they are
 * not subject to this check.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PACKAGES = path.join(__dirname, '..', '..', 'packages');
const MARKER = /<!--\s*DO NOT EDIT - Generated from ([^\s]+\.yaml)\s*-->/;

// Marker-less hand-maintained files need no entry. Add a path here (with a
// reason) only if a hand-maintained file ever carries the marker.
const HAND_MAINTAINED_ALLOWLIST = new Set([]);

/** Returns generated .md files (relative to packagesDir) whose source YAML is missing. */
function findOrphans(packagesDir) {
  const orphans = [];
  for (const pkg of fs.readdirSync(packagesDir)) {
    const targets = [
      { mdDir: path.join(packagesDir, pkg, 'commands', 'ensemble'), yamlDir: path.join(packagesDir, pkg, 'commands') },
      { mdDir: path.join(packagesDir, pkg, 'agents'), yamlDir: path.join(packagesDir, pkg, 'agents') },
    ];
    for (const { mdDir, yamlDir } of targets) {
      if (!fs.existsSync(mdDir)) continue;
      for (const file of fs.readdirSync(mdDir)) {
        if (!file.endsWith('.md')) continue;
        const full = path.join(mdDir, file);
        const rel = path.relative(packagesDir, full);
        if (HAND_MAINTAINED_ALLOWLIST.has(rel)) continue;
        const m = MARKER.exec(fs.readFileSync(full, 'utf8'));
        if (!m) continue;
        const yamlName = path.basename(m[1]);
        const sourceName = file.replace(/\.md$/, '.yaml');
        if (!fs.existsSync(path.join(yamlDir, sourceName)) || yamlName !== sourceName) {
          orphans.push(rel);
        }
      }
    }
  }
  return orphans;
}

describe('generated command/agent markdown has a source YAML', () => {
  test('no orphaned generated files in packages/', () => {
    expect(findOrphans(PACKAGES)).toEqual([]);
  });

  test('detects an orphan (guard can fail)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphans-'));
    try {
      const cmds = path.join(dir, 'p', 'commands', 'ensemble');
      fs.mkdirSync(cmds, { recursive: true });
      const gen = (n) => `---\nname: x\n---\n<!-- DO NOT EDIT - Generated from ${n}.yaml -->\n`;
      fs.writeFileSync(path.join(cmds, 'gone.md'), gen('gone'));
      fs.writeFileSync(path.join(cmds, 'kept.md'), gen('kept'));
      fs.writeFileSync(path.join(dir, 'p', 'commands', 'kept.yaml'), 'name: kept\n');
      fs.writeFileSync(path.join(cmds, 'hand.md'), '---\nname: hand\n---\n');
      expect(findOrphans(dir)).toEqual([path.join('p', 'commands', 'ensemble', 'gone.md')]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
