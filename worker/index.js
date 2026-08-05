/* Owner-only, same-origin record sync for the temporary migration period. */
const APP_ID = "team-invites";
const COLLECTION = "browser-storage";
const MAX_BODY_BYTES = 1_200_000;
const MAX_VALUE_BYTES = 900 * 1024;
const MAX_DEPTH = 48;
let schemaReady = null;

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected) => isObject(value)
  && Object.keys(value).length === expected.length
  && Object.keys(value).every((key) => expected.includes(key));
const byteLength = (value) => new TextEncoder().encode(value).byteLength;

function safeJson(value, depth = 0) {
  if (depth > MAX_DEPTH || value === null) return depth <= MAX_DEPTH;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 20_000 && value.every((entry) => safeJson(entry, depth + 1));
  if (!isObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 20_000 && entries.every(([key, entry]) => (
    key.length <= 240
    && key !== "__proto__"
    && key !== "constructor"
    && key !== "prototype"
    && safeJson(entry, depth + 1)
  ));
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  return Boolean(origin) && origin === new URL(request.url).origin;
}

function ownerId(request) {
  const value = request.headers.get("oai-authenticated-user-id")
    || request.headers.get("oai-authenticated-user-email");
  return typeof value === "string" && value.length > 0 && value.length <= 320 ? value : null;
}

async function ensureSchema(database) {
  if (!schemaReady) {
    schemaReady = database.batch([
      database.prepare(`CREATE TABLE IF NOT EXISTS app_sync_records (
        owner_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        collection_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, app_id, collection_name, record_id)
      )`),
      database.prepare("CREATE INDEX IF NOT EXISTS app_sync_records_updated_at_idx ON app_sync_records (owner_id, app_id, updated_at)"),
    ]).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function validRecordId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/.test(value);
}

function parseStoredRow(row) {
  try {
    const value = JSON.parse(row.payload_json);
    if (!safeJson(value)) return null;
    return {
      recordId: row.record_id,
      revision: row.revision,
      value,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

function validateSyncValue(value) {
  if (!exactKeys(value, ["present", "encoding", "value"])
    || typeof value.present !== "boolean"
    || !["json", "text"].includes(value.encoding)) return null;
  if (!value.present) return value.encoding === "text" && value.value === null ? value : null;
  if (value.encoding === "text") {
    return typeof value.value === "string" && byteLength(value.value) <= MAX_VALUE_BYTES ? value : null;
  }
  if (!safeJson(value.value)) return null;
  const serialized = JSON.stringify(value.value);
  return byteLength(serialized) <= MAX_VALUE_BYTES ? value : null;
}

async function readBody(request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("application/json")) return { error: "Use JSON for private sync.", status: 415 };
  const body = await request.text();
  if (!body || byteLength(body) > MAX_BODY_BYTES) return { error: "This synchronized record is too large.", status: 413 };
  try {
    return { value: JSON.parse(body) };
  } catch {
    return { error: "The sync request is not valid JSON.", status: 400 };
  }
}

async function currentRecord(database, owner, recordId) {
  const result = await database.prepare(`SELECT record_id, revision, payload_json, updated_at
    FROM app_sync_records
    WHERE owner_id = ? AND app_id = ? AND collection_name = ? AND record_id = ?`)
    .bind(owner, APP_ID, COLLECTION, recordId)
    .first();
  return result ? parseStoredRow(result) : null;
}

async function handleGet(request, database, owner) {
  const url = new URL(request.url);
  if (url.searchParams.get("appId") !== APP_ID) return json({ error: "This sync request targets the wrong app." }, 400);
  const result = await database.prepare(`SELECT record_id, revision, payload_json, updated_at
    FROM app_sync_records
    WHERE owner_id = ? AND app_id = ? AND collection_name = ?
    ORDER BY record_id COLLATE NOCASE`)
    .bind(owner, APP_ID, COLLECTION)
    .all();
  const records = result.results.map(parseStoredRow);
  if (records.some((record) => record === null)) return json({ error: "A stored sync record needs review." }, 500);
  return json({ version: 1, appId: APP_ID, collection: COLLECTION, records });
}

async function handlePut(request, database, owner) {
  if (!sameOrigin(request)) return json({ error: "Private sync writes must come from this site." }, 403);
  const body = await readBody(request);
  if ("error" in body) return json({ error: body.error }, body.status);
  const value = body.value;
  if (!exactKeys(value, ["version", "appId", "collection", "recordId", "expectedRevision", "value"])
    || value.version !== 1
    || value.appId !== APP_ID
    || value.collection !== COLLECTION
    || !validRecordId(value.recordId)
    || !(value.expectedRevision === null || (Number.isSafeInteger(value.expectedRevision) && value.expectedRevision > 0))) {
    return json({ error: "This private sync record has an unsupported schema." }, 400);
  }
  const syncValue = validateSyncValue(value.value);
  if (!syncValue) return json({ error: "This private sync value has an unsupported schema." }, 400);
  const payload = JSON.stringify(syncValue);
  const timestamp = new Date().toISOString();
  let result;
  if (value.expectedRevision === null) {
    result = await database.prepare(`INSERT INTO app_sync_records
      (owner_id, app_id, collection_name, record_id, revision, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(owner_id, app_id, collection_name, record_id) DO NOTHING`)
      .bind(owner, APP_ID, COLLECTION, value.recordId, payload, timestamp, timestamp).run();
  } else {
    result = await database.prepare(`UPDATE app_sync_records
      SET revision = revision + 1, payload_json = ?, updated_at = ?
      WHERE owner_id = ? AND app_id = ? AND collection_name = ? AND record_id = ? AND revision = ?`)
      .bind(payload, timestamp, owner, APP_ID, COLLECTION, value.recordId, value.expectedRevision).run();
  }
  if (!result.meta.changes) {
    const current = await currentRecord(database, owner, value.recordId);
    return json({ error: "A newer synchronized copy needs review.", current }, 409);
  }
  const record = await currentRecord(database, owner, value.recordId);
  if (!record) return json({ error: "The synchronized record could not be verified." }, 503);
  return json({ record });
}

async function api(request, env) {
  if (!env.DB) return json({ error: "Private sync storage is unavailable." }, 503);
  const owner = ownerId(request);
  if (!owner) return json({ error: "Sign in with the owner ChatGPT account to use private sync." }, 401);
  try {
    await ensureSchema(env.DB);
    if (request.method === "GET") return await handleGet(request, env.DB, owner);
    if (request.method === "PUT") return await handlePut(request, env.DB, owner);
    return json({ error: "Use GET or PUT for private sync." }, 405);
  } catch {
    return json({ error: "Private sync is temporarily unavailable. Local data is preserved." }, 503);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/app-sync") return api(request, env);
    return env.ASSETS.fetch(request);
  },
};
