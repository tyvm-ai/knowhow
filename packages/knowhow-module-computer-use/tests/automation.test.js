const {
  AutomationRunner,
  validateScript,
  saveAutomation,
  loadAutomationSafe,
  deleteAutomation,
  parseAutomationDoc,
} = require("../ts_build/automation");

/**
 * A minimal fake ComputerService that satisfies the surface the AutomationSDK
 * uses. It records every action and lets a test drive perception + the active
 * window title so we can exercise the loop, dry-run, and window-gating without
 * touching a real screen/mouse.
 */
function makeFakeService(overrides = {}) {
  const state = {
    clicks: [],
    moves: [],
    drags: [],
    typed: [],
    keys: [],
    focused: [],
    accessibilitySelections: [],
    accessibilityValues: [],
    accessibilityActions: [],
    activeTitle: "Mouse Precision — Chrome",
    overlays: [],
    overlayClears: 0,
    activeApp: "Google Chrome",
    ocrWindows: [],
    colorResults: [
      [{ color: "ff4444", center: { x: 100, y: 200 }, bounds: {}, sampledPixels: 50 }],
    ],
    colorIdx: 0,
  };
  const svc = {
    _state: state,
    async screenSize() {
      return { width: 1920, height: 1080 };
    },
    async getActiveWindow() {
      return { title: state.activeTitle, app: state.activeApp };
    },
    async readText() { state.ocrWindows.push(state.activeTitle); return []; },
    async findColorRegions() {
      const i = Math.min(state.colorIdx, state.colorResults.length - 1);
      state.colorIdx++;
      return state.colorResults[i];
    },
    async findShapes() {
      return [];
    },
    async findBoxes() {
      return [];
    },
    async pixelColor() {
      return "ffffff";
    },
    async moveMouse(p) {
      state.moves.push(p);
    },
    async click(button) {
      state.clicks.push({ button, at: state.moves[state.moves.length - 1] });
    },
    async drag(from, to, opts) {
      state.drags.push({ from, to, opts });
    },
    async typeText(t) {
      state.typed.push(t);
    },
    async pressKey(k) {
      state.keys.push(k);
    },
    async focusWindow(match) {
      state.focused.push(match);
      return true;
    },
    async accessibilityTrusted() {
      return true;
    },
    async accessibilityElements() {
      return [{
        id: "ax-1", role: "AXTextField", title: "First name",
        value: "", actions: [], childCount: 0,
      }];
    },
    async selectAccessibilityOption(id, option) {
      state.accessibilitySelections.push({ id, option });
    },
    async setAccessibilityValue(id, value) {
      state.accessibilityValues.push({ id, value });
    },
    async performAccessibilityAction(id, action) {
      state.accessibilityActions.push({ id, action });
    },
    async showOverlay(primitives) {
      state.overlays.push(primitives);
    },
    async clearOverlay() {
      state.overlayClears++;
    },
  };
  return Object.assign(svc, overrides);
}

describe("automation script sandbox", () => {
  test("rejects require()", () => {
    expect(() => validateScript("const x = require('fs');")).toThrow();
  });
  test("rejects fetch()", () => {
    expect(() => validateScript("await fetch('http://evil');")).toThrow();
  });
  test("allows a plain sdk-only script", () => {
    expect(() =>
      validateScript(
        "const t = await sdk.findColor(['ff0000']); await sdk.clickAt(1,2);"
      )
    ).not.toThrow();
  });
  test("allows the editor-only sdk import", () => {
    expect(() =>
      validateScript(
        `import { sdk } from "@tyvm/knowhow-module-computer-use";\nawait sdk.sleep(1);`
      )
    ).not.toThrow();
  });
  test("continues to reject other imports", () => {
    expect(() => validateScript(`import { x } from "somewhere";`)).toThrow();
  });
});

