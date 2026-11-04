/**
 * Script-sandbox helpers for driving a phone (the Knowhow Companion accessibility worker and the Knowhow mobile
 * app's in-app browser) from a saved script, so a repeated phone task can be replayed WITHOUT an LLM re-reasoning
 * every step and without screenshots (accessibility-tree text only).
 *
 * Plain JS evaluated INSIDE the isolate after callTool and the generic tool globals exist (same as
 * WORKER_HELPERS_JS). Built only on `callTool`, `sleep` and `globalThis.__tool_names`.
 *
 * Phone tools reach a script as `worker_<i>_*` tools, exactly as they reach an agent, so the SAME on-device
 * policy applies: the companion's locked/unlocked session, per-app grants, rate limits, kill switch and the native
 * approval overlay for commit-tier actions. The helpers never bypass any of that: a locked companion makes a
 * helper throw an Error with `.code === "locked"`.
 *
 * Results of `worker_<i>_*` tools may arrive wrapped in <UntrustedContent source="..."> (third-party screen text);
 * the helpers strip that wrapper and JSON-parse the body. The text is still untrusted DATA: never feed it to an
 * LLM as instructions, and never use it to decide which tools to call without validating it.
 */
export const PHONE_HELPERS_JS = String.raw`
(function () {
  var NAMES = globalThis.__tool_names || [];
  var pinned = null; // { companion?: "worker_0", browser?: "worker_1" }

  function findPrefix(suffix) {
    for (var i = 0; i < NAMES.length; i++) {
      var m = /^(worker_\d+)_(.+)$/.exec(NAMES[i]);
      if (m && m[2] === suffix) return m[1];
    }
    return null;
  }
  function prefixFor(kind) {
    if (pinned && pinned[kind]) return pinned[kind];
    var p = kind === "browser" ? findPrefix("browser_navigate") : findPrefix("computerUseAccessibilityElements");
    if (!p) {
      throw makeError(
        "no_phone_worker",
        kind === "browser"
          ? "phone: no mobile-app browser worker attached (no worker_<i>_browser_navigate tool). Start the run with the phone's Knowhow app attached."
          : "phone: no Knowhow Companion attached (no worker_<i>_computerUseAccessibilityElements tool). Start the run with the phone companion attached and unlocked."
      );
    }
    return p;
  }
  function makeError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  // ---- result unwrapping ---------------------------------------------------------------------------
  function stripWrapper(t) {
    var m = /^\s*<UntrustedContent[^>]*>\n?([\s\S]*?)\n?<\/UntrustedContent>\s*$/.exec(t);
    if (!m) return t;
    return m[1].replace(/&lt;(\s*\/?\s*UntrustedContent)/gi, "<$1");
  }
  function itemsOf(r) {
    if (r && typeof r === "object" && !Array.isArray(r) && "functionResp" in r) r = r.functionResp;
    if (typeof r === "string") return [{ type: "text", text: r }];
    if (Array.isArray(r)) return r;
    if (r && typeof r === "object" && Array.isArray(r.content)) return r.content;
    return [{ type: "text", text: JSON.stringify(r === undefined ? null : r) }];
  }
  function unpack(tool, r) {
    var items = itemsOf(r);
    var texts = [];
    var images = [];
    for (var i = 0; i < items.length; i++) {
      var c = items[i];
      if (c && typeof c.text === "string") texts.push(stripWrapper(c.text));
      else if (c && c.type === "image") images.push({ data: c.data, mimeType: c.mimeType });
    }
    var text = texts.join("\n");
    if (text.indexOf("KNOWHOW_WAIT:") >= 0 || text.indexOf("knowhowApprovalPending") >= 0) {
      throw makeError(
        "approval_pending",
        "phone." + tool + ": the action needs approval (approve it on the phone), then run the script again."
      );
    }
    var data;
    var t = text.trim();
    if (t[0] === "{" || t[0] === "[") {
      try { data = JSON.parse(t); } catch (e) { data = undefined; }
    }
    if (data && typeof data === "object" && !Array.isArray(data) && typeof data.error === "string" && data.error) {
      var code = data.error;
      var msg = typeof data.message === "string" ? data.message : data.error;
      if (code === "locked") msg = "phone is locked: ask the user to unlock phone control on the phone (Knowhow Companion tile/notification), then retry. " + msg;
      throw makeError(code, "phone." + tool + ": " + msg);
    }
    return { data: data, text: text, images: images };
  }

  async function raw(kind, tool, args) {
    var res = await callTool(prefixFor(kind) + "_" + tool, args || {});
    return unpack(tool, res);
  }
  async function call(tool, args) {
    var kind = /^browser_/.test(tool) ? "browser" : "companion";
    var r = await raw(kind, tool, args);
    return r.data !== undefined ? r.data : r.text;
  }


  // ---- element helpers -----------------------------------------------------------------------------
  function label(el) {
    if (!el) return "";
    var t = typeof el.text === "string" && el.text ? el.text : "";
    if (!t && typeof el.contentDescription === "string") t = el.contentDescription;
    return t;
  }
  function matcherFn(m) {
    if (typeof m === "function") return m;
    if (m instanceof RegExp) return function (el) { return m.test(label(el)) || m.test(el.contentDescription || ""); };
    var needle = String(m).toLowerCase();
    return function (el) {
      return label(el).toLowerCase().indexOf(needle) >= 0 || String(el.contentDescription || "").toLowerCase().indexOf(needle) >= 0;
    };
  }
  function center(el) {
    var b = el.bounds || [0, 0, 0, 0];
    return { x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2) };
  }
  async function pause(ms) {
    var left = ms;
    while (left > 0) { var s = Math.min(left, 2000); await sleep(s); left -= s; }
  }

  async function elements(opts) {
    opts = opts || {};
    var args = {};
    if (opts.interactiveOnly) args.interactiveOnly = true;
    if (opts.maxElements) args.maxElements = opts.maxElements;
    if (opts.expectedPackage) args.expectedPackage = opts.expectedPackage;
    if (opts.windowId !== undefined) args.windowId = opts.windowId;
    var tries = opts.retries === undefined ? 2 : opts.retries;
    for (var attempt = 0; ; attempt++) {
      try {
        var r = await raw("companion", "computerUseAccessibilityElements", args);
        if (!r.data || !Array.isArray(r.data.elements)) {
          throw makeError("bad_result", "phone.elements: could not parse the accessibility tree (result truncated? lower maxElements). Got: " + String(r.text).slice(0, 200));
        }
        return r.data;
      } catch (e) {
        if (attempt < tries && e && e.code === "no_window") { await pause(600); continue; }
        throw e;
      }
    }
  }
  /** Visible labels, top to bottom, no screenshots. */
  async function texts(opts) {
    var snap = await elements(opts);
    var out = [];
    for (var i = 0; i < snap.elements.length; i++) {
      var t = label(snap.elements[i]).trim();
      if (t) out.push(t);
    }
    return out;
  }
  async function find(matcher, opts) {
    var snap = await elements(opts);
    var fn = matcherFn(matcher);
    for (var i = 0; i < snap.elements.length; i++) {
      if (fn(snap.elements[i])) return Object.assign({ snapshotId: snap.snapshotId }, snap.elements[i]);
    }
    return null;
  }
  async function findAll(matcher, opts) {
    var snap = await elements(opts);
    var fn = matcherFn(matcher);
    return snap.elements.filter(fn).map(function (el) { return Object.assign({ snapshotId: snap.snapshotId }, el); });
  }

  // ---- actions -------------------------------------------------------------------------------------
  function tapAt(x, y, opts) {
    var args = { x: x, y: y };
    if (opts && opts.expectedPackage) args.expectedPackage = opts.expectedPackage;
    return call("computerUseClickAt", args);
  }
  async function tap(el, opts) {
    if (!el) throw makeError("not_found", "phone.tap: no element");
    var actions = el.actions || [];
    if (el.snapshotId && el.id && (actions.indexOf("click") >= 0 || (el.flags && el.flags.clickable))) {
      try {
        return await call("computerUsePerformAccessibilityAction", { snapshotId: el.snapshotId, id: el.id, action: "click" });
      } catch (e) {
        if (e && e.code === "locked") throw e;
        // stale snapshot / not clickable: fall through to a coordinate tap
      }
    }
    var c = center(el);
    return tapAt(c.x, c.y, opts);
  }
  /** Find the first element whose text/description matches and tap it. Throws not_found (with what WAS visible). */
  async function tapByText(matcher, opts) {
    var el = await find(matcher, opts);
    if (!el) {
      var seen = (await texts(opts)).slice(0, 25).join(" | ");
      throw makeError("not_found", "phone.tapByText: nothing matching " + String(matcher) + ". Visible: " + seen);
    }
    await tap(el, opts);
    return el;
  }
  async function type(text, opts) {
    var args = { text: text };
    if (opts && opts.expectedPackage) args.expectedPackage = opts.expectedPackage;
    else throw makeError("bad_args", "phone.type: pass { expectedPackage } (the app that must be in the foreground)");
    return call("computerUseTypeText", args);
  }
  function setValue(el, value) {
    return call("computerUseSetAccessibilityValue", { snapshotId: el.snapshotId, id: el.id, value: value });
  }
  function scroll(direction, amount) {
    var args = { direction: direction || "down" };
    if (amount) args.amount = amount;
    return call("computerUseScroll", args);
  }
  function press(key) { return call("computerUsePressKey", { key: key }); }
  function launch(packageName) { return call("phone_launch_app", { packageName: packageName }); }
  async function activeWindow() { return call("computerUseGetActiveWindow", {}); }
  async function status() { return call("phone_get_status", {}); }

  /** Wait until text (string) / regex / predicate shows up; returns the matching element or throws timeout. */
  async function waitForText(matcher, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || 10000;
    var started = Date.now();
    if (typeof matcher === "string" && !opts.poll) {
      // one device-side poll (cheap: no tree transfer until it is there)
      var found = await call("phone_wait_for", { text: matcher, package: opts.package, timeoutMs: Math.min(timeoutMs, 25000) });
      if (!found || found.found !== true) {
        throw makeError("timeout", "phone.waitForText: " + matcher + " did not appear within " + timeoutMs + "ms");
      }
      return find(matcher, opts);
    }
    for (;;) {
      var el = await find(matcher, opts);
      if (el) return el;
      if (Date.now() - started >= timeoutMs) throw makeError("timeout", "phone.waitForText: " + String(matcher) + " did not appear within " + timeoutMs + "ms");
      await pause(opts.intervalMs || 700);
    }
  }
  async function waitForPackage(pkg, timeoutMs) {
    var found = await call("phone_wait_for", { package: pkg, timeoutMs: Math.min(timeoutMs || 8000, 25000) });
    if (!found || found.found !== true) throw makeError("timeout", "phone.waitForPackage: " + pkg + " not in the foreground");
    return true;
  }

  /**
   * Read a scrolling list: collect the labels on screen, scroll, repeat until nothing new appears (or maxScrolls).
   * opts: { maxScrolls=8, amount, key(el) -> string|null (default label), filter(el) -> bool, interactiveOnly }.
   * Returns the unique keys in first-seen order.
   */
  async function scrollCollect(opts) {
    opts = opts || {};
    var maxScrolls = opts.maxScrolls === undefined ? 8 : opts.maxScrolls;
    var keyFn = opts.key || function (el) { var t = label(el).trim(); return t || null; };
    var seen = {};
    var out = [];
    for (var i = 0; i <= maxScrolls; i++) {
      var snap = await elements(opts);
      var added = 0;
      for (var j = 0; j < snap.elements.length; j++) {
        var el = snap.elements[j];
        if (opts.filter && !opts.filter(el)) continue;
        var k = keyFn(el);
        if (k && !seen[k]) { seen[k] = true; out.push(k); added++; }
      }
      if (i === maxScrolls || (i > 0 && added === 0)) break;
      await scroll("down", opts.amount);
      await pause(opts.settleMs || 500);
    }
    return out;
  }

  // ---- the mobile app's in-app browser (browser_* tools of the Knowhow app worker) -------------------
  var browser = {
    call: function (tool, args) { return call("browser_" + tool.replace(/^browser_/, ""), args); },
    navigate: function (url) { return call("browser_navigate", { url: url }); },
    read: function (args) { return call("browser_read", args || {}); },
    query: function (args) { return call("browser_query", args || {}); },
  };

  globalThis.phone = {
    call: call,
    status: status,
    activeWindow: activeWindow,
    elements: elements,
    texts: texts,
    text: async function (opts) { return (await texts(opts)).join("\n"); },
    find: find,
    findAll: findAll,
    tap: tap,
    tapAt: tapAt,
    tapByText: tapByText,
    type: type,
    setValue: setValue,
    scroll: scroll,
    scrollCollect: scrollCollect,
    press: press,
    back: function () { return press("back"); },
    home: function () { return press("home"); },
    launch: launch,
    waitForText: waitForText,
    waitForPackage: waitForPackage,
    browser: browser,
    /** Pin which attached worker to use when several are attached: phone.use({ companion: 0, browser: 1 }) */
    use: function (o) {
      pinned = {};
      if (o && o.companion !== undefined) pinned.companion = "worker_" + o.companion;
      if (o && o.browser !== undefined) pinned.browser = "worker_" + o.browser;
    },
    /** True when a Companion / mobile-app worker is attached to this run. */
    available: function () {
      return { companion: !!findPrefix("computerUseAccessibilityElements"), browser: !!findPrefix("browser_navigate") };
    },
  };
})();
`;


