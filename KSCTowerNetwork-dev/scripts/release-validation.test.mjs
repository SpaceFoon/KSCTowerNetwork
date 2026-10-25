import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateReleaseTree } from './release-validation.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ksc-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const names = ['LICENSE', 'NOTICE.md', 'DEPENDENCY_NOTICES.txt', 'INSTALL.txt', 'RELEASE_MANIFEST.json', 'KSCTowerNetwork-dev/backend/dist/index.js', 'KSCTowerNetwork-dev/backend/package-lock.json', 'KSCTowerNetwork-dev/web/dist/index.html', 'KSCTowerNetwork-dev/deploy/server.env.example', 'KSCTowerNetwork-dev/deploy/server.mjs', 'KSCTowerNetwork-dev/web/scripts/index_aerocharts.py'];
  for (const name of names) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), 'fixture'); }
  mkdirSync(join(root, 'KSCTowerNetwork-dev/web/dist/charts'), { recursive: true });
  writeFileSync(join(root, 'KSCTowerNetwork-dev/web/dist/charts/manifest.json'), JSON.stringify({ pageCount: 0, pages: [] }));
  return root;
}
test('clean server permits example env and empty chart manifest', t => validateReleaseTree(fixture(t), 'server'));
for (const name of ['.env.production', 'auth.cfg', 'registered-users.json', 'invite-codes.json', 'chart.pdf', 'font.ttf']) test(`rejects leaked ${name}`, t => {
  const root = fixture(t); writeFileSync(join(root, name), 'private'); assert.throws(() => validateReleaseTree(root, 'server'));
});
test('rejects optional installed charts', t => {
  const root = fixture(t); writeFileSync(join(root, 'KSCTowerNetwork-dev/web/dist/charts/manifest.json'), JSON.stringify({ pageCount: 1, pages: [{}] })); assert.throws(() => validateReleaseTree(root, 'server'));
});
test('rejects server dependencies from build OS', t => {
  const root = fixture(t); mkdirSync(join(root, 'node_modules')); assert.throws(() => validateReleaseTree(root, 'server'));
});