describe("AutomationRunner", () => {
  test("runs the perception->action loop live and performs real clicks", async () => {
    const svc = makeFakeService();
    const spec = {
      name: "__test_basic",
      script: `
        let n = 0;
        while (!sdk.ctl.stopped && n < 3) {
          const hits = await sdk.findColor(['ff4444']);
          if (hits[0]) { await sdk.clickAt(hits[0].center.x, hits[0].center.y); }
          n++;
          await sdk.sleep(1);
        }
        sdk.log({ done: n });
      `,
    };
    const runner = new AutomationRunner(spec, svc, { maxDurationMs: 5000 });
    const result = await runner.run();
    expect(result.stopped).toBe("completed");
    expect(svc._state.clicks.length).toBe(3);
    expect(result.actionCount).toBe(3);
    expect(result.actions.every((a) => !a.suppressed)).toBe(true);
    const lastLog = result.logs[result.logs.length - 1];
    expect(lastLog.data.done).toBe(3);
  });

  test("forwards drag gestures and records their complete telemetry", async () => {
    const svc = makeFakeService();
    const result = await new AutomationRunner(
      {
        name: "__test_drag",
        script: `await sdk.dragMouse(10, 20, 30, 40, { button: "right", duration: 35 });`,
      },
      svc,
      { maxDurationMs: 5000 }
    ).run();

    expect(svc._state.drags).toEqual([{
      from: { x: 10, y: 20 },
      to: { x: 30, y: 40 },
      opts: { button: "right", duration: 35 },
    }]);
    expect(result.actions[0]).toMatchObject({
      kind: "dragMouse", x: 10, y: 20, x2: 30, y2: 40,
      button: "right", duration: 35, suppressed: false,
    });
  });

  test("suppresses drag gestures during a dry run", async () => {
    const svc = makeFakeService();
    const result = await new AutomationRunner(
      { name: "__test_drag_dry", script: `await sdk.dragMouse(1, 2, 3, 4);` },
      svc,
      { maxDurationMs: 5000, dryRun: true }
    ).run();

    expect(svc._state.drags).toEqual([]);
    expect(result.actions[0]).toMatchObject({
      kind: "dragMouse", x: 1, y: 2, x2: 3, y2: 4,
      button: "left", suppressed: true,
    });
  });

  test("suppresses drag gestures when the required window loses focus", async () => {
    let windowReads = 0;
    const svc = makeFakeService({
      async getActiveWindow() {
        windowReads++;
        return {
          title: windowReads === 1 ? "Fruit Ninja Benchmark" : "Terminal",
          app: windowReads === 1 ? "Google Chrome" : "Terminal",
        };
      },
    });
    const result = await new AutomationRunner(
      {
        name: "__test_drag_gate",
        script: `
          await sdk.runEvery(async () => {
            await sdk.sleep(80);
            await sdk.dragMouse(5, 6, 7, 8, { duration: 15 });
            sdk.ctl.stop();
          }, 0, { requiredWindow: { titleIncludes: "Fruit Ninja" } });
        `,
      },
      svc,
      { maxDurationMs: 500, gatePollMs: 50 }
    ).run();

    expect(svc._state.drags).toEqual([]);
    expect(result.actions[0]).toMatchObject({
      kind: "dragMouse", x: 5, y: 6, x2: 7, y2: 8,
      duration: 15, suppressed: true,
    });
  });

  test("renders overlays live but suppresses them in dry-run", async () => {
    const script = `await sdk.showOverlay([{ kind: "circle", x: 1, y: 2, width: 3, height: 3 }]);`;
    const live = makeFakeService();
    await new AutomationRunner(
      { name: "__test_overlay", script }, live, { maxDurationMs: 5000 }
    ).run();
    expect(live._state.overlays).toEqual([[
      { kind: "circle", x: 1, y: 2, width: 3, height: 3 },
    ]]);

    const dry = makeFakeService();
    await new AutomationRunner(
      { name: "__test_overlay_dry", script }, dry,
      { maxDurationMs: 5000, dryRun: true }
    ).run();
    expect(dry._state.overlays).toEqual([]);
  });

  test("allows overlay cleanup during dry-run", async () => {
    const svc = makeFakeService();
    await new AutomationRunner(
      { name: "__test_overlay_clear", script: `await sdk.clearOverlay();` },
      svc,
      { maxDurationMs: 5000, dryRun: true }
    ).run();
    expect(svc._state.overlayClears).toBe(1);
  });

  test("dry-run records intended actions but performs none", async () => {
    const svc = makeFakeService();
    const spec = {
      name: "__test_dry",
      script: `
        let n = 0;
        while (!sdk.ctl.stopped && n < 2) {
          await sdk.clickAt(10 + n, 20 + n);
          n++;
          await sdk.sleep(1);
        }
      `,
    };
    const runner = new AutomationRunner(spec, svc, {
      maxDurationMs: 5000,
      dryRun: true,
    });
    const result = await runner.run();
    expect(result.dryRun).toBe(true);
    expect(svc._state.clicks.length).toBe(0);
    expect(result.actionCount).toBe(2);
    expect(result.actions.every((a) => a.suppressed)).toBe(true);
  });

  test("focuses before a gate live, but suppresses focus in dry-run", async () => {
    const script = `await sdk.focus("Google Chrome");`;
    const live = makeFakeService();
    const liveResult = await new AutomationRunner(
      { name: "__test_focus", script }, live, { maxDurationMs: 5000 }
    ).run();
    expect(live._state.focused).toEqual(["Google Chrome"]);
    expect(liveResult.actions[0]).toMatchObject({ kind: "focus", suppressed: false });

    const dry = makeFakeService();
    const dryResult = await new AutomationRunner(
      { name: "__test_focus_dry", script }, dry, { maxDurationMs: 5000, dryRun: true }
    ).run();
    expect(dry._state.focused).toEqual([]);
    expect(dryResult.actions[0]).toMatchObject({ kind: "focus", suppressed: true });
  });

  test("discovers and operates accessibility elements live", async () => {
    const svc = makeFakeService();
    const script = `
      const trusted = await sdk.accessibilityTrusted();
      const elements = await sdk.accessibilityElements({ interactiveOnly: true });
      await sdk.selectAccessibilityOption(elements[0].id, "Alabama");
      await sdk.setAccessibilityValue(elements[0].id, "Mia");
      await sdk.performAccessibilityAction(elements[0].id, "AXConfirm");
      sdk.log({ trusted });
    `;
    const result = await new AutomationRunner(
      { name: "__test_accessibility", script }, svc, { maxDurationMs: 5000 }
    ).run();
    expect(svc._state.accessibilitySelections).toEqual([{ id: "ax-1", option: "Alabama" }]);
    expect(svc._state.accessibilityValues).toEqual([{ id: "ax-1", value: "Mia" }]);
    expect(svc._state.accessibilityActions).toEqual([{ id: "ax-1", action: "AXConfirm" }]);
    expect(result.actions.map((a) => a.kind)).toEqual([
      "selectAccessibilityOption",
      "setAccessibilityValue", "performAccessibilityAction",
    ]);
    expect(result.logs[0].data).toEqual({ trusted: true });
  });

  test("accessibility reads remain live but mutations are suppressed in dry-run", async () => {
    const svc = makeFakeService();
    const script = `
      const elements = await sdk.accessibilityElements();
      sdk.log({ discovered: elements.length });
      await sdk.setAccessibilityValue(elements[0].id, "Mia");
      await sdk.performAccessibilityAction(elements[0].id, "AXPress");
    `;
    const result = await new AutomationRunner(
      { name: "__test_accessibility_dry", script }, svc,
      { maxDurationMs: 5000, dryRun: true }
    ).run();
    expect(result.logs[0].data).toEqual({ discovered: 1 });
    expect(svc._state.accessibilityValues).toEqual([]);
    expect(svc._state.accessibilityActions).toEqual([]);
    expect(result.actions.every((a) => a.suppressed)).toBe(true);
  });

  test("suppresses accessibility mutations while the required-window gate is paused", async () => {
    const svc = makeFakeService();
    svc._state.activeTitle = "Some Other App";
    const script = `
      await sdk.requiredWindow({ titleIncludes: "Form Master" });
      await sdk.setAccessibilityValue("ax-1", "Mia");
      await sdk.performAccessibilityAction("ax-1", "AXPress");
    `;
    const result = await new AutomationRunner(
      { name: "__test_accessibility_gate", script }, svc, { maxDurationMs: 5000 }
    ).run();

    expect(svc._state.accessibilityValues).toEqual([]);
    expect(svc._state.accessibilityActions).toEqual([]);
    expect(result.actions).toHaveLength(2);
    expect(result.actions.every((action) => action.suppressed)).toBe(true);
  });

  test("auto-pauses (suppresses actions) when the required window loses focus", async () => {
    const svc = makeFakeService();
    svc._state.activeTitle = "Some Other App";
    const spec = {
      name: "__test_gate",
      script: `
        await sdk.requiredWindow({ titleIncludes: "Mouse Precision" });
        let n = 0;
        while (!sdk.ctl.stopped && n < 3) {
          await sdk.clickAt(5, 5);
          n++;
          await sdk.sleep(5);
        }
      `,
    };
    const runner = new AutomationRunner(spec, svc, {
      maxDurationMs: 5000,
      gatePollMs: 50,
    });
    const result = await runner.run();
    expect(svc._state.clicks.length).toBe(0);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.actions.every((a) => a.suppressed)).toBe(true);
  });

  test("runEvery does not invoke perception callbacks until its target window is focused", async () => {
    const svc = makeFakeService();
    svc._state.activeTitle = "knowhow:4:cli";
    svc._state.activeApp = "Ghostty";
    const switchToWrongChromeWindow = setTimeout(() => {
      svc._state.activeTitle = "Unrelated tab";
      svc._state.activeApp = "Google Chrome";
    }, 40);
    const switchToTarget = setTimeout(() => {
      svc._state.activeTitle = "Form Master Benchmark";
      svc._state.activeApp = "Google Chrome";
    }, 100);
    const spec = {
      name: "__test_perception_gate",
      script: `
        await sdk.runEvery(async () => {
          await sdk.readText();
          sdk.ctl.stop();
        }, 0, { requiredWindow: {
          app: "Google Chrome", titleIncludes: "Form Master Benchmark"
        }});
      `,
    };
    const result = await new AutomationRunner(spec, svc, {
      maxDurationMs: 2000,
      gatePollMs: 20,
    }).run();
    clearTimeout(switchToTarget);
    clearTimeout(switchToWrongChromeWindow);

    expect(result.stopped).toBe("manual");
    expect(svc._state.ocrWindows).toEqual(["Form Master Benchmark"]);
    expect(result.logs.some((entry) => entry.data.paused === "window-focus-lost")).toBe(true);
    expect(result.logs.some((entry) => entry.data.resumed === true)).toBe(true);
  });

  test("reports a manual stop when sdk.ctl.stop() is called", async () => {
    const svc = makeFakeService();
    const spec = {
      name: "__test_stop",
      script: `
        let n = 0;
        while (!sdk.ctl.stopped) {
          n++;
          if (n >= 2) sdk.ctl.stop();
          await sdk.sleep(1);
        }
      `,
    };
    const runner = new AutomationRunner(spec, svc, { maxDurationMs: 5000 });
    const result = await runner.run();
    expect(result.stopped).toBe("manual");
  });

  test("runEvery repeats only its callback at the requested interval (ms)", async () => {
    const svc = makeFakeService();
    const spec = {
      name: "__test_run_every",
      script: `
        import { sdk } from "@tyvm/knowhow-module-computer-use";
        let setupRuns = 0;
        let callbackRuns = 0;
        setupRuns++;
        async function clickShapes() {
          callbackRuns++;
          if (callbackRuns === 3) sdk.ctl.stop();
        }
        await sdk.runEvery(clickShapes, 120);
        sdk.log({ setupRuns, callbackRuns });
      `,
    };
    const result = await new AutomationRunner(spec, svc, {
      maxDurationMs: 5000,
    }).run();
    expect(result.stopped).toBe("manual");
    expect(result.logs[result.logs.length - 1].data).toEqual({
      setupRuns: 1,
      callbackRuns: 3,
    });
  });

  test("a hot runEvery loop still lets external timers fire (so /poke stays responsive)", async () => {
    // Regression for: an automation whose per-iteration callback overruns its
    // interval budget used to yield with setImmediate, which starves the event
    // loop's timers phase — exactly where the /poke input watcher's setInterval
    // (and the agent's interrupt handling) lives. With a real setTimeout(0)
    // yield, concurrent timers must still get to run while the loop runs hot.
    const svc = makeFakeService();

    // Simulate the /poke watcher: an independent timer that ticks every 10ms
    // and, after a few ticks, "interrupts" the automation by stopping it.
    let watcherTicks = 0;
    let runnerRef = null;
    const watcher = setInterval(() => {
      watcherTicks++;
      // After the watcher has demonstrably run several times WHILE the loop is
      // busy, deliver the interrupt (what /poke does via runner.ctl.stop()).
      if (watcherTicks >= 3 && runnerRef) runnerRef.ctl.stop();
    }, 10);

    const spec = {
      name: "__test_hot_loop_timers",
      script: `
        import { sdk } from "@tyvm/knowhow-module-computer-use";
        async function heavyFrame() {
          // Synchronous busy-work that overruns the 120ms interval,
          // mimicking a native screen-capture + shape-detection iteration.
          const until = sdk.now() + 15;
          while (sdk.now() < until) { /* burn CPU */ }
        }
        await sdk.runEvery(heavyFrame, 120);
      `,
    };

    const runner = new AutomationRunner(spec, svc, { maxDurationMs: 5000 });
    runnerRef = runner;
    const result = await runner.run();
    clearInterval(watcher);

    // The watcher timer got CPU time while the loop was hammering the core...
    expect(watcherTicks).toBeGreaterThanOrEqual(3);
    // ...and its stop() actually took effect (i.e. the interrupt was honored),
    // proving /poke would have been delivered rather than starved.
    expect(result.stopped).toBe("manual");
  });

  test("hard-caps maxDurationMs at five minutes", async () => {
    const svc = makeFakeService();
    const spec = {
      name: "__test_cap",
      script: `
        // Loop forever; only the duration cap can stop it.
        while (!sdk.ctl.stopped) { await sdk.sleep(1); }
      `,
    };
    // Stop before running so the test verifies the cap without waiting.
    const runner = new AutomationRunner(spec, svc, { maxDurationMs: 5 * 60 * 1000 });
    runner.ctl.stop();
    const result = await runner.run();
    expect(runner.maxDurationMs).toBe(300000);
    expect(result.elapsedMs).toBeLessThan(1000);
  });

  test("flags a live run that moved the mouse WITHOUT a required-window gate", async () => {
    const svc = makeFakeService();
    const spec = {
      name: "__test_no_gate",
      script: `
        // No sdk.requiredWindow(...) — cannot be reclaimed by clicking away.
        await sdk.clickAt(1, 2);
      `,
    };
    const result = await new AutomationRunner(spec, svc, {
      maxDurationMs: 5000,
    }).run();
    expect(result.ranWithoutWindowGate).toBe(true);
    expect(result.requiredWindow).toBeUndefined();
  });

  test("runEvery accepts an inline requiredWindow that gates the loop", async () => {
    const svc = makeFakeService();
    // Focus is on some OTHER app, so the inline gate must suppress every action.
    svc._state.activeTitle = "Some Other App";
    const spec = {
      name: "__test_run_every_gate",
      script: `
        import { sdk } from "@tyvm/knowhow-module-computer-use";
        let n = 0;
        async function frame() {
          await sdk.clickAt(5, 5);
          if (++n >= 3) sdk.ctl.stop();
        }
        await sdk.runEvery(frame, 120, { requiredWindow: { titleIncludes: "Mouse Precision" } });
      `,
    };
    const result = await new AutomationRunner(spec, svc, {
      maxDurationMs: 5000,
      gatePollMs: 50,
    }).run();
    // The inline gate was configured, so no real clicks happened and it is not
    // flagged as ungated.
    expect(svc._state.clicks.length).toBe(0);
    expect(result.requiredWindow).toEqual({ titleIncludes: "Mouse Precision" });
    expect(result.ranWithoutWindowGate).toBeFalsy();
    expect(result.actions.every((a) => a.suppressed)).toBe(true);
  });
});

