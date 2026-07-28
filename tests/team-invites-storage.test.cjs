const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');

const source = readFileSync(
  new URL('../team-invites-storage.js', `file://${__filename}`),
  'utf8',
);

class FakeStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }

  snapshot() {
    return Object.fromEntries(this.values);
  }
}

class LockManager {
  constructor() {
    this.chains = new Map();
    this.calls = [];
  }

  request(name, _options, task) {
    this.calls.push(name);
    const previous = this.chains.get(name) || Promise.resolve();
    const current = previous.then(task);
    this.chains.set(name, current.catch(() => {}));
    return current;
  }
}

const template = (program) => ({
  program,
  level: '',
  practiceSchedule: '',
  startDate: '',
  monthlyTuition: '',
  uniformCost: '',
  assessmentFee: '',
  importantDates: '',
  responseDeadline: '',
  nextSteps: '',
  coachName: '',
});

const invite = (id = 'invite-one', program = 'USAG') => ({
  id,
  program,
  createdAt: '2026-07-28T12:00:00.000Z',
  updatedAt: '2026-07-28T12:00:00.000Z',
  checklistEnabled: false,
  skillChecklist: [],
  hiddenFields: [],
  athleteName: 'Avery',
  guardianName: '',
  birthday: '',
  revisitDate: '',
  level: '',
  invitationDate: '',
  status: 'Draft',
  strengths: '',
  coachMessage: '',
  improvementAreas: '',
  practiceSchedule: '',
  startDate: '',
  monthlyTuition: '',
  uniformCost: '',
  assessmentFee: '',
  importantDates: '',
  responseDeadline: '',
  nextSteps: '',
  coachName: '',
  privateNotes: '',
});

const seed = () => ({
  version: 2,
  updatedAt: '2026-07-28T12:00:00.000Z',
  templates: {
    NGA: template('NGA'),
    USAG: template('USAG'),
  },
  invites: [],
  preferences: {
    activeProgram: 'USAG',
  },
});

function loadStorage(initial = {}, options = {}) {
  const localStorage = new FakeStorage(initial);
  const locks = new LockManager();
  const events = [];
  const crypto = options.crypto || webcrypto;
  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const window = {
    localStorage,
    navigator: { locks },
    crypto,
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
  };
  const context = vm.createContext({
    window,
    TextEncoder,
    CustomEvent,
    console,
  });
  new vm.Script(source, { filename: 'team-invites-storage.js' }).runInContext(context);
  const realm = (value) => {
    context.__fixtureJson = JSON.stringify(value);
    try {
      return vm.runInContext('JSON.parse(__fixtureJson)', context);
    } finally {
      delete context.__fixtureJson;
    }
  };
  const normalizeHistorical = vm.runInContext(`(value) => {
    const textFields = [
      'athleteName', 'guardianName', 'birthday', 'revisitDate', 'level',
      'invitationDate', 'status', 'strengths', 'coachMessage', 'improvementAreas',
      'practiceSchedule', 'startDate', 'monthlyTuition', 'uniformCost',
      'assessmentFee', 'importantDates', 'responseDeadline', 'nextSteps',
      'coachName', 'privateNotes'
    ];
    const invites = value.invites.map((item) => {
      const result = {
        id: item.id,
        program: item.program,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        checklistEnabled: item.checklistEnabled === true,
        skillChecklist: Array.isArray(item.skillChecklist) ? item.skillChecklist : [],
        hiddenFields: Array.isArray(item.hiddenFields) ? item.hiddenFields : []
      };
      textFields.forEach((field) => {
        result[field] = typeof item[field] === 'string' ? item[field] : '';
      });
      return result;
    });
    return {
      version: 2,
      updatedAt: value.updatedAt ||
        invites.map((item) => item.updatedAt).sort().at(-1) ||
        '2026-07-28T12:00:00.000Z',
      templates: value.templates,
      invites,
      preferences: { activeProgram: 'USAG' }
    };
  }`, context);
  return {
    api: window.TeamInvitesStorage,
    localStorage,
    locks,
    events,
    context,
    realm,
    normalizeHistorical,
  };
}

