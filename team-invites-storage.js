(() => {
  'use strict';

  const APP_ID = 'team-invites';
  const SCHEMA_VERSION = 1;
  const CHANGE_EVENT = 'team-invites:persistent-state-change';
  const AGGREGATE_LOCK = 'team-invites:local-aggregate-v1';
  const STORAGE_KEY = 'team-invites-v1';
  const RAW_BACKUP_KEYS = Object.freeze([STORAGE_KEY]);
  const PROGRAMS = Object.freeze(['NGA', 'USAG']);
  const STATUSES = Object.freeze(['Draft', 'Ready', 'Invited', 'Accepted', 'Declined', 'Hold']);
  const TEMPLATE_FIELDS = Object.freeze([
    'level', 'practiceSchedule', 'startDate', 'monthlyTuition', 'uniformCost',
    'assessmentFee', 'importantDates', 'responseDeadline', 'nextSteps', 'coachName',
  ]);
  const INVITE_TEXT_FIELDS = Object.freeze([
    'athleteName', 'guardianName', 'birthday', 'revisitDate', 'level',
    'invitationDate', 'status', 'strengths', 'coachMessage', 'improvementAreas',
    'practiceSchedule', 'startDate', 'monthlyTuition', 'uniformCost',
    'assessmentFee', 'importantDates', 'responseDeadline', 'nextSteps',
    'coachName', 'privateNotes',
  ]);
  const HIDEABLE_FIELDS = new Set([...INVITE_TEXT_FIELDS, 'skillChecklist']);
  const CORE_INVITE_KEYS = Object.freeze([
    'id', 'program', 'createdAt', 'updatedAt',
    'athleteName', 'guardianName', 'level', 'invitationDate', 'status',
    'strengths', 'coachMessage', 'improvementAreas', 'practiceSchedule',
    'startDate', 'monthlyTuition', 'uniformCost', 'assessmentFee',
    'importantDates', 'responseDeadline', 'nextSteps', 'coachName', 'privateNotes',
  ]);
  const CURRENT_INVITE_KEYS = Object.freeze([
    'id', 'program', 'createdAt', 'updatedAt', 'checklistEnabled',
    'skillChecklist', 'hiddenFields', ...INVITE_TEXT_FIELDS,
  ]);
  const HISTORICAL_OPTIONAL_INVITE_KEYS = new Set([
    'birthday', 'revisitDate', 'checklistEnabled', 'skillChecklist', 'hiddenFields',
  ]);
  const MAX_RECORD_BYTES = 128 * 1024;
  const MAX_AGGREGATE_BYTES = 16 * 1024 * 1024;
  const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const mutationState = {
    issuedGeneration: 0,
    pending: [],
    inFlightGeneration: 0,
    draining: false,
    editorActive: false,
    editorDirty: false,
    editorWaiters: new Set(),
  };
  let handles = null;
  let seedState = null;
  let storageWarning = '';

  const withAggregateLock = (task) => {
    const locks = window.navigator && window.navigator.locks;
    if (!locks || typeof locks.request !== 'function') {
      return Promise.reject(
        new Error('Shared browser locking is unavailable. Local Team Invites data was not changed.')
      );
    }
    return locks.request(AGGREGATE_LOCK, { mode: 'exclusive' }, task);
  };

  const dataObjectDescriptors = (value) => {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') return null;
        const descriptor = descriptors[key];
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
            descriptor.get || descriptor.set || !descriptor.enumerable) {
          return null;
        }
      }
      return descriptors;
    } catch (_error) {
      return null;
    }
  };

  const plainObject = (value) => Boolean(dataObjectDescriptors(value));

  const safeEntries = (value) => {
    const descriptors = dataObjectDescriptors(value);
    return descriptors
      ? Object.keys(descriptors).map((key) => [key, descriptors[key].value])
      : null;
  };

  const safeKeys = (value) => {
    const descriptors = dataObjectDescriptors(value);
    return descriptors ? Object.keys(descriptors) : null;
  };

  const exactKeys = (value, expected) => {
    const keys = safeKeys(value);
    return Boolean(keys &&
      keys.slice().sort().join('\u001f') === expected.slice().sort().join('\u001f'));
  };

  const onlyKnownKeys = (value, required, optional = new Set()) => {
    const keys = safeKeys(value);
    if (!keys || required.some((key) => !keys.includes(key))) return false;
    const allowed = new Set([...required, ...optional]);
    return keys.every((key) => allowed.has(key));
  };

  const safeArrayValues = (value, maximum) => {
    try {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
          value.length > maximum) {
        return null;
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const ownKeys = Reflect.ownKeys(descriptors);
      if (ownKeys.some((key) => typeof key !== 'string') ||
          ownKeys.length !== value.length + 1 ||
          !descriptors.length || descriptors.length.value !== value.length) {
        return null;
      }
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
            descriptor.get || descriptor.set || !descriptor.enumerable) {
          return null;
        }
        result.push(descriptor.value);
      }
      return result;
    } catch (_error) {
      return null;
    }
  };

  const jsonBytes = (value) => {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch (_error) {
      return Number.POSITIVE_INFINITY;
    }
  };

  const safeJsonParse = (raw) => {
    if (typeof raw !== 'string' ||
        new TextEncoder().encode(raw).byteLength > MAX_AGGREGATE_BYTES) {
      throw new Error('Local Team Invites data is too large and needs a raw backup and review.');
    }
    try {
      return JSON.parse(raw);
    } catch (_error) {
      throw new Error(
        'Local Team Invites data needs a raw backup and review before it can be changed or synchronized.'
      );
    }
  };

  const validText = (value, maximum = 20_000) => (
    typeof value === 'string' && value.length <= maximum && !value.includes('\u0000')
  );
  const validId = (value) => (
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(value) &&
    !RESERVED_KEYS.has(value)
  );
  const validIso = (value) => {
    if (typeof value !== 'string' || value.length > 80 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      return false;
    }
    const time = Date.parse(value);
    return Number.isFinite(time);
  };

  const validTemplate = (candidate, program, recordValue = false) => {
    const expected = recordValue
      ? ['version', 'program', ...TEMPLATE_FIELDS]
      : ['program', ...TEMPLATE_FIELDS];
    if (!exactKeys(candidate, expected) || jsonBytes(candidate) > MAX_RECORD_BYTES) return false;
    const value = Object.fromEntries(safeEntries(candidate));
    if (recordValue && value.version !== SCHEMA_VERSION) return false;
    return value.program === program &&
      TEMPLATE_FIELDS.every((field) => validText(value[field]));
  };

  const canonicalTemplate = (candidate, program, recordValue = false) => {
    const value = Object.fromEntries(safeEntries(candidate));
    return {
      ...(recordValue ? { version: SCHEMA_VERSION } : {}),
      program,
      ...Object.fromEntries(TEMPLATE_FIELDS.map((field) => [field, value[field]])),
    };
  };

  const validSkillItem = (candidate) => {
    if (!exactKeys(candidate, ['id', 'category', 'label', 'complete'])) return false;
    const value = Object.fromEntries(safeEntries(candidate));
    return validId(value.id) && validText(value.category, 200) &&
      validText(value.label, 500) && typeof value.complete === 'boolean';
  };

  const canonicalSkillItem = (candidate) => {
    const value = Object.fromEntries(safeEntries(candidate));
    return {
      id: value.id,
      category: value.category,
      label: value.label,
      complete: value.complete,
    };
  };

  const validHiddenFields = (value) => {
    const items = safeArrayValues(value, HIDEABLE_FIELDS.size);
    return Boolean(items && items.every((field) =>
      typeof field === 'string' && HIDEABLE_FIELDS.has(field)) &&
      new Set(items).size === items.length);
  };

  const validChecklist = (value) => {
    const items = safeArrayValues(value, 200);
    return Boolean(items && items.every(validSkillItem) &&
      new Set(items.map((item) => Object.fromEntries(safeEntries(item)).id)).size === items.length);
  };

  const validCurrentInvite = (candidate, recordValue = false) => {
    const expected = recordValue
      ? ['version', ...CURRENT_INVITE_KEYS]
      : CURRENT_INVITE_KEYS;
    if (!exactKeys(candidate, expected) || jsonBytes(candidate) > MAX_RECORD_BYTES) return false;
    const value = Object.fromEntries(safeEntries(candidate));
    if (recordValue && value.version !== SCHEMA_VERSION) return false;
    return validId(value.id) && PROGRAMS.includes(value.program) &&
      validIso(value.createdAt) && validIso(value.updatedAt) &&
      typeof value.checklistEnabled === 'boolean' &&
      validChecklist(value.skillChecklist) && validHiddenFields(value.hiddenFields) &&
      INVITE_TEXT_FIELDS.every((field) => validText(value[field])) &&
      STATUSES.includes(value.status);
  };

  const canonicalInvite = (candidate, recordValue = false) => {
    const value = Object.fromEntries(safeEntries(candidate));
    return {
      ...(recordValue ? { version: SCHEMA_VERSION } : {}),
      id: value.id,
      program: value.program,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      checklistEnabled: value.checklistEnabled,
      skillChecklist: safeArrayValues(value.skillChecklist, 200).map(canonicalSkillItem),
      hiddenFields: safeArrayValues(value.hiddenFields, HIDEABLE_FIELDS.size).slice(),
      ...Object.fromEntries(INVITE_TEXT_FIELDS.map((field) => [field, value[field]])),
    };
  };

  const validPreferences = (candidate) => {
    if (!exactKeys(candidate, ['version', 'activeProgram']) ||
        jsonBytes(candidate) > MAX_RECORD_BYTES) {
      return false;
    }
    const value = Object.fromEntries(safeEntries(candidate));
    return value.version === SCHEMA_VERSION && PROGRAMS.includes(value.activeProgram);
  };

  const canonicalPreferences = (candidate) => {
    const value = Object.fromEntries(safeEntries(candidate));
    return { version: SCHEMA_VERSION, activeProgram: value.activeProgram };
  };

  const validCurrentState = (candidate) => {
    if (!exactKeys(candidate, ['version', 'updatedAt', 'templates', 'invites', 'preferences']) ||
        jsonBytes(candidate) > MAX_AGGREGATE_BYTES) {
      return false;
    }
    const value = Object.fromEntries(safeEntries(candidate));
    const templates = dataObjectDescriptors(value.templates);
    const preferences = dataObjectDescriptors(value.preferences);
    const invites = safeArrayValues(value.invites, 2_000);
    if (value.version !== 2 || !validIso(value.updatedAt) ||
        !templates || !exactKeys(value.templates, PROGRAMS) ||
        !preferences || !exactKeys(value.preferences, ['activeProgram']) ||
        !PROGRAMS.includes(Object.fromEntries(safeEntries(value.preferences)).activeProgram) ||
        !validTemplate(Object.fromEntries(safeEntries(value.templates)).NGA, 'NGA') ||
        !validTemplate(Object.fromEntries(safeEntries(value.templates)).USAG, 'USAG') ||
        !invites || invites.some((invite) => !validCurrentInvite(invite))) {
      return false;
    }
    const ids = invites.map((invite) => Object.fromEntries(safeEntries(invite)).id);
    return new Set(ids).size === ids.length;
  };

  const canonicalState = (candidate) => {
    const value = Object.fromEntries(safeEntries(candidate));
    const templates = Object.fromEntries(safeEntries(value.templates));
    const preferences = Object.fromEntries(safeEntries(value.preferences));
    return {
      version: 2,
      updatedAt: value.updatedAt,
      templates: {
        NGA: canonicalTemplate(templates.NGA, 'NGA'),
        USAG: canonicalTemplate(templates.USAG, 'USAG'),
      },
      invites: safeArrayValues(value.invites, 2_000).map((invite) =>
        canonicalInvite(invite)),
      preferences: {
        activeProgram: preferences.activeProgram,
      },
    };
  };

  const validHistoricalInvite = (candidate) => {
    if (!onlyKnownKeys(candidate, CORE_INVITE_KEYS, HISTORICAL_OPTIONAL_INVITE_KEYS) ||
        jsonBytes(candidate) > MAX_RECORD_BYTES) {
      return false;
    }
    const value = Object.fromEntries(safeEntries(candidate));
    if (!validId(value.id) || !PROGRAMS.includes(value.program) ||
        !validIso(value.createdAt) || !validIso(value.updatedAt) ||
        CORE_INVITE_KEYS.filter((field) => INVITE_TEXT_FIELDS.includes(field))
          .some((field) => !validText(value[field])) ||
        !STATUSES.includes(value.status)) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'birthday') && !validText(value.birthday)) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'revisitDate') && !validText(value.revisitDate)) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'checklistEnabled') &&
        typeof value.checklistEnabled !== 'boolean') {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'skillChecklist') &&
        !validChecklist(value.skillChecklist)) {
      return false;
    }
    return !Object.prototype.hasOwnProperty.call(value, 'hiddenFields') ||
      validHiddenFields(value.hiddenFields);
  };

  const validHistoricalState = (candidate) => {
    if (!plainObject(candidate) || jsonBytes(candidate) > MAX_AGGREGATE_BYTES) return false;
    const value = Object.fromEntries(safeEntries(candidate));
    const expected = value.version === 1
      ? ['version', 'templates', 'invites']
      : ['version', 'updatedAt', 'templates', 'invites'];
    if (![1, 2].includes(value.version) || !exactKeys(candidate, expected)) return false;
    if (value.version === 2 && !validIso(value.updatedAt)) return false;
    if (!exactKeys(value.templates, PROGRAMS)) return false;
    const templates = Object.fromEntries(safeEntries(value.templates));
    const invites = safeArrayValues(value.invites, 2_000);
    if (!validTemplate(templates.NGA, 'NGA') || !validTemplate(templates.USAG, 'USAG') ||
        !invites || invites.some((invite) => !validHistoricalInvite(invite))) {
      return false;
    }
    const ids = invites.map((invite) => Object.fromEntries(safeEntries(invite)).id);
    return new Set(ids).size === ids.length;
  };

  const readStateFromRaw = (raw, normalizeHistorical) => {
    if (raw === null) return undefined;
    const parsed = safeJsonParse(raw);
    if (validCurrentState(parsed)) return canonicalState(parsed);
    if (!validHistoricalState(parsed) || typeof normalizeHistorical !== 'function') {
      throw new Error(
        'Local Team Invites data needs a raw backup and review before it can be changed or synchronized.'
      );
    }
    const normalized = normalizeHistorical(parsed);
    if (!validCurrentState(normalized)) {
      throw new Error(
        'Historical Team Invites data needs a raw backup and review before it can be migrated.'
      );
    }
    return canonicalState(normalized);
  };

  const readStateUnlocked = () =>
    readStateFromRaw(window.localStorage.getItem(STORAGE_KEY), seedState?.normalizeHistorical);

  const captureRaw = () => [{ key: STORAGE_KEY, raw: window.localStorage.getItem(STORAGE_KEY) }];

  const assertRawUnchanged = (snapshot, label) => {
    if (snapshot.some(({ key, raw }) => window.localStorage.getItem(key) !== raw)) {
      throw new Error(`${label} changed during an atomic update. The newer local value was preserved.`);
    }
  };

  const restoreAppliedChanges = (snapshot, changes) => {
    const originalByKey = new Map(snapshot.map(({ key, raw }) => [key, raw]));
    for (const { key, raw } of changes) {
      if (window.localStorage.getItem(key) !== raw) continue;
      const original = originalByKey.get(key);
      if (original === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, original);
    }
  };

  const compareAndSet = (snapshot, changes, label) => {
    assertRawUnchanged(snapshot, label);
    try {
      for (const { key, raw } of changes) {
        if (raw === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, raw);
      }
      for (const { key, raw } of changes) {
        if (window.localStorage.getItem(key) !== raw) {
          throw new Error(`${label} could not be verified after writing.`);
        }
      }
    } catch (error) {
      restoreAppliedChanges(snapshot, changes);
      throw error;
    }
  };

  const dispatchChange = (collection, source) => {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, {
      detail: { collection, source },
    }));
  };

  const sha256 = async (value) => {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('Secure hashing is required to synchronize Team Invites records.');
    }
    const digest = await window.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')).join('');
  };

  const inviteRecordId = async (inviteId) => {
    if (!validId(inviteId)) throw new Error('The Team Invites invitation ID is invalid.');
    return `invite-${await sha256(inviteId)}`;
  };

  const identifyInvites = async (invites) => {
    const records = await Promise.all(invites.map(async (invite) => ({
      sourceId: invite.id,
      recordId: await inviteRecordId(invite.id),
      value: canonicalInvite(invite, true),
    })));
    if (new Set(records.map(({ recordId }) => recordId)).size !== records.length) {
      throw new Error('Local Team Invites invitation identities collide and need review.');
    }
    return records;
  };

  const preferencesFromState = (state) => ({
    version: SCHEMA_VERSION,
    activeProgram: state.preferences.activeProgram,
  });

  const templateFromState = (state, program) =>
    canonicalTemplate(state.templates[program], program, true);

  const localWorkPending = () =>
    Boolean(mutationState.pending.length || mutationState.inFlightGeneration);

  const assertConsistentRead = () => {
    if (localWorkPending() || mutationState.editorActive || mutationState.editorDirty) {
      throw new Error('Local Team Invites edits must settle before synchronization can read them.');
    }
  };

  const wakeEditorWaiters = () => {
    if (mutationState.editorActive || mutationState.editorDirty) return;
    for (const resolve of mutationState.editorWaiters) resolve();
    mutationState.editorWaiters.clear();
  };

  const waitForEditorIdle = () => {
    if (!mutationState.editorActive && !mutationState.editorDirty) return Promise.resolve();
    return new Promise((resolve) => mutationState.editorWaiters.add(resolve));
  };

  const assertRemoteWritable = (generation) => {
    if (mutationState.issuedGeneration !== generation || localWorkPending() ||
        mutationState.editorActive || mutationState.editorDirty) {
      throw new Error(
        'Remote Team Invites data was not applied because a newer local edit needs review.'
      );
    }
  };

  const withConsistentRead = (task) => withAggregateLock(() => {
    assertConsistentRead();
    return task();
  });

  const withRemoteWrite = async (task) => {
    const generation = mutationState.issuedGeneration;
    if (localWorkPending()) {
      throw new Error('Remote Team Invites data was not applied because local work is pending.');
    }
    await waitForEditorIdle();
    assertRemoteWritable(generation);
    return withAggregateLock(async () => {
      assertRemoteWritable(generation);
      return task(() => assertRemoteWritable(generation));
    });
  };

  const enqueueLatest = (perform) => {
    const generation = ++mutationState.issuedGeneration;
    const promise = new Promise((resolve, reject) => {
      const pending = mutationState.pending[0];
      if (!pending) {
        mutationState.pending.push({
          generation,
          perform,
          waiters: [{ resolve, reject }],
        });
      } else {
        pending.generation = generation;
        pending.perform = perform;
        pending.waiters.push({ resolve, reject });
      }
    });
    if (!mutationState.draining) {
      mutationState.draining = true;
      Promise.resolve().then(async () => {
        try {
          while (mutationState.pending.length) {
            const job = mutationState.pending.shift();
            mutationState.inFlightGeneration = job.generation;
            try {
              const result = await job.perform(job.generation);
              job.waiters.forEach(({ resolve }) => resolve(result));
            } catch (error) {
              job.waiters.forEach(({ reject }) => reject(error));
            } finally {
              mutationState.inFlightGeneration = 0;
            }
          }
        } finally {
          mutationState.draining = false;
        }
      });
    }
    return promise;
  };

  const setEditorState = (update) => {
    if (!plainObject(update)) throw new Error('The Team Invites editor state is invalid.');
    const value = Object.fromEntries(safeEntries(update));
    if (Object.prototype.hasOwnProperty.call(value, 'active')) {
      if (typeof value.active !== 'boolean') {
        throw new Error('The Team Invites editor state is invalid.');
      }
      mutationState.editorActive = value.active;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'dirty')) {
      if (typeof value.dirty !== 'boolean') {
        throw new Error('The Team Invites editor state is invalid.');
      }
      mutationState.editorDirty = value.dirty;
    }
    wakeEditorWaiters();
  };

  const baseStateForWrite = (raw) => {
    const current = readStateFromRaw(raw, seedState?.normalizeHistorical);
    if (current) return current;
    if (!seedState || !validCurrentState(seedState.value)) {
      throw new Error('Team Invites defaults are unavailable. Local data was not changed.');
    }
    return canonicalState(seedState.value);
  };

  const writeFullStateUnlocked = (candidate, source) => {
    if (!validCurrentState(candidate)) throw new Error('The Team Invites app state is invalid.');
    const value = canonicalState(candidate);
    const snapshot = captureRaw();
    const previous = readStateFromRaw(snapshot[0].raw, seedState?.normalizeHistorical);
    compareAndSet(snapshot, [{ key: STORAGE_KEY, raw: JSON.stringify(value) }],
      'Team Invites app data');
    storageWarning = '';
    dispatchChange('state', source);
    return previous;
  };

  const applyPreferencesUnlocked = (candidate, source, assertCurrent = () => {}) => {
    if (!validPreferences(candidate)) {
      throw new Error('The synchronized Team Invites preferences are invalid.');
    }
    const snapshot = captureRaw();
    const current = baseStateForWrite(snapshot[0].raw);
    current.preferences.activeProgram = canonicalPreferences(candidate).activeProgram;
    current.updatedAt = new Date().toISOString();
    assertCurrent();
    compareAndSet(snapshot, [{ key: STORAGE_KEY, raw: JSON.stringify(canonicalState(current)) }],
      'Team Invites preferences');
    storageWarning = '';
    dispatchChange('preferences', source);
    return true;
  };

  const applyTemplateUnlocked = (
    program,
    candidate,
    source,
    assertCurrent = () => {},
  ) => {
    if (!validTemplate(candidate, program, true)) {
      throw new Error(`The synchronized ${program} Team Invites template is invalid.`);
    }
    const snapshot = captureRaw();
    const current = baseStateForWrite(snapshot[0].raw);
    current.templates[program] = canonicalTemplate(candidate, program);
    current.updatedAt = new Date().toISOString();
    assertCurrent();
    compareAndSet(snapshot, [{ key: STORAGE_KEY, raw: JSON.stringify(canonicalState(current)) }],
      `${program} Team Invites template`);
    storageWarning = '';
    dispatchChange('templates', source);
    return true;
  };

  const listInvitesUnlocked = async () => {
    const snapshot = captureRaw();
    const current = readStateFromRaw(snapshot[0].raw, seedState?.normalizeHistorical);
    if (!current) return [];
    const records = await identifyInvites(current.invites);
    assertRawUnchanged(snapshot, 'Team Invites invitation data');
    return records.map(({ recordId, value }) => ({ recordId, value }));
  };

  const applyInviteUnlocked = async (
    recordId,
    candidate,
    deleted,
    source,
    assertCurrent = () => {},
  ) => {
    if (!/^invite-[a-f0-9]{64}$/.test(recordId || '')) {
      throw new Error('The synchronized Team Invites invitation ID is invalid.');
    }
    const snapshot = captureRaw();
    const current = baseStateForWrite(snapshot[0].raw);
    const identified = await identifyInvites(current.invites);
    assertRawUnchanged(snapshot, 'Team Invites invitation data');
    const matches = identified.filter((item) => item.recordId === recordId);
    if (matches.length > 1) {
      throw new Error('Local Team Invites invitation identities collide and need review.');
    }
    if (deleted) {
      if (!matches.length) {
        assertCurrent();
        assertRawUnchanged(snapshot, 'Team Invites invitation data');
        return true;
      }
      current.invites = current.invites.filter((invite) => invite.id !== matches[0].sourceId);
    } else {
      if (!validCurrentInvite(candidate, true)) {
        throw new Error('The synchronized Team Invites invitation is invalid.');
      }
      const value = canonicalInvite(candidate);
      if (await inviteRecordId(value.id) !== recordId) {
        throw new Error('The synchronized Team Invites invitation identity does not match its record.');
      }
      if (matches.length && matches[0].sourceId !== value.id) {
        throw new Error('The synchronized Team Invites invitation identity collides with local data.');
      }
      const index = current.invites.findIndex((invite) => invite.id === value.id);
      if (index >= 0) current.invites[index] = value;
      else current.invites.push(value);
    }
    current.updatedAt = new Date().toISOString();
    if (!validCurrentState(current)) {
      throw new Error('The synchronized invitation would make local Team Invites data invalid.');
    }
    assertCurrent();
    compareAndSet(snapshot, [{ key: STORAGE_KEY, raw: JSON.stringify(canonicalState(current)) }],
      'Team Invites invitation data');
    storageWarning = '';
    dispatchChange('invites', source);
    return true;
  };

  const requireWriteSource = (metadata) => {
    if (!metadata || !['local', 'remote-migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid local write source.');
    }
  };

  const requireRemoteSource = (metadata) => {
    if (!metadata || !['remote', 'migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid remote write source.');
    }
  };

  const rejectFixedTombstone = (metadata, label) => {
    if (metadata && metadata.deleted) {
      throw new Error(`${label} is a fixed record and cannot be deleted.`);
    }
  };

  const localOrMigratedWrite = (metadata, task) => {
    requireWriteSource(metadata);
    return metadata.source === 'remote-migration'
      ? withRemoteWrite(task)
      : withAggregateLock(() => task(() => {}));
  };

  const readPreferencesUnlocked = () => {
    const current = readStateUnlocked();
    return current ? preferencesFromState(current) : undefined;
  };

  const readTemplateUnlocked = (program) => {
    const current = readStateUnlocked();
    return current ? templateFromState(current, program) : undefined;
  };

  const fixedAdapter = (program = '') => {
    const isPreferences = !program;
    const label = isPreferences ? 'Team Invites preferences' : `${program} Team Invites template`;
    const validate = isPreferences
      ? validPreferences
      : (candidate) => validTemplate(candidate, program, true);
    const read = isPreferences
      ? readPreferencesUnlocked
      : () => readTemplateUnlocked(program);
    const apply = isPreferences
      ? applyPreferencesUnlocked
      : (candidate, source, assertCurrent) =>
        applyTemplateUnlocked(program, candidate, source, assertCurrent);
    return {
      scope: APP_ID,
      appId: APP_ID,
      collection: isPreferences ? 'preferences' : 'templates',
      recordId: isPreferences ? 'current' : program.toLowerCase(),
      schemaVersion: SCHEMA_VERSION,
      validate,
      readLocal: () => withConsistentRead(read),
      writeLocal: (value, metadata) => {
        rejectFixedTombstone(metadata, label);
        return localOrMigratedWrite(metadata, (assertCurrent) =>
          apply(value, metadata.source, assertCurrent));
      },
      applyRemote: (value, metadata) => {
        requireRemoteSource(metadata);
        rejectFixedTombstone(metadata, label);
        return withRemoteWrite((assertCurrent) =>
          apply(value, metadata.source, assertCurrent));
      },
    };
  };

  const makeAdapters = () => ({
    preferences: fixedAdapter(),
    templateNGA: fixedAdapter('NGA'),
    templateUSAG: fixedAdapter('USAG'),
    invites: {
      scope: APP_ID,
      appId: APP_ID,
      collection: 'invites',
      schemaVersion: SCHEMA_VERSION,
      validate: (candidate, recordId = '') =>
        validCurrentInvite(candidate, true) &&
        (!recordId || /^invite-[a-f0-9]{64}$/.test(recordId)),
      listLocal: () => withConsistentRead(listInvitesUnlocked),
      writeLocal: (recordId, value, metadata) =>
        localOrMigratedWrite(metadata, (assertCurrent) =>
          applyInviteUnlocked(
            recordId,
            value,
            Boolean(metadata.deleted),
            metadata.source,
            assertCurrent,
          )),
      applyRemote: (recordId, value, metadata) => {
        requireRemoteSource(metadata);
        return withRemoteWrite((assertCurrent) =>
          applyInviteUnlocked(
            recordId,
            value,
            Boolean(metadata.deleted),
            metadata.source,
            assertCurrent,
          ));
      },
    },
  });

  const attachHandles = (next) => {
    if (!exactKeys(next, ['preferences', 'templateNGA', 'templateUSAG', 'invites'])) {
      throw new Error('Team Invites sync handles are incomplete.');
    }
    const value = Object.fromEntries(safeEntries(next));
    if (!value.preferences || typeof value.preferences.save !== 'function' ||
        !value.templateNGA || typeof value.templateNGA.save !== 'function' ||
        !value.templateUSAG || typeof value.templateUSAG.save !== 'function' ||
        !value.invites || typeof value.invites.save !== 'function' ||
        typeof value.invites.remove !== 'function') {
      throw new Error('Team Invites sync handles are incomplete.');
    }
    handles = Object.freeze({ ...value });
  };

  const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  const stageStateChanges = async (previous, current) => {
    if (!handles) return;
    const previousPreferences = previous ? preferencesFromState(previous) : undefined;
    const nextPreferences = preferencesFromState(current);
    if (!previousPreferences || !sameValue(previousPreferences, nextPreferences)) {
      await handles.preferences.save(nextPreferences);
    }
    for (const program of PROGRAMS) {
      const previousTemplate = previous ? templateFromState(previous, program) : undefined;
      const nextTemplate = templateFromState(current, program);
      if (!previousTemplate || !sameValue(previousTemplate, nextTemplate)) {
        await handles[`template${program}`].save(nextTemplate);
      }
    }

    const oldInvites = previous ? await identifyInvites(previous.invites) : [];
    const newInvites = await identifyInvites(current.invites);
    const oldById = new Map(oldInvites.map((item) => [item.recordId, item]));
    const newById = new Map(newInvites.map((item) => [item.recordId, item]));
    for (const item of newInvites) {
      if (!oldById.has(item.recordId) ||
          !sameValue(oldById.get(item.recordId).value, item.value)) {
        await handles.invites.save(item.recordId, item.value);
      }
    }
    for (const item of oldInvites) {
      if (!newById.has(item.recordId)) await handles.invites.remove(item.recordId);
    }
  };

  const saveState = (candidate) => {
    if (!validCurrentState(candidate)) {
      return Promise.reject(new Error('The Team Invites app state is invalid.'));
    }
    const value = canonicalState(candidate);
    return enqueueLatest(async () => {
      const previous = await withAggregateLock(() =>
        writeFullStateUnlocked(value, 'local'));
      await stageStateChanges(previous, value);
      return true;
    });
  };

  const loadState = (fallback, normalizeHistorical) => {
    if (!validCurrentState(fallback) || typeof normalizeHistorical !== 'function') {
      throw new Error('Team Invites defaults are invalid.');
    }
    seedState = {
      value: canonicalState(fallback),
      normalizeHistorical,
    };
    try {
      const current = readStateUnlocked();
      storageWarning = '';
      return current || canonicalState(seedState.value);
    } catch (error) {
      storageWarning = error.message;
      return canonicalState(seedState.value);
    }
  };

  const assertOwnedStorageValid = () => {
    readStateUnlocked();
    return true;
  };

  const rawBackup = () => ({
    version: 1,
    kind: 'team_invites_browser_local_raw_backup',
    app_id: APP_ID,
    exported_at: new Date().toISOString(),
    records: RAW_BACKUP_KEYS.map((key) => {
      const rawValue = window.localStorage.getItem(key);
      return {
        key,
        present: rawValue !== null,
        raw_value: rawValue,
      };
    }),
  });

  window.TeamInvitesStorage = Object.freeze({
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    changeEvent: CHANGE_EVENT,
    aggregateLock: AGGREGATE_LOCK,
    storageKey: STORAGE_KEY,
    rawBackupKeys: RAW_BACKUP_KEYS,
    rawBackup,
    validCurrentState,
    canonicalState,
    validPreferences,
    validTemplate,
    validCurrentInvite,
    inviteRecordId,
    makeAdapters,
    attachHandles,
    setEditorState,
    saveState,
    loadState,
    assertOwnedStorageValid,
    getStorageWarning: () => storageWarning,
  });
})();
