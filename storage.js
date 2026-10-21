/**
 * RefreshTest local session storage.
 *
 * Versioned, dependency-free localStorage persistence. Sessions are stored one
 * per key with a small index so one malformed record cannot destroy the rest.
 * All validation is explicit; nothing is silently truncated. No network access
 * is performed here.
 *
 * Schema v1 record:
 * {
 *   schemaVersion, kind, id, savedAt, startedAt, mode, modeLabel, durationMs,
 *   settings, summary, observations, hiddenPauses, diagnostics, environment
 * }
 *
 * The summary is a convenience snapshot. Consumers that need consistent
 * historical metrics should recompute from `observations` with the current
 * statistics module; comparison.js does exactly that.
 */
(function () {
  "use strict";

  const Stats = typeof window !== "undefined" && window.RefreshTestStats
    ? window.RefreshTestStats
    : typeof require === "function"
      ? require("./stats.js")
      : null;

  if (!Stats) {
    throw new Error("RefreshTestStorage requires stats.js to be loaded first.");
  }

  const SCHEMA_VERSION = 1;
  const KIND = "refreshtest-session";
  const EXPORT_FORMAT = "refreshtest-session-export";
  const INDEX_KEY = "refreshtest.index.v1";
  const SESSION_KEY_PREFIX = "refreshtest.session.v1.";
  const CORRUPT_KEY_PREFIX = "refreshtest.corrupt.v1.";
  const PROBE_KEY = "refreshtest.storage-probe";
  const MAX_SESSIONS = 50;
  const MAX_QUARANTINE_RECORDS = 10;
  // Export and import share one limit so every file the app produces can be
  // read back by the app. 32 MB comfortably covers 50 sessions at the maximum
  // retained observation count while keeping an explicit upper bound.
  const MAX_TRANSFER_BYTES = 32 * 1024 * 1024;
  const MAX_IMPORT_BYTES = MAX_TRANSFER_BYTES;
  const MAX_EXPORT_BYTES = MAX_TRANSFER_BYTES;
  const MAX_IMPORT_SESSIONS = 50;
  const MAX_OBSERVATIONS = 24000;
  const MAX_OBSERVATION_MS = 10 * 60 * 1000;
  const MAX_RECORD_DURATION_MS = 24 * 60 * 60 * 1000;
  const MAX_ID_LENGTH = 100;

  const EXPORT_DISCLAIMER = "RefreshTest measurements describe browser animation-callback cadence. They are not direct measurements of the physical display panel's refresh rate, pixel response time, GPU presentation, or VRR behavior.";

  let quarantineSequence = 0;

  const SUMMARY_NUMERIC_FIELDS = Object.freeze([
    "meanIntervalMs",
    "medianIntervalMs",
    "minIntervalMs",
    "maxIntervalMs",
    "standardDeviationMs",
    "coefficientOfVariation",
    "p50IntervalMs",
    "p95IntervalMs",
    "p99IntervalMs",
    "stabilityPercent",
    "usableCoveragePercent",
    "averageFps",
    "medianFps",
    "minimumFps",
    "maximumFps",
    "lastIntervalFps"
  ]);

  const SUMMARY_DURATION_FIELDS = Object.freeze([
    "acceptedDurationMs",
    "excludedGapDurationMs",
    "longestExcludedGapMs"
  ]);

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function isInteger(value) {
    return isFiniteNumber(value) && Number.isInteger(value);
  }

  function clampInteger(value, fallback, minimum, maximum) {
    if (!isFiniteNumber(value)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.floor(value)));
  }

  function addError(errors, field, message) {
    errors.push({ field, message });
  }

  function isValidId(id) {
    return typeof id === "string"
      && id.length > 0
      && id.length <= MAX_ID_LENGTH
      && /^[A-Za-z0-9._-]+$/.test(id);
  }

  function createSessionId() {
    try {
      if (typeof globalThis !== "undefined" && globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        return `rt-${globalThis.crypto.randomUUID()}`;
      }
    } catch (_) {
      // Fall through to the timestamp/random identifier.
    }
    const random = Math.random().toString(36).slice(2, 10);
    return `rt-${Date.now().toString(36)}-${random}`;
  }

  function makeSessionKey(id) {
    return `${SESSION_KEY_PREFIX}${id}`;
  }

  function parseTimestamp(value) {
    if (typeof value !== "string" || !value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function toIsoTimestamp(value, field, errors, required) {
    if (value === undefined || value === null || value === "") {
      if (required) addError(errors, field, `${field} is required.`);
      return null;
    }
    const parsed = typeof value === "number" && Number.isFinite(value)
      ? value
      : parseTimestamp(value);
    if (!Number.isFinite(parsed)) {
      addError(errors, field, `${field} must be an ISO timestamp or finite millisecond value.`);
      return null;
    }
    const date = new Date(parsed);
    if (!Number.isFinite(date.getTime())) {
      addError(errors, field, `${field} is outside the supported date range.`);
      return null;
    }
    return date.toISOString();
  }

  function normalizeObservations(values, errors) {
    if (!Array.isArray(values)) {
      addError(errors, "observations", "observations must be an array.");
      return [];
    }
    if (values.length > MAX_OBSERVATIONS) {
      addError(errors, "observations", `observations must contain at most ${MAX_OBSERVATIONS} values.`);
      return [];
    }
    const normalized = [];
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (!isFiniteNumber(value) || Math.abs(value) > MAX_OBSERVATION_MS) {
        addError(errors, "observations", `observations[${index}] is not a bounded finite number.`);
        return [];
      }
      normalized.push(value);
    }
    return normalized;
  }

  function normalizePauses(value, errors) {
    if (value === undefined || value === null) return { count: 0, durationMs: 0 };
    if (!isPlainObject(value)) {
      addError(errors, "hiddenPauses", "hiddenPauses must be an object.");
      return { count: 0, durationMs: 0 };
    }
    const count = value.count === undefined ? 0 : value.count;
    const durationMs = value.durationMs === undefined ? 0 : value.durationMs;
    if (!isInteger(count) || count < 0 || count > 1e6) {
      addError(errors, "hiddenPauses.count", "hiddenPauses.count must be a non-negative integer.");
    }
    if (!isFiniteNumber(durationMs) || durationMs < 0 || durationMs > MAX_RECORD_DURATION_MS) {
      addError(errors, "hiddenPauses.durationMs", "hiddenPauses.durationMs must be a bounded non-negative number.");
    }
    return {
      count: isInteger(count) && count >= 0 ? count : 0,
      durationMs: isFiniteNumber(durationMs) && durationMs >= 0 ? durationMs : 0
    };
  }

  function normalizeSettings(value, errors) {
    if (!isPlainObject(value)) {
      addError(errors, "settings", "settings must be an object.");
      return null;
    }
    const hasStatsVersion = value.statsVersion !== undefined && value.statsVersion !== null;
    const statsVersion = hasStatsVersion ? Stats.normalizeStatisticsVersion(value.statsVersion) : null;
    const sampleWindowMs = value.sampleWindowMs;
    const maxAcceptedIntervalMs = value.maxAcceptedIntervalMs === undefined
      ? Stats.MAX_ACCEPTED_INTERVAL_MS
      : value.maxAcceptedIntervalMs;
    const minAcceptedSamples = value.minAcceptedSamples === undefined
      ? Stats.MIN_ACCEPTED_SAMPLES
      : value.minAcceptedSamples;
    const stabilityToleranceRatio = value.stabilityToleranceRatio === undefined
      ? Stats.STABILITY_TOLERANCE_RATIO
      : value.stabilityToleranceRatio;

    if (hasStatsVersion && statsVersion === null) {
      addError(errors, "settings.statsVersion", "settings.statsVersion must be a positive integer when present.");
    }
    if (!isFiniteNumber(sampleWindowMs) || sampleWindowMs <= 0 || sampleWindowMs > MAX_RECORD_DURATION_MS) {
      addError(errors, "settings.sampleWindowMs", "settings.sampleWindowMs must be a bounded positive number.");
    }
    if (!isFiniteNumber(maxAcceptedIntervalMs) || maxAcceptedIntervalMs <= 0 || maxAcceptedIntervalMs > MAX_OBSERVATION_MS) {
      addError(errors, "settings.maxAcceptedIntervalMs", "settings.maxAcceptedIntervalMs must be a bounded positive number.");
    }
    if (!isInteger(minAcceptedSamples) || minAcceptedSamples < 1 || minAcceptedSamples > 100000) {
      addError(errors, "settings.minAcceptedSamples", "settings.minAcceptedSamples must be a positive integer.");
    }
    if (!isFiniteNumber(stabilityToleranceRatio) || stabilityToleranceRatio <= 0 || stabilityToleranceRatio > 1) {
      addError(errors, "settings.stabilityToleranceRatio", "settings.stabilityToleranceRatio must be within (0, 1].");
    }

    return {
      statsVersion,
      sampleWindowMs: isFiniteNumber(sampleWindowMs) ? sampleWindowMs : 8000,
      maxAcceptedIntervalMs: isFiniteNumber(maxAcceptedIntervalMs) ? maxAcceptedIntervalMs : Stats.MAX_ACCEPTED_INTERVAL_MS,
      minAcceptedSamples: isInteger(minAcceptedSamples) ? minAcceptedSamples : Stats.MIN_ACCEPTED_SAMPLES,
      stabilityToleranceRatio: isFiniteNumber(stabilityToleranceRatio) ? stabilityToleranceRatio : Stats.STABILITY_TOLERANCE_RATIO
    };
  }

  function normalizeSummary(value, errors) {
    if (!isPlainObject(value)) {
      addError(errors, "summary", "summary must be an object.");
      return null;
    }

    const acceptedCount = value.acceptedCount;
    const excludedGapCount = value.excludedGapCount === undefined ? 0 : value.excludedGapCount;
    const invalidCount = value.invalidCount === undefined ? 0 : value.invalidCount;
    if (!isInteger(acceptedCount) || acceptedCount < 0 || acceptedCount > MAX_OBSERVATIONS) {
      addError(errors, "summary.acceptedCount", "summary.acceptedCount must be a bounded non-negative integer.");
    }
    if (!isInteger(excludedGapCount) || excludedGapCount < 0 || excludedGapCount > MAX_OBSERVATIONS) {
      addError(errors, "summary.excludedGapCount", "summary.excludedGapCount must be a bounded non-negative integer.");
    }
    if (!isInteger(invalidCount) || invalidCount < 0 || invalidCount > MAX_OBSERVATIONS) {
      addError(errors, "summary.invalidCount", "summary.invalidCount must be a bounded non-negative integer.");
    }

    const summary = {
      acceptedCount: isInteger(acceptedCount) ? acceptedCount : 0,
      excludedGapCount: isInteger(excludedGapCount) ? excludedGapCount : 0,
      invalidCount: isInteger(invalidCount) ? invalidCount : 0
    };

    for (const field of SUMMARY_DURATION_FIELDS) {
      const raw = value[field] === undefined ? 0 : value[field];
      if (!isFiniteNumber(raw) || raw < 0 || raw > MAX_RECORD_DURATION_MS) {
        addError(errors, `summary.${field}`, `summary.${field} must be a bounded non-negative number.`);
      }
      summary[field] = isFiniteNumber(raw) && raw >= 0 ? raw : 0;
    }

    for (const field of SUMMARY_NUMERIC_FIELDS) {
      const raw = value[field] === undefined ? null : value[field];
      if (raw !== null && (!isFiniteNumber(raw) || Math.abs(raw) > Number.MAX_SAFE_INTEGER)) {
        addError(errors, `summary.${field}`, `summary.${field} must be null or a finite number.`);
      }
      summary[field] = raw === null || !isFiniteNumber(raw) ? null : raw;
    }

    summary.sufficientSample = value.sufficientSample === true;
    summary.stabilityClassification = typeof value.stabilityClassification === "string"
      ? value.stabilityClassification.slice(0, 30)
      : "INSUFFICIENT";
    summary.minimumAcceptedSamples = isInteger(value.minimumAcceptedSamples) && value.minimumAcceptedSamples > 0
      ? value.minimumAcceptedSamples
      : Stats.MIN_ACCEPTED_SAMPLES;
    summary.minimumP99Samples = isInteger(value.minimumP99Samples) && value.minimumP99Samples > 0
      ? value.minimumP99Samples
      : Stats.MIN_P99_SAMPLES;
    const hasStatisticsVersion = value.statisticsVersion !== undefined && value.statisticsVersion !== null;
    const statisticsVersion = hasStatisticsVersion
      ? Stats.normalizeStatisticsVersion(value.statisticsVersion)
      : null;
    if (hasStatisticsVersion && statisticsVersion === null) {
      addError(errors, "summary.statisticsVersion", "summary.statisticsVersion must be a positive integer when present.");
    }
    summary.statisticsVersion = statisticsVersion;

    return summary;
  }

  function normalizeDiagnostics(value, summary, observationCount, errors) {
    const source = isPlainObject(value) ? value : {};
    const invalidCount = source.invalidCount === undefined
      ? summary && isInteger(summary.invalidCount) ? summary.invalidCount : 0
      : source.invalidCount;
    const droppedObservations = source.droppedObservations === undefined ? 0 : source.droppedObservations;
    const observations = source.observationCount === undefined ? observationCount : source.observationCount;

    if (!isInteger(invalidCount) || invalidCount < 0) {
      addError(errors, "diagnostics.invalidCount", "diagnostics.invalidCount must be a non-negative integer.");
    }
    if (!isInteger(droppedObservations) || droppedObservations < 0) {
      addError(errors, "diagnostics.droppedObservations", "diagnostics.droppedObservations must be a non-negative integer.");
    }
    if (!isInteger(observations) || observations < 0 || observations > MAX_OBSERVATIONS) {
      addError(errors, "diagnostics.observationCount", "diagnostics.observationCount must be a bounded non-negative integer.");
    }

    return {
      invalidCount: isInteger(invalidCount) && invalidCount >= 0 ? invalidCount : 0,
      droppedObservations: isInteger(droppedObservations) && droppedObservations >= 0 ? droppedObservations : 0,
      observationCount: isInteger(observations) && observations >= 0 ? observations : observationCount
    };
  }

  function normalizeEnvironment(value, errors) {
    const source = isPlainObject(value) ? value : {};
    const browser = typeof source.browser === "string" ? source.browser.slice(0, 60) : null;
    const os = typeof source.os === "string" ? source.os.slice(0, 60) : null;
    let devicePixelRatio = source.devicePixelRatio === undefined ? null : source.devicePixelRatio;
    if (devicePixelRatio !== null && (!isFiniteNumber(devicePixelRatio) || devicePixelRatio <= 0 || devicePixelRatio > 16)) {
      addError(errors, "environment.devicePixelRatio", "environment.devicePixelRatio must be a bounded positive number.");
      devicePixelRatio = null;
    }
    return { browser, os, devicePixelRatio };
  }

  function snapshotSummary(summary) {
    if (!isPlainObject(summary)) return null;
    const snapshot = {
      acceptedCount: clampInteger(summary.acceptedCount, 0, 0, MAX_OBSERVATIONS),
      excludedGapCount: clampInteger(summary.excludedGapCount, 0, 0, MAX_OBSERVATIONS),
      invalidCount: clampInteger(summary.invalidCount, 0, 0, MAX_OBSERVATIONS),
      sufficientSample: summary.sufficientSample === true,
      stabilityClassification: typeof summary.stabilityClassification === "string"
        ? summary.stabilityClassification.slice(0, 30)
        : "INSUFFICIENT",
      minimumAcceptedSamples: clampInteger(summary.minimumAcceptedSamples, Stats.MIN_ACCEPTED_SAMPLES, 1, 100000),
      minimumP99Samples: clampInteger(summary.minimumP99Samples, Stats.MIN_P99_SAMPLES, 1, 100000),
      statisticsVersion: Stats.normalizeStatisticsVersion(summary.statisticsVersion)
    };

    for (const field of SUMMARY_NUMERIC_FIELDS) {
      snapshot[field] = isFiniteNumber(summary[field]) ? summary[field] : null;
    }
    for (const field of SUMMARY_DURATION_FIELDS) {
      snapshot[field] = isFiniteNumber(summary[field]) && summary[field] >= 0 ? summary[field] : 0;
    }
    return snapshot;
  }

  function migrateRecord(raw) {
    if (!isPlainObject(raw)) {
      return { ok: false, code: "INVALID_RECORD", errors: [{ field: "record", message: "Record must be an object." }] };
    }
    const version = raw.schemaVersion;
    if (version === SCHEMA_VERSION) return { ok: true, record: raw };
    if (version === undefined || version === null) {
      return { ok: false, code: "UNSUPPORTED_SCHEMA", errors: [{ field: "schemaVersion", message: "Record has no schema version." }] };
    }
    if (version < SCHEMA_VERSION) {
      return {
        ok: false,
        code: "UNSUPPORTED_SCHEMA",
        errors: [{ field: "schemaVersion", message: `No migration is available from schema ${String(version)}.` }]
      };
    }
    return {
      ok: false,
      code: "UNSUPPORTED_SCHEMA",
      errors: [{ field: "schemaVersion", message: `Schema ${String(version)} is newer than this app supports.` }]
    };
  }

  function normalizeRecord(raw) {
    const migrated = migrateRecord(raw);
    if (!migrated.ok) return migrated;

    const source = migrated.record;
    const errors = [];

    if (source.kind !== KIND) addError(errors, "kind", `kind must be "${KIND}".`);
    if (!isValidId(source.id)) addError(errors, "id", "id must be a short identifier containing only letters, digits, dot, underscore, or hyphen.");

    const savedAt = toIsoTimestamp(source.savedAt, "savedAt", errors, true);
    const startedAt = toIsoTimestamp(source.startedAt, "startedAt", errors, false);

    const mode = typeof source.mode === "string" && source.mode.length > 0 && source.mode.length <= 40
      ? source.mode
      : null;
    if (!mode) addError(errors, "mode", "mode must be a short non-empty string.");

    const durationMs = source.durationMs;
    if (!isFiniteNumber(durationMs) || durationMs < 0 || durationMs > MAX_RECORD_DURATION_MS) {
      addError(errors, "durationMs", "durationMs must be a bounded non-negative number.");
    }

    const settings = normalizeSettings(source.settings, errors);
    const summary = normalizeSummary(source.summary, errors);
    const observations = normalizeObservations(source.observations, errors);
    const hiddenPauses = normalizePauses(source.hiddenPauses, errors);
    const diagnostics = normalizeDiagnostics(source.diagnostics, summary, observations.length, errors);
    const environment = normalizeEnvironment(source.environment, errors);
    const modeLabel = typeof source.modeLabel === "string" && source.modeLabel.length > 0
      ? source.modeLabel.slice(0, 60)
      : mode || "Standard";

    if (summary && isInteger(summary.acceptedCount) && summary.acceptedCount > observations.length) {
      addError(errors, "summary.acceptedCount", "summary.acceptedCount cannot exceed the number of stored observations.");
    }

    if (errors.length) {
      return { ok: false, code: "INVALID_RECORD", errors };
    }

    return {
      ok: true,
      record: {
        schemaVersion: SCHEMA_VERSION,
        kind: KIND,
        id: source.id,
        savedAt,
        startedAt,
        mode,
        modeLabel,
        durationMs,
        settings,
        summary,
        observations,
        hiddenPauses,
        diagnostics,
        environment
      }
    };
  }

  function buildSessionRecord(options) {
    const source = options && typeof options === "object" ? options : {};
    const errors = [];
    const observations = normalizeObservations(source.observations || [], errors);
    const summary = snapshotSummary(source.summary);
    if (!summary) addError(errors, "summary", "A statistics summary is required.");
    // buildSessionRecord is only used for a freshly computed result. If the
    // caller omitted the version, stamp the definitions this build used. Loaded
    // and imported records are never stamped this way.
    if (summary && summary.statisticsVersion === null) {
      summary.statisticsVersion = Stats.STATISTICS_VERSION;
    }

    const id = source.id || createSessionId();
    if (!isValidId(id)) addError(errors, "id", "A valid session id could not be created.");

    const savedAt = toIsoTimestamp(source.savedAt === undefined ? Date.now() : source.savedAt, "savedAt", errors, true);
    const startedAt = toIsoTimestamp(source.startedAt, "startedAt", errors, false);
    const mode = typeof source.mode === "string" && source.mode ? source.mode : "standard";
    const modeLabel = typeof source.modeLabel === "string" && source.modeLabel ? source.modeLabel : mode;
    const durationMs = source.durationMs;
    if (!isFiniteNumber(durationMs) || durationMs < 0 || durationMs > MAX_RECORD_DURATION_MS) {
      addError(errors, "durationMs", "durationMs must be a bounded non-negative number.");
    }

    const settings = normalizeSettings({
      statsVersion: Stats.STATISTICS_VERSION,
      sampleWindowMs: isFiniteNumber(source.sampleWindowMs) ? source.sampleWindowMs : 8000,
      maxAcceptedIntervalMs: Stats.MAX_ACCEPTED_INTERVAL_MS,
      minAcceptedSamples: Stats.MIN_ACCEPTED_SAMPLES,
      stabilityToleranceRatio: Stats.STABILITY_TOLERANCE_RATIO
    }, errors);
    const hiddenPauses = normalizePauses(source.hiddenPauses, errors);
    const diagnostics = normalizeDiagnostics(source.diagnostics, summary, observations.length, errors);
    const environment = normalizeEnvironment(source.environment, errors);

    if (errors.length) {
      return { ok: false, code: "INVALID_BUILD", errors };
    }

    const candidate = {
      schemaVersion: SCHEMA_VERSION,
      kind: KIND,
      id,
      savedAt,
      startedAt,
      mode,
      modeLabel,
      durationMs,
      settings,
      summary,
      observations,
      hiddenPauses,
      diagnostics,
      environment
    };

    return normalizeRecord(candidate);
  }

  function serializeRecord(record) {
    const normalized = normalizeRecord(record);
    if (!normalized.ok) return { ok: false, code: "INVALID_RECORD", errors: normalized.errors };
    try {
      return { ok: true, json: JSON.stringify(normalized.record) };
    } catch (_) {
      return { ok: false, code: "SERIALIZE_FAILED", errors: [{ field: "record", message: "Record could not be serialized." }] };
    }
  }

  function deserializeRecord(text) {
    if (typeof text !== "string") {
      return { ok: false, code: "INVALID_INPUT", errors: [{ field: "json", message: "Expected a JSON string." }] };
    }
    const source = stripBom(text);
    const bytes = byteLength(source);
    if (bytes > MAX_IMPORT_BYTES) {
      return {
        ok: false,
        code: "INPUT_TOO_LARGE",
        errors: [{
          field: "json",
          message: `Record is ${formatBytes(bytes)}; the limit is ${formatBytes(MAX_IMPORT_BYTES)}.`
        }]
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (_) {
      return { ok: false, code: "MALFORMED_JSON", errors: [{ field: "json", message: "Input is not valid JSON." }] };
    }
    return normalizeRecord(parsed);
  }

  function byteLength(text) {
    try {
      if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
    } catch (_) {
      // Fall through to the string-length estimate.
    }
    return text.length * 2;
  }

  function formatBytes(bytes) {
    if (!isFiniteNumber(bytes) || bytes < 0) return "unknown size";
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function stripBom(text) {
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  }

  function isStorageAvailable(storage) {
    if (!storage
      || typeof storage.getItem !== "function"
      || typeof storage.setItem !== "function"
      || typeof storage.removeItem !== "function") {
      return false;
    }
    try {
      storage.setItem(PROBE_KEY, "1");
      const value = storage.getItem(PROBE_KEY);
      storage.removeItem(PROBE_KEY);
      return value === "1";
    } catch (_) {
      try {
        storage.removeItem(PROBE_KEY);
      } catch (_) {
        // Storage is unavailable; nothing else to do.
      }
      return false;
    }
  }

  function readIndex(storage) {
    try {
      const raw = storage.getItem(INDEX_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed) || !Array.isArray(parsed.ids)) return null;
      const ids = [];
      for (const id of parsed.ids) {
        if (isValidId(id) && !ids.includes(id)) ids.push(id);
      }
      return ids;
    } catch (_) {
      return null;
    }
  }

  function writeIndex(storage, ids) {
    const payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, ids });
    storage.setItem(INDEX_KEY, payload);
  }

  function scanSessionIds(storage) {
    const ids = [];
    try {
      const length = typeof storage.length === "number" ? storage.length : 0;
      for (let index = 0; index < length && index < 500; index++) {
        const key = typeof storage.key === "function" ? storage.key(index) : null;
        if (typeof key !== "string" || !key.startsWith(SESSION_KEY_PREFIX)) continue;
        const id = key.slice(SESSION_KEY_PREFIX.length);
        if (isValidId(id) && !ids.includes(id)) ids.push(id);
      }
    } catch (_) {
      return [];
    }
    return ids;
  }

  function collectIds(storage) {
    const indexed = readIndex(storage) || [];
    const scanned = scanSessionIds(storage);
    const ids = indexed.slice();
    for (const id of scanned) {
      if (!ids.includes(id)) ids.push(id);
    }
    return {
      ids,
      indexAvailable: readIndex(storage) !== null,
      recovered: ids.filter((id) => !indexed.includes(id))
    };
  }

  function countValidSessions(storage, ids) {
    let count = 0;
    for (const id of ids) {
      try {
        const raw = storage.getItem(makeSessionKey(id));
        if (!raw) continue;
        if (deserializeRecord(raw).ok) count++;
      } catch (_) {
        // An unreadable slot is not a valid session, so it must not consume the
        // documented history capacity.
      }
    }
    return count;
  }

  function listQuarantineKeys(storage) {
    const keys = [];
    try {
      const length = typeof storage.length === "number" ? storage.length : 0;
      for (let index = 0; index < length && index < 1000; index++) {
        const key = typeof storage.key === "function" ? storage.key(index) : null;
        if (typeof key === "string" && key.startsWith(CORRUPT_KEY_PREFIX)) keys.push(key);
      }
    } catch (_) {
      return keys;
    }
    return keys;
  }

  /**
   * Keep every unreadable payload for inspection without letting quarantine
   * copies grow without bound. The first payload for an id keeps the original
   * key; later payloads receive a unique suffix so a second corruption is not
   * silently discarded. A failed quarantine write leaves the session record in
   * place, and the caller is told that the data was retained, not set aside.
   */
  function quarantineCorruptRecord(storage, id, raw) {
    const baseKey = `${CORRUPT_KEY_PREFIX}${id}`;
    try {
      let key = baseKey;
      if (storage.getItem(baseKey) !== null) {
        do {
          quarantineSequence++;
          key = `${baseKey}.${Date.now().toString(36)}.${quarantineSequence.toString(36)}`;
        } while (storage.getItem(key) !== null);
      }

      storage.setItem(key, raw);
      const keys = listQuarantineKeys(storage);
      let extra = keys.length - MAX_QUARANTINE_RECORDS;
      if (extra > 0) {
        // Remove older copies (in storage enumeration order) after the new
        // payload is safely written, so a failed write cannot reduce the
        // quarantine.
        for (const candidate of keys) {
          if (extra <= 0) break;
          if (candidate === key) continue;
          try {
            storage.removeItem(candidate);
            extra--;
          } catch (_) {
            // Leave the extra copy in place rather than losing new data.
          }
        }
      }

      storage.removeItem(makeSessionKey(id));
      if (storage.getItem(makeSessionKey(id)) !== null) {
        return { ok: false, key, reason: "SESSION_REMOVE_FAILED" };
      }
      return { ok: true, key };
    } catch (_) {
      return { ok: false, key: null, reason: "WRITE_FAILED" };
    }
  }

  function loadSessions(storage) {
    if (!isStorageAvailable(storage)) {
      return {
        ok: false,
        available: false,
        sessions: [],
        errors: [{ code: "STORAGE_UNAVAILABLE", message: "Browser local storage is unavailable." }]
      };
    }

    const indexBefore = readIndex(storage);
    const collection = collectIds(storage);
    const sessions = [];
    const errors = [];
    const retainedIds = [];
    const quarantinedIds = [];
    const retainedCorruptIds = [];
    let indexNeedsRepair = false;

    for (const id of collection.ids) {
      let raw;
      try {
        raw = storage.getItem(makeSessionKey(id));
      } catch (_) {
        errors.push({ id, code: "STORAGE_READ_FAILED", message: "Could not read this record." });
        retainedIds.push(id);
        continue;
      }
      if (!raw) {
        errors.push({ id, code: "MISSING_RECORD", message: "Record is listed in the index but is missing." });
        indexNeedsRepair = true;
        continue;
      }
      const parsed = deserializeRecord(raw);
      if (!parsed.ok) {
        const quarantine = quarantineCorruptRecord(storage, id, raw);
        errors.push({
          id,
          code: "CORRUPT_RECORD",
          message: quarantine.ok
            ? `Unreadable record was moved to quarantine: ${parsed.code}.`
            : `Unreadable record was kept in place: ${parsed.code}.`,
          quarantined: quarantine.ok,
          retained: !quarantine.ok,
          quarantineKey: quarantine.key || null,
          details: parsed.errors
        });
        if (quarantine.ok) {
          indexNeedsRepair = true;
          quarantinedIds.push(id);
        } else {
          retainedIds.push(id);
          retainedCorruptIds.push(id);
        }
        continue;
      }
      retainedIds.push(id);
      sessions.push(parsed.record);
    }

    if (indexNeedsRepair) {
      try {
        writeIndex(storage, retainedIds);
      } catch (_) {
        errors.push({
          code: "INDEX_REPAIR_FAILED",
          message: "Unreadable records were set aside but the history index could not be updated."
        });
      }
    }

    sessions.sort((left, right) => {
      const rightTime = Date.parse(right.savedAt);
      const leftTime = Date.parse(left.savedAt);
      return rightTime - leftTime || left.id.localeCompare(right.id);
    });

    return {
      ok: true,
      available: true,
      sessions,
      errors,
      quarantinedIds,
      retainedCorruptIds,
      indexRecovered: indexBefore === null && collection.ids.length > 0,
      recoveredIds: collection.recovered
    };
  }

  function saveSession(storage, record) {
    if (!isStorageAvailable(storage)) {
      return { ok: false, code: "STORAGE_UNAVAILABLE", message: "Browser local storage is unavailable." };
    }
    const normalized = normalizeRecord(record);
    if (!normalized.ok) {
      return { ok: false, code: "INVALID_RECORD", errors: normalized.errors };
    }

    const collection = collectIds(storage);
    if (collection.ids.includes(normalized.record.id)) {
      return { ok: false, code: "DUPLICATE_ID", message: "A session with this id already exists." };
    }
    if (countValidSessions(storage, collection.ids) >= MAX_SESSIONS) {
      return {
        ok: false,
        code: "LIMIT_REACHED",
        message: `History is limited to ${MAX_SESSIONS} valid sessions. Delete a session before saving another.`
      };
    }

    let json;
    try {
      json = JSON.stringify(normalized.record);
    } catch (_) {
      return { ok: false, code: "SERIALIZE_FAILED", message: "Session could not be serialized." };
    }

    const key = makeSessionKey(normalized.record.id);
    try {
      storage.setItem(key, json);
    } catch (_) {
      return {
        ok: false,
        code: "STORAGE_WRITE_FAILED",
        message: "Browser storage rejected the session. It may be full or unavailable."
      };
    }

    try {
      writeIndex(storage, collection.ids.concat(normalized.record.id));
    } catch (_) {
      try {
        storage.removeItem(key);
      } catch (_) {
        // The orphan can be recovered by a later scan, but the caller is told
        // that the operation failed rather than silently losing data.
      }
      return {
        ok: false,
        code: "INDEX_WRITE_FAILED",
        message: "The session index could not be updated. The new record was not committed."
      };
    }

    return { ok: true, record: normalized.record };
  }

  function deleteSession(storage, id) {
    if (!isStorageAvailable(storage)) {
      return { ok: false, code: "STORAGE_UNAVAILABLE", message: "Browser local storage is unavailable." };
    }
    if (!isValidId(id)) {
      return { ok: false, code: "INVALID_ID", message: "Invalid session id." };
    }
    const collection = collectIds(storage);
    if (!collection.ids.includes(id)) {
      return { ok: false, code: "NOT_FOUND", message: "Session was not found." };
    }

    try {
      storage.removeItem(makeSessionKey(id));
    } catch (_) {
      return { ok: false, code: "STORAGE_WRITE_FAILED", message: "Could not remove the session." };
    }

    try {
      writeIndex(storage, collection.ids.filter((candidate) => candidate !== id));
    } catch (_) {
      return {
        ok: false,
        code: "INDEX_WRITE_FAILED",
        message: "The session was removed but the index could not be updated. Reloading will recover the remaining sessions.",
        removed: true
      };
    }

    return { ok: true, id };
  }

  function clearAllSessions(storage) {
    if (!isStorageAvailable(storage)) {
      return { ok: false, code: "STORAGE_UNAVAILABLE", message: "Browser local storage is unavailable.", removed: 0 };
    }
    const keys = [];
    try {
      const length = typeof storage.length === "number" ? storage.length : 0;
      for (let index = 0; index < length && index < 1000; index++) {
        const key = typeof storage.key === "function" ? storage.key(index) : null;
        if (typeof key === "string"
          && (key === INDEX_KEY || key.startsWith(SESSION_KEY_PREFIX) || key.startsWith(CORRUPT_KEY_PREFIX))) {
          keys.push(key);
        }
      }
    } catch (_) {
      return { ok: false, code: "STORAGE_READ_FAILED", message: "Could not enumerate saved sessions.", removed: 0 };
    }

    const errors = [];
    let removed = 0;
    for (const key of keys) {
      try {
        storage.removeItem(key);
        if (key.startsWith(SESSION_KEY_PREFIX)) removed++;
      } catch (_) {
        errors.push(key);
      }
    }

    return {
      ok: errors.length === 0,
      removed,
      errors: errors.map((key) => ({ key, code: "REMOVE_FAILED", message: "Could not remove this key." }))
    };
  }

  function exportSessions(records, options) {
    const settings = options && typeof options === "object" ? options : {};
    const maxBytes = isFiniteNumber(settings.maxBytes) && settings.maxBytes > 0
      ? settings.maxBytes
      : MAX_EXPORT_BYTES;
    if (!Array.isArray(records) || records.length === 0) {
      return { ok: false, code: "EMPTY", message: "There are no sessions to export." };
    }
    if (records.length > MAX_IMPORT_SESSIONS) {
      return { ok: false, code: "TOO_MANY_SESSIONS", message: `Export at most ${MAX_IMPORT_SESSIONS} sessions at once.` };
    }

    const normalized = [];
    const errors = [];
    records.forEach((record, index) => {
      const result = normalizeRecord(record);
      if (result.ok) normalized.push(result.record);
      else errors.push({ index, id: record && record.id, code: result.code, details: result.errors });
    });
    if (errors.length) {
      return { ok: false, code: "INVALID_RECORD", errors, message: "One or more sessions failed validation and were not exported." };
    }

    const envelope = {
      format: EXPORT_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      app: "RefreshTest V2",
      exportedAt: toIsoTimestamp(settings.exportedAt === undefined ? Date.now() : settings.exportedAt, "exportedAt", [], true),
      disclaimer: EXPORT_DISCLAIMER,
      sessionCount: normalized.length,
      sessions: normalized
    };

    let json;
    try {
      json = JSON.stringify(envelope, null, 2);
    } catch (_) {
      return { ok: false, code: "SERIALIZE_FAILED", message: "Export could not be serialized." };
    }

    const bytes = byteLength(json);
    if (bytes > maxBytes) {
      return {
        ok: false,
        code: "EXPORT_TOO_LARGE",
        message: `This export is ${formatBytes(bytes)}, above the ${formatBytes(maxBytes)} limit. Deselect sessions or delete long sessions, then export in smaller groups.`,
        bytes,
        maxBytes
      };
    }

    return { ok: true, json, sessionCount: normalized.length, bytes };
  }

  function parseImport(text, options) {
    const settings = options && typeof options === "object" ? options : {};
    const maxBytes = isFiniteNumber(settings.maxBytes) && settings.maxBytes > 0 ? settings.maxBytes : MAX_IMPORT_BYTES;
    const maxSessions = isFiniteNumber(settings.maxSessions) && settings.maxSessions > 0
      ? Math.min(MAX_IMPORT_SESSIONS, Math.floor(settings.maxSessions))
      : MAX_IMPORT_SESSIONS;

    if (typeof text !== "string") {
      return { ok: false, code: "INVALID_INPUT", message: "Import expects JSON text." };
    }
    const source = stripBom(text);
    const bytes = byteLength(source);
    if (bytes > maxBytes) {
      return {
        ok: false,
        code: "INPUT_TOO_LARGE",
        message: `That file is ${formatBytes(bytes)}. Imports are limited to ${formatBytes(maxBytes)}.`,
        bytes,
        maxBytes
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (_) {
      return { ok: false, code: "MALFORMED_JSON", message: "The selected file is not valid JSON." };
    }

    let candidates;
    let envelopeFormat = null;
    if (Array.isArray(parsed)) {
      candidates = parsed;
    } else if (isPlainObject(parsed) && Array.isArray(parsed.sessions)) {
      if (parsed.format !== undefined && parsed.format !== EXPORT_FORMAT) {
        return { ok: false, code: "UNSUPPORTED_FORMAT", message: "This is not a RefreshTest session export." };
      }
      if (!isInteger(parsed.schemaVersion) || parsed.schemaVersion > SCHEMA_VERSION) {
        return { ok: false, code: "UNSUPPORTED_SCHEMA", message: "The export schema is not supported by this version." };
      }
      envelopeFormat = parsed.format || null;
      candidates = parsed.sessions;
    } else if (isPlainObject(parsed) && parsed.kind === KIND) {
      candidates = [parsed];
    } else {
      return { ok: false, code: "UNSUPPORTED_FORMAT", message: "JSON does not contain RefreshTest sessions." };
    }

    if (candidates.length === 0) {
      return { ok: false, code: "EMPTY", message: "The import contains no sessions." };
    }
    if (candidates.length > maxSessions) {
      return { ok: false, code: "TOO_MANY_SESSIONS", message: `Import at most ${maxSessions} sessions at once.` };
    }

    const sessions = [];
    const errors = [];
    candidates.forEach((candidate, index) => {
      const result = normalizeRecord(candidate);
      if (result.ok) sessions.push(result.record);
      else errors.push({ index, code: result.code, details: result.errors });
    });

    if (sessions.length === 0) {
      return { ok: false, code: "NO_VALID_SESSIONS", message: "No valid sessions were found in the import.", errors };
    }

    return {
      ok: true,
      sessions,
      errors,
      skipped: errors.length,
      importedCount: sessions.length,
      format: envelopeFormat
    };
  }

  function mergeImported(existingSessions, importedSessions) {
    const existing = Array.isArray(existingSessions) ? existingSessions : [];
    const imported = Array.isArray(importedSessions) ? importedSessions : [];
    const merged = existing.slice();
    const ids = new Set();
    for (const record of existing) {
      if (record && isValidId(record.id)) ids.add(record.id);
    }

    const added = [];
    const skipped = [];
    for (const record of imported) {
      if (!record || !isValidId(record.id)) {
        skipped.push({ id: record && record.id, code: "INVALID_ID" });
        continue;
      }
      if (ids.has(record.id)) {
        skipped.push({ id: record.id, code: "DUPLICATE_ID" });
        continue;
      }
      if (merged.length >= MAX_SESSIONS) {
        skipped.push({ id: record.id, code: "LIMIT_REACHED" });
        continue;
      }
      merged.push(record);
      ids.add(record.id);
      added.push(record);
    }

    return {
      sessions: merged,
      added,
      skipped,
      limitReached: skipped.some((item) => item.code === "LIMIT_REACHED")
    };
  }

  const api = Object.freeze({
    SCHEMA_VERSION,
    KIND,
    EXPORT_FORMAT,
    EXPORT_DISCLAIMER,
    INDEX_KEY,
    SESSION_KEY_PREFIX,
    CORRUPT_KEY_PREFIX,
    MAX_SESSIONS,
    MAX_QUARANTINE_RECORDS,
    MAX_TRANSFER_BYTES,
    MAX_IMPORT_BYTES,
    MAX_EXPORT_BYTES,
    MAX_IMPORT_SESSIONS,
    MAX_OBSERVATIONS,
    MAX_OBSERVATION_MS,
    SUMMARY_NUMERIC_FIELDS,
    SUMMARY_DURATION_FIELDS,
    isStorageAvailable,
    createSessionId,
    makeSessionKey,
    buildSessionRecord,
    normalizeRecord,
    migrateRecord,
    serializeRecord,
    deserializeRecord,
    loadSessions,
    saveSession,
    deleteSession,
    clearAllSessions,
    exportSessions,
    parseImport,
    mergeImported,
    snapshotSummary
  });

  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }

  if (typeof window !== "undefined") {
    window.RefreshTestStorage = api;
  }
})();