const initialize = (environment, fallback = seed()) =>
  environment.api.loadState(environment.realm(fallback), environment.normalizeHistorical);

const remoteMetadata = (deleted = false) =>
  Object.freeze({ source: 'remote', deleted, revision: 1 });

test('splits preferences, one fixed template per program, and hashed invitation records', async () => {
  const state = seed();
  state.templates.NGA.level = 'Level 4';
  state.invites.push(invite());
  const environment = loadStorage({ 'team-invites-v1': JSON.stringify(state) });
  initialize(environment);
  const adapters = environment.api.makeAdapters();

  const preferences = await adapters.preferences.readLocal();
  const nga = await adapters.templateNGA.readLocal();
  const usag = await adapters.templateUSAG.readLocal();
  const invitations = await adapters.invites.listLocal();

  assert.deepEqual(
    { activeProgram: preferences.activeProgram, nga: nga.level, usag: usag.level },
    { activeProgram: 'USAG', nga: 'Level 4', usag: '' },
  );
  assert.equal(invitations.length, 1);
  assert.match(invitations[0].recordId, /^invite-[a-f0-9]{64}$/);
  assert.equal(invitations[0].recordId, await environment.api.inviteRecordId('invite-one'));
  assert.equal(invitations[0].value.version, 1);
  assert.ok(environment.locks.calls.every((name) => name === environment.api.aggregateLock));
});

test('raw backup captures exactly team-invites-v1 without scanning or leaking legacy credentials', () => {
  const rawState = JSON.stringify(seed());
  const environment = loadStorage({
    'team-invites-v1': rawState,
    'team-invites-sync-config-v1': '{"secret":"config"}',
    'team-invites-sync-session-v1': '{"secret":"session"}',
    'team-invites-local-backup-123': '{"old":"remote"}',
    'another-app-secret': 'must-not-leave-this-key',
  });
  const backup = environment.api.rawBackup();

  assert.deepEqual(Array.from(backup.records, (record) => record.key), ['team-invites-v1']);
  assert.equal(backup.records[0].raw_value, rawState);
  assert.doesNotMatch(
    JSON.stringify(backup),
    /sync-config|sync-session|local-backup|another-app-secret|secret/,
  );
  assert.equal(environment.localStorage.snapshot()['team-invites-sync-config-v1'],
    '{"secret":"config"}');
  assert.equal(environment.localStorage.snapshot()['team-invites-sync-session-v1'],
    '{"secret":"session"}');
});

test('historical version-one state is accepted only after strict validation and canonicalized', () => {
  const oldInvite = invite();
  delete oldInvite.birthday;
  delete oldInvite.revisitDate;
  delete oldInvite.checklistEnabled;
  delete oldInvite.skillChecklist;
  delete oldInvite.hiddenFields;
  const oldState = {
    version: 1,
    templates: seed().templates,
    invites: [oldInvite],
  };
  const environment = loadStorage({ 'team-invites-v1': JSON.stringify(oldState) });
  const current = initialize(environment);

  assert.equal(current.version, 2);
  assert.equal(current.preferences.activeProgram, 'USAG');
  assert.equal(current.invites[0].birthday, '');
  assert.equal(current.invites[0].checklistEnabled, false);
  assert.deepEqual(Array.from(current.invites[0].skillChecklist), []);
  assert.equal(environment.api.getStorageWarning(), '');
});

test('historical version-two state accepts the service timestamp format used by the retired remote', () => {
  const oldState = seed();
  delete oldState.preferences;
  oldState.updatedAt = '2026-07-28T12:00:00.123456+00:00';
  const environment = loadStorage({ 'team-invites-v1': JSON.stringify(oldState) });
  const current = initialize(environment);

  assert.equal(current.updatedAt, oldState.updatedAt);
  assert.equal(current.preferences.activeProgram, 'USAG');
  assert.equal(environment.api.getStorageWarning(), '');
});

