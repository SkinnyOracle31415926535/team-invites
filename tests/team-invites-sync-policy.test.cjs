const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const syncSource = readFileSync(
  new URL('../team-invites-sync.js', `file://${__filename}`),
  'utf8',
);
const storageSource = readFileSync(
  new URL('../team-invites-storage.js', `file://${__filename}`),
  'utf8',
);
const html = readFileSync(
  new URL('../index.html', `file://${__filename}`),
  'utf8',
);

const loadPolicy = () => {
  const window = {};
  const document = {
    body: null,
    getElementById() {
      return null;
    },
  };
  new vm.Script(syncSource, { filename: 'team-invites-sync.js' })
    .runInNewContext({ window, document, Number, Object });
  return window.TeamInvitesSyncPolicy;
};

test('migration gate requires exactly zero writes, remote records, and orphaned intents', () => {
  const policy = loadPolicy();
  assert.equal(policy.migrationGate({
    writesPerformed: 0,
    remoteCount: 0,
    orphanedCount: 0,
  }).safe, true);
  assert.equal(policy.migrationGate({
    writesPerformed: 1,
    remoteCount: 0,
    orphanedCount: 0,
  }).safe, false);
  assert.equal(policy.migrationGate({
    writesPerformed: 0,
    remoteCount: 1,
    orphanedCount: 0,
  }).safe, false);
  assert.equal(policy.migrationGate({
    writesPerformed: 0,
    remoteCount: 0,
    orphanedCount: 1,
  }).safe, false);
  assert.equal(policy.migrationGate({}).safe, false);
});

test('new integration owns one state key and never scans storage or references legacy secrets', () => {
  assert.match(storageSource, /const STORAGE_KEY = 'team-invites-v1'/);
  assert.doesNotMatch(storageSource, /Storage\.prototype|localStorage\.clear\s*\(/);
  assert.doesNotMatch(storageSource, /localStorage\.(?:key|length)\b/);
  assert.doesNotMatch(storageSource, /for\s*\([^)]*\bin\s+window\.localStorage/);
  assert.doesNotMatch(
    `${storageSource}\n${syncSource}`,
    /team-invites-sync-config-v1|team-invites-sync-session-v1|team-invites-local-backup-/,
  );
  assert.match(html, /team-invites-storage\.js/);
  assert.match(html, /ryan-app-sync[^"']*\/ryan-app-sync\.js/);
  assert.match(html, /team-invites-sync\.js/);
  assert.match(html, /TeamInvitesStorage\.saveState\(state\)/);
  assert.match(html, /LEGACY_SYNC_DISABLED \? null : loadSyncConfig\(\)/);
  assert.match(html, /LEGACY_SYNC_DISABLED \? null : loadSyncSession\(\)/);
});

test('migration UI downloads the exact raw backup before requesting metadata preview', () => {
  const previewHandler = syncSource.match(
    /previewButton\.addEventListener\('click',[\s\S]*?\n  \}\)\);/,
  )?.[0] || '';
  assert.match(previewHandler, /store\.assertOwnedStorageValid\(\)/);
  assert.match(previewHandler, /downloadRawBackup\(\)/);
  assert.match(previewHandler, /client\.previewMigration\(\{ downloadBackup: true \}\)/);
  assert.ok(
    previewHandler.indexOf('downloadRawBackup()') <
    previewHandler.indexOf('client.previewMigration'),
  );
});
