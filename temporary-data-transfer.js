/* Temporary owner-operated migration controls. Remove after every active browser is migrated. */
(() => {
  "use strict";

  const TRANSFER_VERSION = 1;
  const TRANSFER_KIND = "ryan_app_settings_data_transfer";
  const MAX_RECORD_BYTES = 900 * 1024;
  const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
  const MAX_JSON_DEPTH = 48;
  const SYNC_COLLECTION = "browser-storage";

  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const exactKeys = (value, expected) => isObject(value)
    && Object.keys(value).length === expected.length
    && Object.keys(value).every((key) => expected.includes(key));
  const bytes = (value) => new TextEncoder().encode(value).byteLength;
  const recordKey = (appId) => `__ryan_temporary_sync_${appId}_v1`;

  function jsonIsSafe(value, depth = 0) {
    if (depth > MAX_JSON_DEPTH || value === null) return depth <= MAX_JSON_DEPTH;
    if (["string", "boolean"].includes(typeof value)) return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.length <= 20_000
      && value.every((item) => jsonIsSafe(item, depth + 1));
    if (!isObject(value)) return false;
    const entries = Object.entries(value);
    return entries.length <= 20_000 && entries.every(([key, item]) => (
      key.length <= 240
      && key !== "__proto__"
      && key !== "constructor"
      && key !== "prototype"
      && jsonIsSafe(item, depth + 1)
    ));
  }

  function tryParseJson(raw) {
    try {
      return { parsed: true, value: JSON.parse(raw) };
    } catch {
      return { parsed: false, value: raw };
    }
  }

  function encodeRaw(raw) {
    if (raw === null) return { present: false, encoding: "text", value: null };
    const parsed = tryParseJson(raw);
    if (parsed.parsed && jsonIsSafe(parsed.value)) {
      return { present: true, encoding: "json", value: parsed.value };
    }
    return { present: true, encoding: "text", value: raw };
  }

  function decodeRecord(record) {
    if (!record.present) return null;
    return record.encoding === "json" ? JSON.stringify(record.value) : record.value;
  }

  function downloadJson(value, filename) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function filenamePart(value) {
    return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  }

  function formatCount(count) {
    return `${count} record${count === 1 ? "" : "s"}`;
  }

  function rawValuesFor(options) {
    return options.storageKeys.map((key) => ({ key, raw: window.localStorage.getItem(key) }));
  }

  function buildBundle(options, source = "export") {
    const records = rawValuesFor(options).map(({ key, raw }) => ({ key, ...encodeRaw(raw) }));
    return {
      version: TRANSFER_VERSION,
      kind: TRANSFER_KIND,
      app_id: options.appId,
      exported_at: new Date().toISOString(),
      source,
      records,
    };
  }

  function recordReviewSummary(record) {
    if (!record || !record.present) return "not present";
    if (record.encoding === "text") return `text (${bytes(record.value)} bytes)`;
    try {
      return `JSON (${bytes(JSON.stringify(record.value))} bytes)`;
    } catch {
      return "unreadable JSON";
    }
  }

  function buildConflictReviewBundle(options, conflict) {
    return {
      version: TRANSFER_VERSION,
      kind: "ryan_app_sync_conflict_review",
      app_id: options.appId,
      created_at: new Date().toISOString(),
      record: {
        key: conflict.key,
        local: conflict.local,
        synchronized: {
          revision: conflict.remote.revision,
          updated_at: conflict.remote.updatedAt || null,
          value: conflict.remote.value,
        },
      },
    };
  }

  function downloadConflictReview(options, conflict) {
    downloadJson(
      buildConflictReviewBundle(options, conflict),
      `${filenamePart(options.appId)}-sync-conflict-${filenamePart(conflict.key)}-${new Date().toISOString().slice(0, 10)}.json`,
    );
  }

  function validTimestamp(value) {
    return typeof value === "string" && value.length <= 80 && Number.isFinite(Date.parse(value));
  }

  function normalizeRecord(candidate, allowedKeys) {
    if (!exactKeys(candidate, ["key", "present", "encoding", "value"])
      || typeof candidate.key !== "string"
      || !allowedKeys.has(candidate.key)
      || typeof candidate.present !== "boolean"
      || !["json", "text"].includes(candidate.encoding)) return null;
    if (!candidate.present) {
      return candidate.value === null ? { key: candidate.key, present: false, encoding: "text", value: null } : null;
    }
    if (candidate.encoding === "text") {
      if (typeof candidate.value !== "string" || bytes(candidate.value) > MAX_RECORD_BYTES) return null;
      return { key: candidate.key, present: true, encoding: "text", value: candidate.value };
    }
    if (!jsonIsSafe(candidate.value)) return null;
    let raw;
    try {
      raw = JSON.stringify(candidate.value);
    } catch {
      return null;
    }
    if (typeof raw !== "string" || bytes(raw) > MAX_RECORD_BYTES) return null;
    return { key: candidate.key, present: true, encoding: "json", value: candidate.value };
  }

  function normalizeRawBackup(parsed, options) {
    if (!isObject(parsed)
      || parsed.app_id !== options.appId
      || typeof parsed.kind !== "string"
      || !parsed.kind.endsWith("_browser_local_raw_backup")
      || !Number.isInteger(parsed.version)
      || !Array.isArray(parsed.records)) return null;
    return {
      version: TRANSFER_VERSION,
      kind: TRANSFER_KIND,
      app_id: options.appId,
      exported_at: typeof parsed.exported_at === "string" ? parsed.exported_at : new Date().toISOString(),
      source: "legacy-backup",
      records: parsed.records.map((record) => {
        if (!isObject(record)
          || typeof record.key !== "string"
          || typeof record.present !== "boolean"
          || !own(record, "raw_value")) return null;
        if (!record.present && record.raw_value !== null) return null;
        if (record.present && typeof record.raw_value !== "string") return null;
        return { key: record.key, ...encodeRaw(record.raw_value) };
      }),
    };
  }

  function normalizeBundle(parsed, options) {
    const legacy = normalizeRawBackup(parsed, options);
    const candidate = legacy || parsed;
    if (!isObject(candidate)
      || !exactKeys(candidate, ["version", "kind", "app_id", "exported_at", "source", "records"])
      || candidate.version !== TRANSFER_VERSION
      || candidate.kind !== TRANSFER_KIND
      || candidate.app_id !== options.appId
      || !validTimestamp(candidate.exported_at)
      || typeof candidate.source !== "string"
      || !Array.isArray(candidate.records)
      || candidate.records.length !== options.storageKeys.length) {
      throw new Error("This file is not a supported settings and data transfer for this app.");
    }
    const allowed = new Set(options.storageKeys);
    const normalized = candidate.records.map((record) => normalizeRecord(record, allowed));
    if (normalized.some((record) => record === null)) {
      throw new Error("This transfer file has an unsupported record schema.");
    }
    const records = normalized;
    if (new Set(records.map((record) => record.key)).size !== records.length
      || records.some((record) => !allowed.has(record.key))
      || options.storageKeys.some((key) => !records.some((record) => record.key === key))) {
      throw new Error("This transfer file is missing a required app record or contains a duplicate.");
    }
    const rawTotal = records.reduce((total, record) => total + (record.present ? bytes(decodeRecord(record)) : 0), 0);
    if (rawTotal > MAX_TOTAL_BYTES) throw new Error("This transfer file is too large for a safe browser import.");
    const validation = options.validate(records);
    if (validation !== true) throw new Error(validation || "This transfer file contains invalid app data.");
    return { ...candidate, records };
  }

  function plainJsonRecord(raw, label) {
    if (raw === null) return null;
    const parsed = tryParseJson(raw);
    if (!parsed.parsed || !jsonIsSafe(parsed.value)) return `${label} is not valid JSON.`;
    return parsed.value;
  }

  function recordsByKey(records) {
    return new Map(records.map((record) => [record.key, record]));
  }

  function validateByApp(appId, records) {
    const byKey = recordsByKey(records);
    const raw = (key) => decodeRecord(byKey.get(key));
    if (appId === "student-shuffle") {
      const selected = raw("student-random-order-selected-class-v1");
      if (selected !== null && (!/^(?:builtin:[a-z0-9]+(?:-[a-z0-9]+)*|custom:.{1,200})$/.test(selected) || /[\u0000-\u001f\u007f]/.test(selected))) {
        return "The selected Student Shuffle class is invalid.";
      }
      const hidden = plainJsonRecord(raw("student-random-order-hidden-students-v1"), "Student Shuffle attendance");
      if (typeof hidden === "string" || (hidden !== null && (!Array.isArray(hidden) || !hidden.every((name) => typeof name === "string" && name.length <= 240)))) {
        return "Student Shuffle attendance has an invalid schema.";
      }
      const classes = plainJsonRecord(raw("student-random-order-classes-v1"), "Student Shuffle classes");
      if (typeof classes === "string" || (classes !== null && !isObject(classes))) return "Student Shuffle classes have an invalid schema.";
      const sound = raw("student-random-order-sound-v1");
      if (sound !== null && !["on", "off"].includes(sound)) return "The Student Shuffle sound setting is invalid.";
      return true;
    }
    if (appId === "team-games") {
      const stateRaw = raw("camp-group-randomizer-v1");
      if (stateRaw !== null) {
        const state = plainJsonRecord(stateRaw, "Team Games state");
        if (typeof state === "string" || !window.TeamGamesStorage?.validateState?.(state)) return "Team Games state has an invalid schema.";
      }
      const selected = raw("team-games-selected-class-v1");
      if (selected !== null && (selected.length > 240 || /[\u0000-\u001f\u007f]/.test(selected))) return "The Team Games class selection is invalid.";
      const cache = plainJsonRecord(raw("team-games-class-roster-cache-v1"), "Team Games class cache");
      if (typeof cache === "string" || (cache !== null && !isObject(cache))) return "The Team Games class cache has an invalid schema.";
      return true;
    }
    if (appId === "team-invites") {
      const stateRaw = raw("team-invites-v1");
      if (stateRaw === null) return true;
      const state = plainJsonRecord(stateRaw, "Team Invitations data");
      if (typeof state === "string" || !window.TeamInvitesStorage?.validCurrentState?.(state)) return "Team Invitations data has an invalid schema.";
      return true;
    }
    if (appId === "timecard-validator") {
      const stateRaw = raw("timecard-validator-v1");
      if (stateRaw === null) return true;
      const state = plainJsonRecord(stateRaw, "Timecard Validator data");
      if (typeof state === "string" || !(window.TimecardStore?.isState?.(state) || window.TimecardStore?.isLegacyState?.(state))) return "Timecard Validator data has an invalid schema.";
      return true;
    }
    if (appId === "tally-clicker") {
      const jsonKeys = [
        "custom-points-counter-state-v5", "custom-points-counter-state-v4",
        "custom-points-counter-state-v3", "custom-points-counter-state-v2",
        "streak-counter-state-v2", "streak-counter-state-v1",
      ];
      for (const key of jsonKeys) {
        const value = plainJsonRecord(raw(key), "Tally Clicker data");
        if (typeof value === "string" || (value !== null && !isObject(value))) return "Tally Clicker data has an invalid schema.";
      }
      for (const key of ["custom-points-counter-value-v1", "streak-counter-sound-v1"]) {
        const value = raw(key);
        if (value !== null && (value.length > 160 || /[\u0000-\u001f\u007f]/.test(value))) return "A Tally Clicker setting is invalid.";
      }
      return true;
    }
    return "This app has no configured transfer schema.";
  }

  async function withLock(name, task) {
    if (navigator.locks?.request) return navigator.locks.request(name, { mode: "exclusive" }, task);
    return task();
  }

  async function importBundle(bundle, options) {
    const before = rawValuesFor(options);
    const beforeBundle = buildBundle(options, "automatic-pre-import-backup");
    downloadJson(
      beforeBundle,
      `${filenamePart(options.appId)}-pre-import-backup-${new Date().toISOString().slice(0, 10)}.json`,
    );
    const incoming = recordsByKey(bundle.records);
    await withLock(`ryan-temporary-import:${options.appId}`, async () => {
      try {
        for (const key of options.storageKeys) {
          const raw = decodeRecord(incoming.get(key));
          if (raw === null) window.localStorage.removeItem(key);
          else window.localStorage.setItem(key, raw);
          if (window.localStorage.getItem(key) !== raw) throw new Error("Browser storage did not confirm the imported data.");
        }
      } catch (error) {
        for (const { key, raw } of before) {
          if (raw === null) window.localStorage.removeItem(key);
          else window.localStorage.setItem(key, raw);
        }
        throw error;
      }
    });
    window.dispatchEvent(new CustomEvent("ryan-temporary-data-imported", {
      detail: { appId: options.appId, records: options.storageKeys.slice() },
    }));
  }

  function readSyncState(options) {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(recordKey(options.appId)) || "null");
      if (!isObject(parsed) || typeof parsed.enabled !== "boolean" || !isObject(parsed.records)) {
        return { enabled: false, records: {} };
      }
      return { enabled: parsed.enabled, records: parsed.records };
    } catch {
      return { enabled: false, records: {} };
    }
  }

  function saveSyncState(options, state) {
    window.localStorage.setItem(recordKey(options.appId), JSON.stringify(state));
  }

  function syncSupported() {
    return location.protocol === "https:" && location.hostname.endsWith(".chatgpt.site");
  }

  function comparableValue(value) {
    return JSON.stringify(value);
  }

  async function responseJson(response) {
    try { return await response.json(); } catch { return null; }
  }

  async function syncRecords(options, ui, interactive = false) {
    if (!syncSupported()) {
      ui.setSync("Local transfer is ready. Private sync is available in the ChatGPT Site.", "local");
      return;
    }
    ui.setSync("Syncing safely…", "pending");
    let manifestResponse;
    try {
      manifestResponse = await fetch(`/api/app-sync?appId=${encodeURIComponent(options.appId)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch {
      ui.setSync("Offline. Local data is preserved and will retry later.", "offline");
      return;
    }
    const manifest = await responseJson(manifestResponse);
    if (!manifestResponse.ok || !manifest || !Array.isArray(manifest.records)) {
      ui.setSync(manifest?.error || "Private sync is unavailable. Local data is preserved.", "offline");
      return;
    }
    const remote = new Map(manifest.records.map((record) => [record.recordId, record]));
    const syncState = readSyncState(options);
    const conflicts = [];
    let changed = 0;

    async function upload(key, current, expectedRevision) {
      const response = await fetch("/api/app-sync", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          appId: options.appId,
          collection: SYNC_COLLECTION,
          recordId: key,
          expectedRevision,
          value: current,
        }),
      });
      const body = await responseJson(response);
      if (response.ok && body?.record) return { ok: true, record: body.record };
      if (response.status === 409 && body?.current) return { ok: false, conflict: body.current };
      throw new Error(body?.error || "Private sync could not save a record.");
    }

    try {
      for (const key of options.storageKeys) {
        const local = encodeRaw(window.localStorage.getItem(key));
        const fingerprint = comparableValue(local);
        const known = syncState.records[key];
        const currentRemote = remote.get(key) || null;
        if (!currentRemote) {
          if (local.present) {
            const uploaded = await upload(key, local, null);
            if (uploaded.ok) {
              syncState.records[key] = { revision: uploaded.record.revision, fingerprint };
              changed += 1;
            } else conflicts.push({ key, local, remote: uploaded.conflict });
          }
          continue;
        }
        const remoteFingerprint = comparableValue(currentRemote.value);
        if (!known) {
          if (!local.present) {
            const remoteRaw = currentRemote.value.present ? decodeRecord(currentRemote.value) : null;
            if (remoteRaw === null) window.localStorage.removeItem(key);
            else window.localStorage.setItem(key, remoteRaw);
            syncState.records[key] = { revision: currentRemote.revision, fingerprint: remoteFingerprint };
            changed += 1;
          } else if (fingerprint === remoteFingerprint) {
            syncState.records[key] = { revision: currentRemote.revision, fingerprint };
          } else {
            conflicts.push({ key, local, remote: currentRemote });
          }
          continue;
        }
        const localChanged = known.fingerprint !== fingerprint;
        const remoteChanged = known.revision !== currentRemote.revision;
        if (localChanged && remoteChanged && fingerprint !== remoteFingerprint) {
          conflicts.push({ key, local, remote: currentRemote });
        } else if (localChanged) {
          const uploaded = await upload(key, local, known.revision);
          if (uploaded.ok) {
            syncState.records[key] = { revision: uploaded.record.revision, fingerprint };
            changed += 1;
          } else conflicts.push({ key, local, remote: uploaded.conflict });
        } else if (remoteChanged) {
          const remoteRaw = currentRemote.value.present ? decodeRecord(currentRemote.value) : null;
          if (remoteRaw === null) window.localStorage.removeItem(key);
          else window.localStorage.setItem(key, remoteRaw);
          syncState.records[key] = { revision: currentRemote.revision, fingerprint: remoteFingerprint };
          changed += 1;
        } else {
          syncState.records[key] = { revision: currentRemote.revision, fingerprint };
        }
      }
    } catch (error) {
      ui.setSync(error instanceof Error ? error.message : "Private sync did not finish.", "offline");
      return;
    }
    syncState.enabled = true;
    saveSyncState(options, syncState);
    ui.setConflicts(conflicts, async (conflict, choice) => {
      try {
        if (choice === "remote") {
          const safe = buildBundle(options, "automatic-pre-conflict-backup");
          downloadJson(safe, `${filenamePart(options.appId)}-pre-conflict-backup-${new Date().toISOString().slice(0, 10)}.json`);
          const remoteRaw = conflict.remote.value.present ? decodeRecord(conflict.remote.value) : null;
          if (remoteRaw === null) window.localStorage.removeItem(conflict.key);
          else window.localStorage.setItem(conflict.key, remoteRaw);
          const next = readSyncState(options);
          next.records[conflict.key] = {
            revision: conflict.remote.revision,
            fingerprint: comparableValue(conflict.remote.value),
          };
          next.enabled = true;
          saveSyncState(options, next);
        } else {
          const uploaded = await upload(conflict.key, conflict.local, conflict.remote.revision);
          if (!uploaded.ok) throw new Error("The synchronized record changed again. Review it once more.");
          const next = readSyncState(options);
          next.records[conflict.key] = {
            revision: uploaded.record.revision,
            fingerprint: comparableValue(conflict.local),
          };
          next.enabled = true;
          saveSyncState(options, next);
        }
        await syncRecords(options, ui, true);
      } catch (error) {
        ui.setSync(error instanceof Error ? error.message : "Conflict resolution did not finish.", "conflict");
      }
    });
    if (conflicts.length) {
      ui.setSync(`${formatCount(conflicts.length)} need${conflicts.length === 1 ? "s" : ""} your choice. Nothing was overwritten.`, "conflict");
    } else {
      ui.setSync(changed ? `Synced ${formatCount(changed)} safely.` : "Synced. Every local record is current.", "synced");
      if (changed && interactive) window.setTimeout(() => window.location.reload(), 550);
    }
  }

  function makeUi(options) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "ryan-transfer-open";
    open.textContent = "Transfer data";
    open.setAttribute("aria-haspopup", "dialog");

    const dialog = document.createElement("dialog");
    dialog.className = "ryan-transfer-dialog";
    dialog.innerHTML = `
      <section class="ryan-transfer-card" aria-labelledby="ryan-transfer-title">
        <header><div><small>TEMPORARY MIGRATION TOOL</small><h2 id="ryan-transfer-title">Settings &amp; data transfer</h2></div><button type="button" data-close aria-label="Close data transfer">×</button></header>
        <p>Move this app’s saved settings and data between the legacy page and its private ChatGPT Site. Photos and videos are not included.</p>
        <div class="ryan-transfer-actions"><button type="button" data-export>Export Settings &amp; Data</button><button type="button" data-import>Import Settings &amp; Data</button><input data-file type="file" accept="application/json,.json" hidden></div>
        <p class="ryan-transfer-status" data-status>Choose Export to make a portable JSON file, or Import to preview one.</p>
        <section class="ryan-transfer-preview" data-preview hidden><h3>Import preview</h3><p data-preview-copy></p><button type="button" data-confirm disabled>Confirm &amp; replace local data</button></section>
        <section class="ryan-transfer-sync" data-sync-section hidden><h3>Private device sync</h3><p data-sync>Connect this browser to the private, same-site sync record store.</p><button type="button" data-sync-button>Enable private sync &amp; sync now</button><div data-conflicts></div></section>
        <p class="ryan-transfer-footnote">Import checks the app ID and data schema first, then downloads a safety backup before it replaces anything.</p>
      </section>`;

    const style = document.createElement("style");
    style.textContent = `
      .ryan-transfer-open{position:fixed!important;right:12px!important;bottom:12px!important;z-index:2147483000!important;min-height:42px!important;padding:8px 12px!important;border:2px solid #102117!important;border-radius:7px!important;background:#f4e253!important;color:#102117!important;box-shadow:3px 3px 0 #102117!important;font:700 14px/1.15 Tahoma,Verdana,Arial,sans-serif!important;letter-spacing:.02em!important;cursor:pointer!important}.ryan-transfer-open:focus-visible,.ryan-transfer-dialog button:focus-visible{outline:3px solid #1677ff!important;outline-offset:2px!important}.ryan-transfer-dialog{z-index:2147483001!important;width:min(700px,calc(100vw - 24px))!important;max-width:700px!important;max-height:calc(100vh - 24px)!important;margin:auto!important;padding:0!important;border:0!important;border-radius:12px!important;background:#f5f8ee!important;color:#102117!important;box-shadow:0 18px 60px rgba(0,0,0,.48)!important;font:16px/1.45 Tahoma,Verdana,Arial,sans-serif!important}.ryan-transfer-dialog::backdrop{background:rgba(0,0,0,.62)!important}.ryan-transfer-card{padding:18px!important}.ryan-transfer-card header{display:flex!important;justify-content:space-between!important;gap:16px!important;align-items:flex-start!important;padding-bottom:12px!important;border-bottom:2px solid #a8be9a!important}.ryan-transfer-card h2,.ryan-transfer-card h3,.ryan-transfer-card p{margin:0!important;color:#102117!important;text-align:left!important}.ryan-transfer-card h2{font-size:24px!important}.ryan-transfer-card h3{font-size:17px!important}.ryan-transfer-card small{font-weight:700!important;letter-spacing:.09em!important}.ryan-transfer-card header button{min-width:36px!important;min-height:36px!important;font-size:24px!important}.ryan-transfer-actions{display:flex!important;flex-wrap:wrap!important;gap:9px!important;margin:15px 0!important}.ryan-transfer-card button{display:inline-flex!important;align-items:center!important;justify-content:center!important;min-height:40px!important;padding:8px 11px!important;border:2px solid #102117!important;border-radius:6px!important;background:#d7f0b7!important;color:#102117!important;box-shadow:none!important;font:700 14px/1.2 Tahoma,Verdana,Arial,sans-serif!important;cursor:pointer!important}.ryan-transfer-card button:disabled{opacity:.56!important;cursor:not-allowed!important}.ryan-transfer-status,.ryan-transfer-preview,.ryan-transfer-sync{margin-top:13px!important;padding:12px!important;border:1px solid #8ba377!important;border-radius:7px!important;background:#fff!important}.ryan-transfer-preview h3,.ryan-transfer-sync h3{margin-bottom:5px!important}.ryan-transfer-preview button,.ryan-transfer-sync button{margin-top:10px!important}.ryan-transfer-footnote{margin-top:14px!important;font-size:12px!important;color:#34503c!important}.ryan-transfer-conflict{display:grid!important;grid-template-columns:1fr auto auto!important;gap:6px!important;align-items:center!important;margin-top:9px!important;padding-top:9px!important;border-top:1px solid #cad8be!important}.ryan-transfer-conflict button{min-height:32px!important;padding:5px 7px!important;font-size:12px!important}@media(max-width:520px){.ryan-transfer-card{padding:14px!important}.ryan-transfer-conflict{grid-template-columns:1fr!important}.ryan-transfer-open{right:8px!important;bottom:8px!important}}`;
    style.textContent += ".ryan-transfer-conflict{display:grid!important;gap:6px!important;margin-top:9px!important;padding-top:9px!important;border-top:1px solid #cad8be!important}.ryan-transfer-conflict-details{font-size:12px!important;color:#34503c!important}.ryan-transfer-conflict-actions{display:flex!important;flex-wrap:wrap!important;gap:6px!important}";
    document.head.append(style);
    document.body.append(open, dialog);

    const status = dialog.querySelector("[data-status]");
    const preview = dialog.querySelector("[data-preview]");
    const previewCopy = dialog.querySelector("[data-preview-copy]");
    const confirm = dialog.querySelector("[data-confirm]");
    const file = dialog.querySelector("[data-file]");
    const syncSection = dialog.querySelector("[data-sync-section]");
    const syncCopy = dialog.querySelector("[data-sync]");
    const conflictsNode = dialog.querySelector("[data-conflicts]");
    let pendingBundle = null;

    const show = () => {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    };
    const close = () => {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    };
    open.addEventListener("click", show);
    dialog.querySelector("[data-close]").addEventListener("click", close);
    dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
    dialog.querySelector("[data-export]").addEventListener("click", () => {
      try {
        downloadJson(buildBundle(options), `${filenamePart(options.appId)}-settings-data-${new Date().toISOString().slice(0, 10)}.json`);
        status.textContent = "Export downloaded. Keep it until every device is confirmed.";
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Export could not finish.";
      }
    });
    dialog.querySelector("[data-import]").addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      const selected = file.files?.[0];
      file.value = "";
      pendingBundle = null;
      preview.hidden = true;
      confirm.disabled = true;
      if (!selected) return;
      if (selected.size > MAX_TOTAL_BYTES * 2) {
        status.textContent = "This file is too large for a safe import.";
        return;
      }
      try {
        const parsed = JSON.parse(await selected.text());
        pendingBundle = normalizeBundle(parsed, options);
        const currentCount = rawValuesFor(options).filter((record) => record.raw !== null).length;
        const incomingCount = pendingBundle.records.filter((record) => record.present).length;
        previewCopy.textContent = `${formatCount(incomingCount)} from ${selected.name} will replace ${formatCount(currentCount)} currently stored in this browser. A safety backup downloads first.`;
        preview.hidden = false;
        confirm.disabled = false;
        status.textContent = "Import file is valid and ready for confirmation.";
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "This file could not be read.";
      }
    });
    confirm.addEventListener("click", async () => {
      if (!pendingBundle) return;
      if (!window.confirm("Replace this browser’s app settings and data? A safety backup will download first.")) return;
      confirm.disabled = true;
      try {
        await importBundle(pendingBundle, options);
        status.textContent = "Import completed. Reloading the app with the transferred data…";
        window.setTimeout(() => window.location.reload(), 500);
      } catch (error) {
        confirm.disabled = false;
        status.textContent = error instanceof Error ? error.message : "Import failed. The existing local data was restored.";
      }
    });

    return {
      setSync(message, state) {
        if (!syncSection.hidden) syncCopy.textContent = message;
        dialog.dataset.syncState = state;
      },
      setConflicts(conflicts, resolve) {
        conflictsNode.replaceChildren();
        for (const conflict of conflicts) {
          const row = document.createElement("div");
          row.className = "ryan-transfer-conflict";
          const label = document.createElement("strong");
          label.textContent = conflict.key;
          const details = document.createElement("p");
          details.className = "ryan-transfer-conflict-details";
          details.textContent = `This device: ${recordReviewSummary(conflict.local)}. Synchronized copy (revision ${conflict.remote.revision}): ${recordReviewSummary(conflict.remote.value)}. Both versions remain available until you choose.`;
          const actions = document.createElement("div");
          actions.className = "ryan-transfer-conflict-actions";
          let reviewSaved = false;
          const saveReview = () => {
            if (reviewSaved) return;
            downloadConflictReview(options, conflict);
            reviewSaved = true;
          };
          const review = document.createElement("button");
          review.type = "button";
          review.textContent = "Download both versions";
          review.addEventListener("click", () => {
            saveReview();
            review.textContent = "Both versions downloaded";
            review.disabled = true;
          });
          const local = document.createElement("button");
          local.type = "button";
          local.textContent = "Keep this device";
          local.addEventListener("click", () => {
            saveReview();
            void resolve(conflict, "local");
          });
          const remote = document.createElement("button");
          remote.type = "button";
          remote.textContent = "Use synchronized record";
          remote.addEventListener("click", () => {
            saveReview();
            void resolve(conflict, "remote");
          });
          actions.append(review, local, remote);
          row.append(label, details, actions);
          conflictsNode.append(row);
        }
      },
      enableSync() {
        syncSection.hidden = false;
        dialog.querySelector("[data-sync-button]").addEventListener("click", () => {
          void syncRecords(options, this, true);
        });
      },
    };
  }

  function install(options) {
    if (!isObject(options)
      || typeof options.appId !== "string"
      || typeof options.appName !== "string"
      || !Array.isArray(options.storageKeys)
      || !options.storageKeys.length
      || options.storageKeys.some((key) => typeof key !== "string" || !key || key.length > 240)
      || new Set(options.storageKeys).size !== options.storageKeys.length) {
      throw new Error("Temporary data transfer was not configured safely.");
    }
    const normalized = {
      appId: options.appId,
      appName: options.appName,
      storageKeys: options.storageKeys.slice(),
      validate: (records) => validateByApp(options.appId, records),
    };
    const mount = () => {
      if (document.querySelector(".ryan-transfer-open")) return;
      const ui = makeUi(normalized);
      if (syncSupported()) {
        ui.enableSync();
        if (readSyncState(normalized).enabled) {
          void syncRecords(normalized, ui, false);
          window.setInterval(() => { void syncRecords(normalized, ui, false); }, 15_000);
        }
      }
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
    else mount();
  }

  window.TemporaryDataTransfer = Object.freeze({ install, buildBundle, buildConflictReviewBundle, normalizeBundle, validateByApp });
})();