test('malformed or duplicate existing bytes are preserved and migration reads fail closed', async () => {
  const duplicate = seed();
  duplicate.invites.push(invite('same'), invite('same'));
  const raw = JSON.stringify(duplicate);
  const environment = loadStorage({ 'team-invites-v1': raw });
  const displayed = initialize(environment);

  assert.equal(displayed.invites.length, 0);
  assert.match(environment.api.getStorageWarning(), /raw backup and review/);
  await assert.rejects(
    environment.api.saveState(environment.realm(seed())),
    /raw backup and review/,
  );
  await assert.rejects(
    environment.api.makeAdapters().preferences.readLocal(),
    /raw backup and review/,
  );
  assert.equal(environment.localStorage.getItem('team-invites-v1'), raw);
});

test('strict validators reject inherited prototypes, accessors, oversized records, and unsafe IDs', () => {
  const environment = loadStorage();
  const record = environment.realm({ version: 1, ...invite() });
  environment.context.__validInvite = record;
  const nullPrototype = vm.runInContext(
    'Object.assign(Object.create(null), __validInvite)',
    environment.context,
  );
  assert.equal(environment.api.validCurrentInvite(nullPrototype, true), true);

  const inherited = vm.runInContext(
    'Object.assign(Object.create({ inherited: true }), __validInvite)',
    environment.context,
  );
  assert.equal(environment.api.validCurrentInvite(inherited, true), false);

  const accessor = vm.runInContext(`(() => {
    const value = { ...__validInvite };
    Object.defineProperty(value, 'athleteName', {
      enumerable: true,
      get() { throw new Error('must not execute'); },
    });
    return value;
  })()`, environment.context);
  assert.equal(environment.api.validCurrentInvite(accessor, true), false);

  const oversized = environment.realm({
    version: 1,
    ...invite(),
    privateNotes: 'x'.repeat(128 * 1024),
  });
  assert.equal(environment.api.validCurrentInvite(oversized, true), false);
  assert.equal(
    environment.api.validCurrentInvite(
      environment.realm({ version: 1, ...invite('__proto__') }),
      true,
    ),
    false,
  );
  assert.equal(
    environment.api.makeAdapters().invites.validate(record, 'not-a-hashed-record'),
    false,
  );
});

test('preferences and both template tombstones are rejected without changing raw state', () => {
  const rawState = JSON.stringify(seed());
  const environment = loadStorage({ 'team-invites-v1': rawState });
  initialize(environment);
  const adapters = environment.api.makeAdapters();

  assert.throws(
    () => adapters.preferences.applyRemote(null, remoteMetadata(true)),
    /fixed record and cannot be deleted/,
  );
  assert.throws(
    () => adapters.templateNGA.applyRemote(null, remoteMetadata(true)),
    /fixed record and cannot be deleted/,
  );
  assert.throws(
    () => adapters.templateUSAG.applyRemote(null, remoteMetadata(true)),
    /fixed record and cannot be deleted/,
  );
  assert.equal(environment.localStorage.getItem('team-invites-v1'), rawState);
});

test('a raw CAS race preserves the newer aggregate instead of applying stale remote data', async () => {
  const state = seed();
  state.invites.push(invite());
  const rawState = JSON.stringify(state);
  const localStorage = new FakeStorage({ 'team-invites-v1': rawState });
  let injectRace = false;
  let raced = false;
  const delayedCrypto = {
    subtle: {
      async digest(...args) {
        if (injectRace && !raced) {
          raced = true;
          const newer = seed();
          newer.preferences.activeProgram = 'NGA';
          newer.invites.push(invite());
          localStorage.setItem('team-invites-v1', JSON.stringify(newer));
        }
        return webcrypto.subtle.digest(...args);
      },
    },
  };
  const environment = loadStorage({}, { crypto: delayedCrypto });
  environment.localStorage.values = localStorage.values;
  initialize(environment);
  const adapters = environment.api.makeAdapters();
  const recordId = await environment.api.inviteRecordId('invite-one');
  injectRace = true;
  const remote = environment.realm({ version: 1, ...invite() });
  remote.athleteName = 'Remote Name';

  await assert.rejects(
    adapters.invites.applyRemote(recordId, remote, remoteMetadata(false)),
    /changed during an atomic update/,
  );
  assert.equal(
    JSON.parse(environment.localStorage.getItem('team-invites-v1'))
      .preferences.activeProgram,
    'NGA',
  );
});

