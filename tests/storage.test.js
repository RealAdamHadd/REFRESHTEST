"use strict";

/**
 * Session storage tests use an in-memory localStorage-compatible fake. They
 * cover schema validation, persistence, quota/index failures, corruption
 * recovery, deletion, and import/export. They do not exercise a real browser.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Stats = require("../stats.js");
const Storage = require("../storage.js");

function repeat(value, count) {
  return Array.from({ length: count }, () => value);
}

class MemoryStorage {
  constructor() {
    this.map = new Map();
    this.failOnKey = null;
    this.failReads = false;
  }

  get length() {
    return this.map.size;
  }

  key(index) {
    return Array.from(this.map.keys())[index] ?? null;
  }

  getItem(key) {
    if (this.failReads) throw new Error("storage blocked");
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    if (this.failOnKey && key.startsWith(this.failOnKey)) throw new Error("quota exceeded");
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }
}

function makeRecord(options = {}) {
  const values = options.values || repeat(16.67, 60);
  const summary = options.summary || Stats.computeStatistics(values);
  const result = Storage.buildSessionRecord({
    id: options.id || "rt-test-session",
    savedAt: options.savedAt || "2026-10-21T10:00:00.000Z",
    startedAt: options.startedAt || "2026-10-21T09:59:52.000Z",
    mode: options.mode || "standard",
    modeLabel: options.modeLabel || "Standard",
    durationMs: options.durationMs === undefined ? 8000 : options.durationMs,
    sampleWindowMs: options.sampleWindowMs || 8000,
    summary,
    observations: values,
    hiddenPauses: options.hiddenPauses || { count: 0, durationMs: 0 },
    diagnostics: options.diagnostics || { invalidCount: summary.invalidCount, droppedObservations: 0 },
    environment: options.environment || {
      browser: "Google Chrome",
      os: "Windows",
      devicePixelRatio: 1.5,
      screen: "should not be stored"
    },
    ...options.extra
  });
  assert.equal(result.ok, true, result.errors ? JSON.stringify(result.errors) : "build failed");
  return result.record;
}

test("a built session stores the schema, raw observations, settings, and coarse environment", () => {
  const record = makeRecord();

  assert.equal(record.schemaVersion, 1);
  assert.equal(record.kind, "refreshtest-session");
  assert.equal(record.id, "rt-test-session");
  assert.equal(record.mode, "standard");
  assert.equal(record.durationMs, 8000);
  assert.equal(record.observations.length, 60);
  assert.equal(record.summary.acceptedCount, 60);
  assert.equal(record.summary.statisticsVersion, Stats.STATISTICS_VERSION);
  assert.equal(record.settings.statsVersion, Stats.STATISTICS_VERSION);
  assert.deepEqual(record.environment, {
    browser: "Google Chrome",
    os: "Windows",
    devicePixelRatio: 1.5
  });
  assert.equal(Object.prototype.hasOwnProperty.call(record.summary, "acceptedIntervals"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record.summary, "screen"), false);
});

test("buildSessionRecord rejects invalid observations and missing summaries", () => {
  const invalidObservation = Storage.buildSessionRecord({
    summary: Stats.computeStatistics([16.67]),
    observations: [16.67, NaN],
    mode: "standard",
    durationMs: 1000,
    sampleWindowMs: 8000
  });
  assert.equal(invalidObservation.ok, false);
  assert.equal(invalidObservation.code, "INVALID_BUILD");

  const missingSummary = Storage.buildSessionRecord({
    observations: [16.67],
    mode: "standard",
    durationMs: 1000,
    sampleWindowMs: 8000
  });
  assert.equal(missingSummary.ok, false);
});

test("serialize and deserialize round-trip a valid record", () => {
  const record = makeRecord();
  const serialized = Storage.serializeRecord(record);
  assert.equal(serialized.ok, true);
  const restored = Storage.deserializeRecord(serialized.json);
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.record, record);
});

test("schema migration rejects missing, older, and future versions explicitly", () => {
  const record = makeRecord();

  const missing = { ...record };
  delete missing.schemaVersion;
  assert.equal(Storage.migrateRecord(missing).code, "UNSUPPORTED_SCHEMA");

  assert.equal(Storage.migrateRecord({ ...record, schemaVersion: 0 }).code, "UNSUPPORTED_SCHEMA");
  assert.equal(Storage.migrateRecord({ ...record, schemaVersion: 2 }).code, "UNSUPPORTED_SCHEMA");
  assert.equal(Storage.migrateRecord(record).ok, true);
});

test("malformed and invalid records are rejected without throwing", () => {
  assert.equal(Storage.deserializeRecord("{not json").code, "MALFORMED_JSON");
  assert.equal(Storage.deserializeRecord(JSON.stringify({ hello: "world" })).code, "UNSUPPORTED_SCHEMA");
  assert.equal(Storage.deserializeRecord("[]").code, "INVALID_RECORD");

  const record = makeRecord();
  assert.equal(
    Storage.normalizeRecord({ ...record, kind: "other" }).code,
    "INVALID_RECORD"
  );
  assert.equal(
    Storage.normalizeRecord({ ...record, durationMs: -1 }).code,
    "INVALID_RECORD"
  );
  assert.equal(
    Storage.normalizeRecord({ ...record, observations: [1, "x"] }).code,
    "INVALID_RECORD"
  );
  assert.equal(
    Storage.normalizeRecord({ ...record, settings: { ...record.settings, sampleWindowMs: "long" } }).code,
    "INVALID_RECORD"
  );
});

test("storage availability is detected without throwing", () => {
  const storage = new MemoryStorage();
  assert.equal(Storage.isStorageAvailable(storage), true);

  const broken = new MemoryStorage();
  broken.failReads = true;
  assert.equal(Storage.isStorageAvailable(broken), false);

  assert.equal(Storage.isStorageAvailable(null), false);
  assert.equal(Storage.loadSessions(broken).available, false);
  assert.equal(Storage.saveSession(broken, makeRecord()).code, "STORAGE_UNAVAILABLE");
});

test("save and load round-trip sessions in newest-first order", () => {
  const storage = new MemoryStorage();
  const older = makeRecord({ id: "rt-older", savedAt: "2026-10-20T10:00:00.000Z" });
  const newer = makeRecord({ id: "rt-newer", savedAt: "2026-10-21T10:00:00.000Z" });

  assert.equal(Storage.saveSession(storage, older).ok, true);
  assert.equal(Storage.saveSession(storage, newer).ok, true);

  const loaded = Storage.loadSessions(storage);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.sessions.map((record) => record.id), ["rt-newer", "rt-older"]);
  assert.equal(loaded.errors.length, 0);
});

test("duplicate ids are rejected instead of overwriting saved data", () => {
  const storage = new MemoryStorage();
  const record = makeRecord();
  assert.equal(Storage.saveSession(storage, record).ok, true);
  assert.equal(Storage.saveSession(storage, record).code, "DUPLICATE_ID");
  assert.equal(Storage.loadSessions(storage).sessions.length, 1);
});

test("a storage write failure leaves the previous history intact", () => {
  const storage = new MemoryStorage();
  const first = makeRecord({ id: "rt-first" });
  assert.equal(Storage.saveSession(storage, first).ok, true);

  storage.failOnKey = Storage.SESSION_KEY_PREFIX;
  const second = makeRecord({ id: "rt-second" });
  const failed = Storage.saveSession(storage, second);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "STORAGE_WRITE_FAILED");

  storage.failOnKey = null;
  const loaded = Storage.loadSessions(storage);
  assert.deepEqual(loaded.sessions.map((record) => record.id), ["rt-first"]);
});

test("an index write failure rolls back the newly written session", () => {
  const storage = new MemoryStorage();
  const first = makeRecord({ id: "rt-first" });
  assert.equal(Storage.saveSession(storage, first).ok, true);

  storage.failOnKey = Storage.INDEX_KEY;
  const second = makeRecord({ id: "rt-second" });
  const failed = Storage.saveSession(storage, second);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "INDEX_WRITE_FAILED");
  assert.equal(storage.getItem(Storage.makeSessionKey("rt-second")), null);

  storage.failOnKey = null;
  const loaded = Storage.loadSessions(storage);
  assert.deepEqual(loaded.sessions.map((record) => record.id), ["rt-first"]);
});

test("a corrupted record is skipped and reported without deleting good records", () => {
  const storage = new MemoryStorage();
  const first = makeRecord({ id: "rt-first" });
  const second = makeRecord({ id: "rt-second" });
  assert.equal(Storage.saveSession(storage, first).ok, true);
  assert.equal(Storage.saveSession(storage, second).ok, true);
  storage.setItem(Storage.makeSessionKey("rt-first"), "{corrupt");

  const loaded = Storage.loadSessions(storage);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.sessions.map((record) => record.id), ["rt-second"]);
  assert.equal(loaded.errors.length, 1);
  assert.equal(loaded.errors[0].code, "CORRUPT_RECORD");
  assert.equal(storage.getItem(Storage.makeSessionKey("rt-first")), null);
  assert.equal(storage.getItem(`${Storage.CORRUPT_KEY_PREFIX}rt-first`), "{corrupt");
  assert.deepEqual(loaded.quarantinedIds, ["rt-first"]);
});

test("corrupt records do not permanently consume the history limit", () => {
  const storage = new MemoryStorage();
  for (let index = 0; index < Storage.MAX_SESSIONS; index++) {
    const record = makeRecord({
      id: `rt-limit-${index}`,
      values: [16.67],
      savedAt: `2026-10-21T10:00:${String(index).padStart(2, "0")}.000Z`
    });
    assert.equal(Storage.saveSession(storage, record).ok, true);
  }
  storage.setItem(Storage.makeSessionKey("rt-limit-0"), "{corrupt");

  const recovered = Storage.loadSessions(storage);
  assert.equal(recovered.sessions.length, Storage.MAX_SESSIONS - 1);
  assert.deepEqual(recovered.quarantinedIds, ["rt-limit-0"]);

  const extra = makeRecord({ id: "rt-limit-extra", values: [16.67] });
  assert.equal(Storage.saveSession(storage, extra).ok, true);
  assert.equal(Storage.loadSessions(storage).sessions.length, Storage.MAX_SESSIONS);
});

test("a missing index is recovered by scanning session keys", () => {
  const storage = new MemoryStorage();
  const first = makeRecord({ id: "rt-first" });
  const second = makeRecord({ id: "rt-second" });
  assert.equal(Storage.saveSession(storage, first).ok, true);
  assert.equal(Storage.saveSession(storage, second).ok, true);
  storage.removeItem(Storage.INDEX_KEY);

  const loaded = Storage.loadSessions(storage);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.indexRecovered, true);
  assert.deepEqual(loaded.sessions.map((record) => record.id).sort(), ["rt-first", "rt-second"]);
});

test("individual delete and clear-all remove only RefreshTest history", () => {
  const storage = new MemoryStorage();
  const first = makeRecord({ id: "rt-first" });
  const second = makeRecord({ id: "rt-second" });
  assert.equal(Storage.saveSession(storage, first).ok, true);
  assert.equal(Storage.saveSession(storage, second).ok, true);
  storage.setItem("unrelated.key", "keep me");

  assert.equal(Storage.deleteSession(storage, "rt-first").ok, true);
  assert.deepEqual(Storage.loadSessions(storage).sessions.map((record) => record.id), ["rt-second"]);
  assert.equal(Storage.deleteSession(storage, "rt-first").code, "NOT_FOUND");

  const cleared = Storage.clearAllSessions(storage);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.removed, 1);
  assert.equal(storage.getItem("unrelated.key"), "keep me");
  assert.equal(Storage.loadSessions(storage).sessions.length, 0);
});

test("history refuses to grow beyond its documented limit instead of truncating", () => {
  const storage = new MemoryStorage();
  for (let index = 0; index < Storage.MAX_SESSIONS; index++) {
    const record = makeRecord({
      id: `rt-limit-${index}`,
      values: [16.67],
      savedAt: `2026-10-21T10:00:${String(index).padStart(2, "0")}.000Z`
    });
    assert.equal(Storage.saveSession(storage, record).ok, true);
  }

  const extra = makeRecord({ id: "rt-limit-extra", values: [16.67] });
  assert.equal(Storage.saveSession(storage, extra).code, "LIMIT_REACHED");
  assert.equal(Storage.loadSessions(storage).sessions.length, Storage.MAX_SESSIONS);
});

test("export and import preserve sessions and include a cadence disclaimer", () => {
  const first = makeRecord({ id: "rt-first" });
  const second = makeRecord({ id: "rt-second", savedAt: "2026-10-21T11:00:00.000Z" });
  const exported = Storage.exportSessions([first, second]);
  assert.equal(exported.ok, true);
  assert.match(exported.json, /refreshtest-session-export/);
  assert.match(exported.json, /browser animation-callback cadence/);
  assert.match(exported.json, /not direct measurements of the physical display panel/);

  const parsed = Storage.parseImport(exported.json);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessions.length, 2);
  assert.equal(parsed.skipped, 0);
  assert.deepEqual(parsed.sessions.map((record) => record.id), ["rt-first", "rt-second"]);
  assert.ok(exported.bytes <= Storage.MAX_EXPORT_BYTES);
  assert.equal(Storage.MAX_IMPORT_BYTES, Storage.MAX_EXPORT_BYTES);

  // The app must be able to read its own output, including a UTF-8 BOM that
  // some editors add when a downloaded file is re-saved.
  const withBom = Storage.parseImport(`\uFEFF${exported.json}`);
  assert.equal(withBom.ok, true);
  assert.deepEqual(withBom.sessions.map((record) => record.id), ["rt-first", "rt-second"]);
});

test("export and import enforce the same explicit size limit", () => {
  const record = makeRecord();
  const sized = Storage.exportSessions([record], { maxBytes: 128 });
  assert.equal(sized.ok, false);
  assert.equal(sized.code, "EXPORT_TOO_LARGE");
  assert.match(sized.message, /above the/);
  assert.match(sized.message, /limit/);
  assert.ok(sized.bytes > sized.maxBytes);

  const importTooLarge = Storage.parseImport(Storage.exportSessions([record]).json, { maxBytes: 128 });
  assert.equal(importTooLarge.ok, false);
  assert.equal(importTooLarge.code, "INPUT_TOO_LARGE");
  assert.match(importTooLarge.message, /Imports are limited to/);
});

test("timestamps are stored canonically and session identity survives export/import", () => {
  const record = makeRecord({ savedAt: "2026-10-21T12:00:00+02:00" });
  assert.equal(record.savedAt, "2026-10-21T10:00:00.000Z");

  const exported = Storage.exportSessions([record]);
  assert.equal(exported.ok, true);
  const parsed = Storage.parseImport(exported.json);
  assert.equal(parsed.sessions[0].id, record.id);
  assert.equal(parsed.sessions[0].savedAt, record.savedAt);

  const merged = Storage.mergeImported([record], parsed.sessions);
  assert.equal(merged.added.length, 0);
  assert.equal(merged.skipped[0].code, "DUPLICATE_ID");
});

test("out-of-range and malformed timestamps are rejected without throwing", () => {
  const record = makeRecord();
  const invalidValues = [1e20, -1e20, "not-a-date", "2026-13-40T99:99:99Z", {}];

  for (const savedAt of invalidValues) {
    let normalized;
    assert.doesNotThrow(() => {
      normalized = Storage.normalizeRecord({ ...record, savedAt });
    });
    assert.equal(normalized.ok, false, String(savedAt));
    assert.equal(normalized.code, "INVALID_RECORD");
  }

  let built;
  assert.doesNotThrow(() => {
    built = Storage.buildSessionRecord({
      summary: Stats.computeStatistics([16.67]),
      observations: [16.67],
      mode: "standard",
      durationMs: 1000,
      sampleWindowMs: 8000,
      savedAt: 1e20
    });
  });
  assert.equal(built.ok, false);
  assert.equal(built.code, "INVALID_BUILD");

  const numeric = Storage.normalizeRecord({ ...record, savedAt: 1700000000000 });
  assert.equal(numeric.ok, true);
  assert.equal(numeric.record.savedAt, new Date(1700000000000).toISOString());
});

test("missing statistics versions stay unknown instead of being promoted", () => {
  const record = makeRecord();
  const legacy = JSON.parse(JSON.stringify(record));
  delete legacy.summary.statisticsVersion;
  delete legacy.settings.statsVersion;

  const normalized = Storage.normalizeRecord(legacy);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.record.summary.statisticsVersion, null);
  assert.equal(normalized.record.settings.statsVersion, null);
  assert.deepEqual(Stats.resolveStatisticsVersion(
    normalized.record.summary.statisticsVersion,
    normalized.record.settings.statsVersion
  ), { version: null, conflict: false });

  const settingsOnly = JSON.parse(JSON.stringify(legacy));
  settingsOnly.settings.statsVersion = 2;
  assert.deepEqual(Stats.resolveStatisticsVersion(
    settingsOnly.summary.statisticsVersion,
    settingsOnly.settings.statsVersion
  ), { version: 2, conflict: false });

  const conflict = JSON.parse(JSON.stringify(record));
  conflict.settings.statsVersion = 1;
  assert.deepEqual(Stats.resolveStatisticsVersion(
    conflict.summary.statisticsVersion,
    conflict.settings.statsVersion
  ), { version: null, conflict: true });

  const future = JSON.parse(JSON.stringify(record));
  future.summary.statisticsVersion = 999;
  future.settings.statsVersion = 999;
  assert.equal(Storage.normalizeRecord(future).ok, true);
  assert.equal(Stats.checkStatisticsCompatibility(999, 999).status, "future");

  const malformed = JSON.parse(JSON.stringify(record));
  malformed.settings.statsVersion = "2";
  assert.equal(Storage.normalizeRecord(malformed).ok, false);
});

test("repeated corruption of the same id quarantines every payload", () => {
  const storage = new MemoryStorage();
  const record = makeRecord({ id: "rt-repeat" });
  assert.equal(Storage.saveSession(storage, record).ok, true);

  storage.setItem(Storage.makeSessionKey("rt-repeat"), "{first-corrupt");
  const first = Storage.loadSessions(storage);
  assert.deepEqual(first.quarantinedIds, ["rt-repeat"]);
  assert.equal(first.errors[0].quarantined, true);

  storage.setItem(Storage.makeSessionKey("rt-repeat"), "{second-corrupt");
  const second = Storage.loadSessions(storage);
  assert.deepEqual(second.quarantinedIds, ["rt-repeat"]);
  assert.equal(second.errors[0].quarantined, true);

  const keys = [...storage.map.keys()].filter((key) => key.startsWith(Storage.CORRUPT_KEY_PREFIX));
  const payloads = keys.map((key) => storage.getItem(key)).sort();
  assert.deepEqual(payloads, ["{first-corrupt", "{second-corrupt"]);
});

test("a failed quarantine keeps the corrupt record and reports retention", () => {
  const storage = new MemoryStorage();
  const record = makeRecord({ id: "rt-retained" });
  assert.equal(Storage.saveSession(storage, record).ok, true);
  storage.setItem(Storage.makeSessionKey("rt-retained"), "{corrupt");

  storage.failOnKey = Storage.CORRUPT_KEY_PREFIX;
  const loaded = Storage.loadSessions(storage);
  assert.equal(loaded.sessions.length, 0);
  assert.equal(loaded.errors.length, 1);
  assert.equal(loaded.errors[0].quarantined, false);
  assert.equal(loaded.errors[0].retained, true);
  assert.deepEqual(loaded.retainedCorruptIds, ["rt-retained"]);
  assert.equal(storage.getItem(Storage.makeSessionKey("rt-retained")), "{corrupt");
  assert.equal(storage.getItem(`${Storage.CORRUPT_KEY_PREFIX}rt-retained`), null);
});

test("a retained corrupt record does not consume a valid history slot", () => {
  const storage = new MemoryStorage();
  for (let index = 0; index < Storage.MAX_SESSIONS; index++) {
    const record = makeRecord({
      id: `rt-retain-${index}`,
      values: [16.67],
      savedAt: `2026-10-21T10:00:${String(index).padStart(2, "0")}.000Z`
    });
    assert.equal(Storage.saveSession(storage, record).ok, true);
  }
  storage.setItem(Storage.makeSessionKey("rt-retain-0"), "{corrupt");
  storage.failOnKey = Storage.CORRUPT_KEY_PREFIX;

  const loaded = Storage.loadSessions(storage);
  assert.equal(loaded.sessions.length, Storage.MAX_SESSIONS - 1);
  assert.deepEqual(loaded.retainedCorruptIds, ["rt-retain-0"]);

  const extra = makeRecord({ id: "rt-retain-extra", values: [16.67] });
  assert.equal(Storage.saveSession(storage, extra).ok, true);

  const after = Storage.loadSessions(storage);
  assert.equal(after.sessions.length, Storage.MAX_SESSIONS);
  assert.ok(after.retainedCorruptIds.includes("rt-retain-0"));
  storage.failOnKey = null;
});

test("quarantine size is bounded without deleting valid sessions", () => {
  const storage = new MemoryStorage();
  const limit = Storage.MAX_QUARANTINE_RECORDS;

  for (let index = 0; index < limit + 3; index++) {
    const id = `rt-quarantine-${index}`;
    storage.setItem(Storage.makeSessionKey(id), `{corrupt-${index}`);
    const loaded = Storage.loadSessions(storage);
    assert.deepEqual(loaded.quarantinedIds, [id]);
  }

  const keys = [...storage.map.keys()].filter((key) => key.startsWith(Storage.CORRUPT_KEY_PREFIX));
  assert.ok(keys.length <= limit, `${keys.length} quarantine records`);
  assert.ok(keys.some((key) => storage.getItem(key) === `{corrupt-${limit + 2}`));
});


test("single-record and array imports are accepted", () => {
  const record = makeRecord();
  const single = Storage.parseImport(JSON.stringify(record));
  assert.equal(single.ok, true);
  assert.equal(single.sessions.length, 1);

  const array = Storage.parseImport(JSON.stringify([record]));
  assert.equal(array.ok, true);
  assert.equal(array.sessions.length, 1);
});

test("malformed, oversized, unsupported, and too-large imports are rejected", () => {
  assert.equal(Storage.parseImport("{oops").code, "MALFORMED_JSON");
  assert.equal(Storage.parseImport("null").code, "UNSUPPORTED_FORMAT");
  assert.equal(Storage.parseImport(JSON.stringify({ format: "other", schemaVersion: 1, sessions: [] })).code, "UNSUPPORTED_FORMAT");
  assert.equal(Storage.parseImport(JSON.stringify({ format: Storage.EXPORT_FORMAT, schemaVersion: 2, sessions: [] })).code, "UNSUPPORTED_SCHEMA");
  assert.equal(Storage.parseImport(JSON.stringify({ format: Storage.EXPORT_FORMAT, schemaVersion: 1, sessions: [] })).code, "EMPTY");

  const record = makeRecord();
  const tooMany = Storage.parseImport(
    JSON.stringify({ format: Storage.EXPORT_FORMAT, schemaVersion: 1, sessions: [record, record] }),
    { maxSessions: 1 }
  );
  assert.equal(tooMany.code, "TOO_MANY_SESSIONS");

  const tooLarge = Storage.parseImport(JSON.stringify(record), { maxBytes: 10 });
  assert.equal(tooLarge.code, "INPUT_TOO_LARGE");
});

test("partially valid imports keep valid sessions and report skipped ones", () => {
  const record = makeRecord();
  const parsed = Storage.parseImport(JSON.stringify({
    format: Storage.EXPORT_FORMAT,
    schemaVersion: 1,
    sessions: [record, { schemaVersion: 1, kind: "bad" }]
  }));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.skipped, 1);
  assert.equal(parsed.errors[0].index, 1);
});

test("import merging skips duplicates and respects the history limit without overwriting", () => {
  const existing = [makeRecord({ id: "rt-existing" })];
  const duplicate = makeRecord({ id: "rt-existing", savedAt: "2020-01-01T00:00:00.000Z" });
  const fresh = makeRecord({ id: "rt-fresh" });

  const merged = Storage.mergeImported(existing, [duplicate, fresh]);
  assert.equal(merged.sessions.length, 2);
  assert.deepEqual(merged.added.map((record) => record.id), ["rt-fresh"]);
  assert.equal(merged.skipped[0].code, "DUPLICATE_ID");
  assert.equal(merged.sessions[0].savedAt, existing[0].savedAt);
});

test("export refuses invalid records and empty selections", () => {
  assert.equal(Storage.exportSessions([]).code, "EMPTY");
  const record = makeRecord();
  assert.equal(Storage.exportSessions([{ ...record, durationMs: -5 }]).ok, false);
});
