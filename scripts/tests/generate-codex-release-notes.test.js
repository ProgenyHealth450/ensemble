'use strict';
/**
 * Tests for scripts/generate-codex-release-notes.js's updateChangelog CRLF fix.
 *
 * The header regex (`/^# Changelog\n\n/`) requires a literal '\n' after
 * "# Changelog", so a CRLF-sourced CHANGELOG.md (the norm on Windows
 * checkouts with core.autocrlf=true) made the replace silently no-op — the
 * new release-notes entry was dropped with no error, the file rewritten
 * byte-identical to before.
 */

const { updateChangelog } = require('../generate-codex-release-notes.js');

function fakeFs(initialContent) {
  const disk = { content: initialContent };
  return {
    disk,
    readFileSync: () => disk.content,
    writeFileSync: (p, content) => {
      disk.content = content;
    },
  };
}

describe('updateChangelog — CRLF line endings', () => {
  const notes = ['# @fortium/ensemble-codex 1.2.0', '', '## Features', '', '- did a thing', ''].join('\n');

  test('inserts the new entry even when CHANGELOG.md is CRLF-sourced', () => {
    const crlfChangelog = '# Changelog\r\n\r\n## 1.1.0\r\n\r\n- previous entry\r\n';
    const { disk, readFileSync, writeFileSync } = fakeFs(crlfChangelog);
    updateChangelog('1.2.0', notes, { readFileSync, writeFileSync });

    const updated = disk.content;
    expect(updated).toContain('## 1.2.0');
    expect(updated).toContain('- did a thing');
    // the previous entry must still be present -- not overwritten, just prepended before it
    expect(updated).toContain('## 1.1.0');
    expect(updated.indexOf('## 1.2.0')).toBeLessThan(updated.indexOf('## 1.1.0'));
  });

  test('LF changelog still works the same as before (no regression)', () => {
    const lfChangelog = '# Changelog\n\n## 1.1.0\n\n- previous entry\n';
    const { disk, readFileSync, writeFileSync } = fakeFs(lfChangelog);
    updateChangelog('1.2.0', notes, { readFileSync, writeFileSync });

    expect(disk.content).toContain('## 1.2.0');
  });
});