describe("automation persistence", () => {
  test("save -> load -> delete round-trips", () => {
    const saved = saveAutomation({
      name: "__test_persist",
      script: "await sdk.runEvery(async () => {}, 120);",
    });
    expect(saved.name).toBe("__test_persist");
    const loaded = loadAutomationSafe("__test_persist");
    expect(loaded.script).toBe("await sdk.runEvery(async () => {}, 120);");
    expect(deleteAutomation("__test_persist")).toBe(true);
    expect(loadAutomationSafe("__test_persist")).toBeUndefined();
  });
});

describe("parseAutomationDoc (discoverable skill header)", () => {
  test("parses JSDoc tags into a skill card", () => {
    const script = [
      "/**",
      " * @description Clicks the target square.",
      " * @useWhen playing the precision game and you want it automated.",
      " * @startState the game is running with a gameBoard region defined.",
      " * @endState the game has been auto-clicked until stopped.",
      " * @window Chrome",
      " */",
      "import { sdk } from '@tyvm/knowhow-module-computer-use';",
      "await sdk.runEvery(async () => {}, 120);",
    ].join("\n");
    const doc = parseAutomationDoc(script);
    expect(doc).toBeDefined();
    expect(doc.description).toBe("Clicks the target square.");
    expect(doc.useWhen).toContain("precision game");
    expect(doc.startState).toContain("gameBoard");
    expect(doc.endState).toContain("auto-clicked");
    expect(doc.window).toBe("Chrome");
  });

  test("supports wrapped multi-line tag text", () => {
    const script = [
      "/**",
      " * @useWhen you are on the settings page",
      " *   and want to toggle every switch off.",
      " */",
      "await sdk.runEvery(async () => {}, 60);",
    ].join("\n");
    const doc = parseAutomationDoc(script);
    expect(doc.useWhen).toBe(
      "you are on the settings page and want to toggle every switch off."
    );
  });

  test("returns undefined when there is no header", () => {
    expect(parseAutomationDoc("const x = 1;")).toBeUndefined();
    expect(parseAutomationDoc("// just a line comment\nconst x = 1;")).toBeUndefined();
  });

  test("saveAutomation attaches the parsed doc and full filePath", () => {
    const script = [
      "/**",
      " * @description round-trip doc test.",
      " * @useWhen verifying save attaches the header.",
      " */",
      "await sdk.runEvery(async () => {}, 120);",
    ].join("\n");
    const saved = saveAutomation({ name: "__test_doc", script });
    expect(saved.doc).toBeDefined();
    expect(saved.doc.useWhen).toContain("verifying save");
    expect(saved.filePath).toContain("__test_doc.ts");
    const loaded = loadAutomationSafe("__test_doc");
    expect(loaded.doc.description).toBe("round-trip doc test.");
    expect(deleteAutomation("__test_doc")).toBe(true);
  });
});