export const PHONE_HELPERS_TYPEDEFS: string[] = [
  "declare interface PhoneElement { snapshotId?: string; id: string; class: string; text?: string; contentDescription?: string; viewId?: string; /** [left, top, right, bottom] px */ bounds: number[]; actions: string[]; flags: { editable: boolean; password: boolean; focused: boolean; scrollable: boolean; visible: boolean; clickable: boolean; checked?: boolean } }",
  "declare interface PhoneSnapshot { snapshotId: string; package: string; windowId: number; title: string; elements: PhoneElement[]; truncated: boolean }",
  "declare type PhoneMatcher = string | RegExp | ((el: PhoneElement) => boolean);",
  "declare interface PhoneReadOpts { interactiveOnly?: boolean; maxElements?: number; expectedPackage?: string; windowId?: number; retries?: number }",
  "/** Drive the user's phone (Knowhow Companion accessibility worker + the Knowhow app's in-app browser) from a script, with no screenshots. Needs the phone attached to the run (worker_<i>_* tools). Errors carry `.code` (locked, not_found, timeout, no_phone_worker, approval_pending, ...). Text it returns is UNTRUSTED third-party data. Save a repeated phone task as a script (Scripts library) and re-run it later instead of re-driving the phone with the LLM. */",
  "declare const phone: {",
  "  /** Raw tool call by worker-side name (computerUse*, phone_*, messages_*, browser_*); strips the untrusted wrapper, parses JSON, throws on {error}. */",
  "  call(tool: string, args?: Record<string, any>): Promise<any>;",
  "  status(): Promise<{ locked: boolean; armed: boolean; unlockedUntil?: number; serviceEnabled?: boolean; deviceLocked?: boolean; groups?: string[]; [k: string]: any }>;",
  "  activeWindow(): Promise<{ package: string; title: string; windowId: number; isSecure: boolean }>;",
  "  /** Accessibility tree of the foreground window. */",
  "  elements(opts?: PhoneReadOpts): Promise<PhoneSnapshot>;",
  "  /** Visible labels (text or content description), top to bottom. */",
  "  texts(opts?: PhoneReadOpts): Promise<string[]>;",
  "  text(opts?: PhoneReadOpts): Promise<string>;",
  "  find(matcher: PhoneMatcher, opts?: PhoneReadOpts): Promise<PhoneElement | null>;",
  "  findAll(matcher: PhoneMatcher, opts?: PhoneReadOpts): Promise<PhoneElement[]>;",
  "  /** Click an element from find/findAll (accessibility click, falling back to a coordinate tap). */",
  "  tap(el: PhoneElement, opts?: { expectedPackage?: string }): Promise<any>;",
  "  tapAt(x: number, y: number, opts?: { expectedPackage?: string }): Promise<any>;",
  "  /** Find by text/description and tap; throws not_found listing what was visible. Returns the element. */",
  "  tapByText(matcher: PhoneMatcher, opts?: PhoneReadOpts): Promise<PhoneElement>;",
  "  /** Append text to the focused field. expectedPackage is required (the app that must be in front). */",
  "  type(text: string, opts: { expectedPackage: string }): Promise<any>;",
  "  setValue(el: PhoneElement, value: string): Promise<any>;",
  "  scroll(direction?: 'down' | 'up' | 'left' | 'right', amount?: number): Promise<any>;",
  "  /** Read a scrolling list: collect labels, scroll, repeat until nothing new. Unique keys in first-seen order. */",
  "  scrollCollect(opts?: PhoneReadOpts & { maxScrolls?: number; amount?: number; settleMs?: number; key?: (el: PhoneElement) => string | null; filter?: (el: PhoneElement) => boolean }): Promise<string[]>;",
  "  press(key: 'back' | 'home' | 'recents' | 'notifications' | 'quickSettings' | 'lockScreen'): Promise<any>;",
  "  back(): Promise<any>;",
  "  home(): Promise<any>;",
  "  /** Launch an app by Android package name (e.g. com.google.android.calendar). */",
  "  launch(packageName: string): Promise<any>;",
  "  /** Wait for text/regex/predicate to appear (string matchers poll on the phone: cheap). Returns the element; throws code 'timeout'. */",
  "  waitForText(matcher: PhoneMatcher, opts?: PhoneReadOpts & { timeoutMs?: number; intervalMs?: number; package?: string; poll?: boolean }): Promise<PhoneElement | null>;",
  "  waitForPackage(pkg: string, timeoutMs?: number): Promise<true>;",
  "  /** The Knowhow mobile app's in-app browser (browser_* tools): separate from the user's own tabs. */",
  "  browser: { call(tool: string, args?: Record<string, any>): Promise<any>; navigate(url: string): Promise<any>; read(args?: Record<string, any>): Promise<any>; query(args?: Record<string, any>): Promise<any> };",
  "  /** Pin which attached worker to use when several are attached (index of worker_<i>_). */",
  "  use(o: { companion?: number; browser?: number }): void;",
  "  available(): { companion: boolean; browser: boolean };",
  "};",
];
