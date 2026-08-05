const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { TextEncoder } = require("node:util");
const vm = require("node:vm");

class FakeStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function load(values) {
  const window = { localStorage: new FakeStorage(values) };
  const context = vm.createContext({ window, TextEncoder, console });
  vm.runInContext(readFileSync(new URL("../temporary-data-transfer.js", `file://${__filename}`), "utf8"), context);
  return { api: window.TemporaryDataTransfer, storage: window.localStorage };
}

const options = {
  appId: "student-shuffle",
  appName: "Student Shuffle",
  storageKeys: ["roster", "selected", "sound"],
  validate: () => true,
};

test("temporary transfer export round-trips JSON and text records", () => {
  const { api } = load({ roster: "Ava\nBea", selected: "builtin:boys-nga", sound: "on" });
  const bundle = api.buildBundle(options);
  const restored = api.normalizeBundle(JSON.parse(JSON.stringify(bundle)), options);
  assert.equal(restored.app_id, "student-shuffle");
  assert.deepEqual(
    Array.from(restored.records, (record) => [record.key, record.present, record.encoding, record.value]),
    [["roster", true, "text", "Ava\nBea"], ["selected", true, "text", "builtin:boys-nga"], ["sound", true, "text", "on"]],
  );
});

test("temporary transfer rejects the wrong app and unknown records before import", () => {
  const { api } = load({ roster: "Ava" });
  const wrongApp = api.buildBundle(options);
  wrongApp.app_id = "team-games";
  assert.throws(() => api.normalizeBundle(wrongApp, options), /supported settings and data transfer/);

  const unknownRecord = api.buildBundle(options);
  unknownRecord.records[0].key = "not-owned-by-this-app";
  assert.throws(() => api.normalizeBundle(unknownRecord, options), /unsupported record schema/);
});

test("temporary transfer accepts the established raw-backup shape", () => {
  const { api } = load();
  const legacy = {
    version: 1,
    kind: "student_shuffle_browser_local_raw_backup",
    app_id: "student-shuffle",
    exported_at: "2026-08-05T00:00:00.000Z",
    records: [
      { key: "roster", present: true, raw_value: "Ava\nBea" },
      { key: "selected", present: true, raw_value: "builtin:boys-nga" },
      { key: "sound", present: false, raw_value: null },
    ],
  };
  const restored = api.normalizeBundle(legacy, options);
  assert.equal(restored.source, "legacy-backup");
  assert.equal(restored.records[2].present, false);
});

test("sync conflict review bundle retains both competing versions", () => {
  const { api } = load();
  const bundle = api.buildConflictReviewBundle(options, {
    key: "roster",
    local: { present: true, encoding: "text", value: "Ava\nBea" },
    remote: {
      revision: 7,
      updatedAt: "2026-08-05T00:00:00.000Z",
      value: { present: true, encoding: "text", value: "Cory\nDrew" },
    },
  });
  assert.equal(bundle.kind, "ryan_app_sync_conflict_review");
  assert.deepEqual(JSON.parse(JSON.stringify(bundle.record.local)), { present: true, encoding: "text", value: "Ava\nBea" });
  assert.deepEqual(JSON.parse(JSON.stringify(bundle.record.synchronized)), {
    revision: 7,
    updated_at: "2026-08-05T00:00:00.000Z",
    value: { present: true, encoding: "text", value: "Cory\nDrew" },
  });
});

test("Student Shuffle schema validation rejects invalid selected-class settings", () => {
  const { api } = load();
  const records = [
    { key: "student-random-order-roster-v1", present: false, encoding: "text", value: null },
    { key: "student-random-order-classes-v1", present: false, encoding: "text", value: null },
    { key: "student-random-order-selected-class-v1", present: true, encoding: "text", value: "bad class" },
    { key: "student-random-order-hidden-students-v1", present: false, encoding: "text", value: null },
    { key: "student-random-order-sound-v1", present: false, encoding: "text", value: null },
  ];
  assert.match(api.validateByApp("student-shuffle", records), /selected Student Shuffle class/);
});
