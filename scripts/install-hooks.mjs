#!/usr/bin/env node
// `npm install` → prepare → this: point git at the committed hooks (scripts/git-hooks). Never writes
// inside .git. Outside a git checkout (npm pack, a tarball install) it does nothing.
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' });
} catch {
  process.exit(0);
}
execFileSync('git', ['config', 'core.hooksPath', 'scripts/git-hooks'], { cwd: root, stdio: 'inherit' });
console.log('install-hooks: core.hooksPath = scripts/git-hooks (pre-push runs the publish audit)');