test('rapid local saves coalesce to the latest aggregate and stage one split delta', async () => {
  const environment = loadStorage();
  initialize(environment);
  const calls = [];
  environment.context.__handles = {
    preferences: { save: async (value) => calls.push(['preferences', value]) },
    templateNGA: { save: async (value) => calls.push(['nga', value]) },
    templateUSAG: { save: async (value) => calls.push(['usag', value]) },
    invites: {
      save: async (recordId, value) => calls.push(['invite-save', recordId, value]),
      remove: async (recordId) => calls.push(['invite-remove', recordId]),
    },
  };
  environment.api.attachHandles(
    vm.runInContext('({ ...__handles })', environment.context),
  );

  const first = seed();
  first.preferences.activeProgram = 'NGA';
  const latest = seed();
  latest.templates.USAG.level = 'Level 5';
  latest.invites.push(invite());
  const firstSave = environment.api.saveState(environment.realm(first));
  const latestSave = environment.api.saveState(environment.realm(latest));
  await Promise.all([firstSave, latestSave]);

  const stored = JSON.parse(environment.localStorage.getItem('team-invites-v1'));
  assert.equal(stored.preferences.activeProgram, 'USAG');
  assert.equal(stored.templates.USAG.level, 'Level 5');
  assert.equal(stored.invites.length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'preferences').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'nga').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'usag').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'invite-save').length, 1);
});

test('remote application waits for a dirty editor then rejects when a newer local generation wins', async () => {
  const environment = loadStorage({ 'team-invites-v1': JSON.stringify(seed()) });
  initialize(environment);
  const adapters = environment.api.makeAdapters();
  environment.api.setEditorState(environment.realm({ active: true, dirty: true }));

  let settled = false;
  const remote = adapters.preferences.applyRemote(environment.realm({
    version: 1,
    activeProgram: 'NGA',
  }), remoteMetadata(false)).finally(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);

  const newerLocal = seed();
  newerLocal.templates.USAG.level = 'Newer Local Template';
  await environment.api.saveState(environment.realm(newerLocal));
  environment.api.setEditorState(environment.realm({ active: false, dirty: false }));

  await assert.rejects(remote, /newer local edit needs review/);
  const stored = JSON.parse(environment.localStorage.getItem('team-invites-v1'));
  assert.equal(stored.templates.USAG.level, 'Newer Local Template');
  assert.equal(stored.preferences.activeProgram, 'USAG');
});

test('invitation tombstones remove only the selected invitation', async () => {
  const state = seed();
  state.templates.NGA.level = 'Preserve Template';
  state.invites.push(invite('invite-one'), invite('invite-two', 'NGA'));
  const environment = loadStorage({ 'team-invites-v1': JSON.stringify(state) });
  initialize(environment);
  const adapters = environment.api.makeAdapters();
  const firstId = await environment.api.inviteRecordId('invite-one');

  await adapters.invites.writeLocal(firstId, null, {
    source: 'local',
    deleted: true,
  });
  const stored = JSON.parse(environment.localStorage.getItem('team-invites-v1'));
  assert.deepEqual(Array.from(stored.invites, (item) => item.id), ['invite-two']);
  assert.equal(stored.templates.NGA.level, 'Preserve Template');
  assert.equal(stored.preferences.activeProgram, 'USAG');
});
