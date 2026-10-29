/**
 * The committed pi output is what gets packed and installed, so it has to be self-contained.
 * A symlink there points into the monorepo (`../../../../development/lib/...`) and dangles in
 * every installed copy, which is the failure the vendored `lib/` exists to prevent.
 */

import * as fs from 'fs';
import * as path from 'path';

function symlinksUnder(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) out.push(full);
    else if (entry.isDirectory()) symlinksUnder(full, out);
  }
  return out;
}

describe('committed pi output', () => {
  const root = path.resolve(__dirname, '..');

  it.each(['skills', 'vendor', 'prompts', 'agents'])('contains no symlinks under %s/', (sub) => {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) return;
    expect(symlinksUnder(dir).map((p) => path.relative(root, p))).toEqual([]);
  });
});
