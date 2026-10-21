"use strict";

/**
 * Script-level integration checks for the browser wiring in script.js.
 *
 * This is deliberately a small deterministic DOM shim, not a browser engine.
 * It exercises real script.js event handlers, the real measurement/storage
 * modules, and exact status strings without adding a browser dependency.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Stats = require("../stats.js");
const Measurement = require("../measurement.js");
const Storage = require("../storage.js");

const ROOT = path.join(__dirname, "..");
const SCRIPT = fs.readFileSync(path.join(ROOT, "script.js"), "utf8");
const INDEX = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const MODULE_SOURCES = ["stats.js", "measurement.js", "insights.js", "storage.js", "comparison.js"]
  .map((file) => ({
    file,
    source: fs.readFileSync(path.join(ROOT, file), "utf8")
  }));

function repeat(value, count) {
  return Array.from({ length: count }, () => value);
}

class MemoryStorage {
  constructor() {
    this.map = new Map();
    this.failOnKey = null;
  }

  get length() {
    return this.map.size;
  }

  key(index) {
    return Array.from(this.map.keys())[index] ?? null;
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    if (this.failOnKey && key.startsWith(this.failOnKey)) throw new Error("storage write failed");
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }
}

class FakeClassList {
  constructor(initial = []) {
    this.names = new Set(initial);
  }

  add(...names) {
    names.forEach((name) => this.names.add(name));
  }

  remove(...names) {
    names.forEach((name) => this.names.delete(name));
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.names.has(name) : Boolean(force);
    if (enabled) this.names.add(name);
    else this.names.delete(name);
    return enabled;
  }

  contains(name) {
    return this.names.has(name);
  }
}

function textNode(value) {
  return { nodeType: 3, textContent: String(value), parentElement: null };
}

class FakeNode {
  constructor(tagName = "div", id = "") {
    this.tagName = String(tagName).toUpperCase();
    this.id = id;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this._className = "";
    this._textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.width = 0;
    this.height = 0;
    this.href = "";
    this.download = "";
    this.rel = "";
    this.type = "";
    this.scope = "";
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value);
    this.classList = new FakeClassList(this._className.split(/\s+/).filter(Boolean));
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent ?? "").join("");
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      if (node.isFragment) {
        this.append(...node.children);
        continue;
      }
      const child = typeof node === "string" ? textNode(node) : node;
      child.parentElement = this;
      this.children.push(child);
    }
  }

  replaceChildren(...nodes) {
    this._textContent = "";
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  click() {
    const event = { currentTarget: this, target: this, preventDefault() {} };
    for (const handler of this.listeners.get("click") || []) handler(event);
    if (this.tagName === "A" && this.download) {
      this.ownerDocument.downloads.push({
        filename: this.download,
        text: this.ownerDocument.blobText.get(this.href) || ""
      });
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
    if (name === "class") this.className = String(value);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  querySelector(selector) {
    if (selector === "span:nth-child(2)") {
      const spans = this.children.filter((child) => child.tagName === "SPAN");
      return spans[1] || null;
    }
    return null;
  }

  querySelectorAll() {
    return [];
  }

  closest(selector) {
    let node = this;
    while (node) {
      const classNames = node.className.split(/\s+/).filter(Boolean);
      if (selector === ".lab-card" && classNames.includes("lab-card")) return node;
      node = node.parentElement;
    }
    return null;
  }

  getBoundingClientRect() {
    return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }

  getContext() {
    return null;
  }

  focus() {}
}

function makeRecord(id = "rt-corrupt") {
  const values = repeat(16.67, 60);
  const result = Storage.buildSessionRecord({
    id,
    savedAt: "2026-10-21T10:00:00.000Z",
    startedAt: "2026-10-21T09:59:52.000Z",
    mode: "standard",
    modeLabel: "Standard",
    durationMs: 8000,
    sampleWindowMs: 8000,
    summary: Stats.computeStatistics(values),
    observations: values,
    hiddenPauses: { count: 0, durationMs: 0 },
    diagnostics: { invalidCount: 0, droppedObservations: 0 },
    environment: { browser: "Google Chrome", os: "Windows", devicePixelRatio: 1 }
  });
  assert.equal(result.ok, true);
  return result.record;
}

function createHarness(options = {}) {
  const storage = options.storage || new MemoryStorage();
  const clock = { now: options.clockStart || 1700000000000 };
  const downloads = [];
  const blobText = new Map();
  const checkboxes = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const rafQueue = new Map();
  let rafId = 0;
  let blobId = 0;

  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }

    static now() {
      return clock.now;
    }
  }

  class FakeBlob {
    constructor(parts) {
      this.text = parts.join("");
    }
  }

  const FakeURL = {
    createObjectURL(blob) {
      const url = `blob:test-${++blobId}`;
      blobText.set(url, blob.text);
      return url;
    },
    revokeObjectURL() {}
  };

  const byId = new Map();
  for (const match of INDEX.matchAll(/\bid="([^"]+)"/g)) {
    byId.set(match[1], new FakeNode("div", match[1]));
  }

  const runButton = byId.get("startTest");
  runButton.append(new FakeNode("span"), new FakeNode("span"));

  const body = new FakeNode("body");
  const track = new FakeNode("div");
  track.className = "motion-track";
  const heading = new FakeNode("h1");

  const viewElements = ["test", "history", "compare", "lab"].map((view) => {
    const element = new FakeNode("section");
    element.dataset.view = view;
    return element;
  });
  const navLinks = ["test", "history", "compare", "lab"].map((view) => {
    const element = new FakeNode("a");
    element.dataset.viewLink = view;
    return element;
  });
  const modeButtons = Measurement.MODE_ORDER.map((mode) => {
    const button = new FakeNode("button");
    button.dataset.mode = mode;
    return button;
  });
  const speedButtons = [1, 2, 4].map((speed) => {
    const button = new FakeNode("button");
    button.dataset.speed = String(speed);
    return button;
  });

  const makeElement = (tagName) => {
    const node = new FakeNode(tagName);
    node.ownerDocument = document;
    if (tagName === "input") checkboxes.push(node);
    return node;
  };

  const document = {
    hidden: false,
    title: "",
    body,
    downloads,
    blobText,
    getElementById(id) {
      return byId.get(id) || null;
    },
    querySelector(selector) {
      if (selector === ".motion-track") return track;
      if (/^\[data-view="[^"]+"\] h1$/.test(selector)) return heading;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-speed]") return speedButtons;
      if (selector === "[data-mode]") return modeButtons;
      if (selector === "[data-view]") return viewElements;
      if (selector === "[data-view-link]") return navLinks;
      if (selector === 'input[type="checkbox"]') return checkboxes;
      return [];
    },
    createElement: makeElement,
    createTextNode(value) {
      return textNode(value);
    },
    createDocumentFragment() {
      const fragment = new FakeNode("#fragment");
      fragment.isFragment = true;
      return fragment;
    },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    }
  };

  for (const element of [...byId.values(), ...viewElements, ...navLinks, ...modeButtons, ...speedButtons, track, body]) {
    element.ownerDocument = document;
  }

  const location = {
    _hash: "",
    get hash() {
      return this._hash;
    },
    set hash(value) {
      this._hash = String(value);
    }
  };

  const windowObject = {
    localStorage: storage,
    location,
    devicePixelRatio: 1,
    navigator: {
      userAgent: "Mozilla/5.0 Chrome/140.0.0.0",
      platform: "Windows",
      userAgentData: { platform: "Windows" }
    },
    screen: { width: 1920, height: 1080 },
    innerWidth: 1280,
    innerHeight: 800,
    confirm: () => true,
    scrollTo() {},
    matchMedia() {
      return { matches: true, addEventListener() {} };
    },
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(handler);
    },
    setTimeout(handler) {
      handler();
      return 0;
    },
    clearTimeout() {},
    requestAnimationFrame(handler) {
      const id = ++rafId;
      rafQueue.set(id, handler);
      return id;
    },
    cancelAnimationFrame(id) {
      rafQueue.delete(id);
    }
  };

  const context = {
    window: windowObject,
    document,
    navigator: windowObject.navigator,
    screen: windowObject.screen,
    innerWidth: windowObject.innerWidth,
    innerHeight: windowObject.innerHeight,
    performance: { now: () => clock.now },
    Date: FakeDate,
    Blob: FakeBlob,
    URL: FakeURL,
    requestAnimationFrame: windowObject.requestAnimationFrame,
    cancelAnimationFrame: windowObject.cancelAnimationFrame,
    setTimeout: windowObject.setTimeout,
    clearTimeout: windowObject.clearTimeout
  };

  vm.createContext(context);
  for (const module of MODULE_SOURCES) {
    vm.runInContext(module.source, context, { filename: module.file });
  }
  vm.runInContext(SCRIPT, context, { filename: "script.js" });

  return {
    byId,
    storage,
    clock,
    downloads,
    window: windowObject,
    document,
    dispatch(type) {
      for (const handler of windowListeners.get(type) || []) handler({ type });
      for (const handler of documentListeners.get(type) || []) handler({ type });
    },
    start() {
      runButton.click();
    },
    flushFrames(limit = 700) {
      let timestamp = clock.now;
      for (let index = 0; index < limit; index++) {
        const entry = rafQueue.entries().next().value;
        if (!entry) break;
        rafQueue.delete(entry[0]);
        entry[1](timestamp);
        timestamp += 16;
        clock.now += 16;
        if ((runButton.children[1]?.textContent || "") === "Run again") break;
      }
    }
  };
}

test("saving an export-first result re-stamps savedAt and keeps one stable record", () => {
  const harness = createHarness();
  harness.byId.get("startTest").click();
  harness.flushFrames();

  harness.byId.get("exportResult").click();
  assert.equal(
    harness.downloads.length,
    1,
    `run=${harness.byId.get("startTest").children[1]?.textContent} exportDisabled=${harness.byId.get("exportResult").disabled} status=${harness.byId.get("statusText").textContent} saveStatus=${harness.byId.get("saveStatus").textContent}`
  );
  const exported = Storage.parseImport(harness.downloads[0].text).sessions[0];
  assert.ok(exported.savedAt);

  harness.clock.now += 60000;
  harness.byId.get("exportResult").click();
  assert.equal(harness.downloads.length, 2);
  const repeatedExport = Storage.parseImport(harness.downloads[1].text).sessions[0];
  assert.equal(repeatedExport.id, exported.id);
  assert.equal(repeatedExport.savedAt, exported.savedAt);

  harness.clock.now += 60000;
  harness.byId.get("saveSession").click();

  const stored = Storage.loadSessions(harness.storage).sessions;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, exported.id);
  assert.notEqual(stored[0].savedAt, exported.savedAt);
  assert.ok(Date.parse(stored[0].savedAt) > Date.parse(exported.savedAt));
  assert.equal(harness.byId.get("saveSession").disabled, true);
  assert.equal(harness.byId.get("saveSession").textContent, "Saved");

  harness.byId.get("exportResult").click();
  assert.equal(harness.downloads.length, 3);
  const reexported = Storage.parseImport(harness.downloads[2].text).sessions[0];
  assert.equal(reexported.savedAt, stored[0].savedAt);
  assert.equal(Storage.loadSessions(harness.storage).sessions.length, 1);
});

test("cancelling a measurement clears the result and prevents saving partial data", () => {
  const harness = createHarness();
  harness.byId.get("startTest").click();
  harness.flushFrames(6);

  harness.byId.get("startTest").click();
  assert.match(harness.byId.get("statusText").textContent, /^CANCELLED$/);
  assert.equal(harness.byId.get("startTest").children[1].textContent, "Run measurement");
  assert.equal(harness.byId.get("saveSession").disabled, true);
  assert.equal(harness.byId.get("exportResult").disabled, true);

  harness.byId.get("saveSession").click();
  assert.equal(Storage.loadSessions(harness.storage).sessions.length, 0);
});

test("leaving the Test view cancels the run and reports that nothing was saved", () => {
  const harness = createHarness();
  harness.byId.get("startTest").click();
  harness.flushFrames(6);

  harness.window.location.hash = "#history";
  harness.dispatch("hashchange");

  assert.match(harness.byId.get("statusText").textContent, /^CANCELLED$/);
  assert.match(harness.byId.get("rateNote").textContent, /left the Test view/);
  assert.match(harness.byId.get("rateNote").textContent, /No result was saved/);
  assert.equal(harness.byId.get("saveSession").disabled, true);
  assert.equal(Storage.loadSessions(harness.storage).sessions.length, 0);
});

test("History shows the exact quarantine and retained-record status", () => {
  const cases = [
    {
      label: "quarantined",
      failOnKey: null,
      status: "1 unreadable record was moved to quarantine. Other sessions are unaffected.",
      state: "1 saved · 1 set aside",
      retained: false
    },
    {
      label: "retained",
      failOnKey: Storage.CORRUPT_KEY_PREFIX,
      status: "1 unreadable record was kept in place because it could not be copied to quarantine; no data was deleted. Other sessions are unaffected.",
      state: "1 saved · 1 unreadable",
      retained: true
    }
  ];

  for (const testCase of cases) {
    const storage = new MemoryStorage();
    const good = makeRecord("rt-good");
    const corrupt = makeRecord("rt-corrupt");
    assert.equal(Storage.saveSession(storage, good).ok, true);
    assert.equal(Storage.saveSession(storage, corrupt).ok, true);
    storage.setItem(Storage.makeSessionKey(corrupt.id), "{corrupt");
    storage.failOnKey = testCase.failOnKey;

    const harness = createHarness({ storage });
    assert.equal(harness.byId.get("historyStatus").textContent, testCase.status, testCase.label);
    assert.equal(harness.byId.get("historyStorageState").textContent, testCase.state, testCase.label);
    assert.equal(harness.byId.get("historyCount").textContent, "1", testCase.label);
    assert.equal(harness.byId.get("historyCount").hidden, false, testCase.label);
    assert.ok(harness.byId.get("historyList").children.length > 0, testCase.label);

    const surviving = Storage.loadSessions(storage).sessions;
    assert.deepEqual(surviving.map((record) => record.id), ["rt-good"], testCase.label);

    if (testCase.retained) {
      assert.equal(storage.getItem(Storage.makeSessionKey(corrupt.id)), "{corrupt", testCase.label);
      assert.equal(storage.getItem(`${Storage.CORRUPT_KEY_PREFIX}${corrupt.id}`), null, testCase.label);
    } else {
      assert.equal(storage.getItem(Storage.makeSessionKey(corrupt.id)), null, testCase.label);
      assert.equal(storage.getItem(`${Storage.CORRUPT_KEY_PREFIX}${corrupt.id}`), "{corrupt", testCase.label);
    }
  }
});
