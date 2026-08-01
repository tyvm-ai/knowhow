import * as fs from "fs";
import { ComputerUseService, MouseButton } from "@tyvm/knowhow";

/**
 * A single macro step. This is the shorthand automation format — a JSON/YAML
 * list of steps executed in ONE process, so an agent (or a saved demo script)
 * can run a smooth sequence without paying ~640ms of CLI startup per action.
 *
 * It is deliberately a small, declarative vocabulary (a portable AutoHotKey-ish
 * layer). For richer logic (loops, other agents, conditionals) use the trusted
 * tsx script runner instead — this format is the "line-of-commands" tier.
 */
export type MacroStep =
  | { action: "move"; x: number; y: number }
  | { action: "click"; button?: MouseButton; double?: boolean }
  | { action: "clickAt"; x: number; y: number; button?: MouseButton; double?: boolean }
  | { action: "drag"; fromX: number; fromY: number; toX: number; toY: number; button?: MouseButton }
  | { action: "scroll"; dx?: number; dy?: number; repeat?: number; intervalMs?: number }
  | { action: "type"; text: string }
  | { action: "key"; key: string }
  | { action: "hotkey"; keys: string[] }
  | { action: "focus"; match: string }
  | { action: "sleep"; ms: number }
  | { action: "screenshot"; out?: string; displayId?: number; grid?: boolean }
  | { action: "log"; message: string };

export interface MacroResult {
  step: number;
  action: string;
  ok: boolean;
  detail?: string;
}

/**
 * Parse a macro file (.json or .yaml/.yml) into steps. YAML is parsed only if
 * `js-yaml` is available; otherwise JSON is assumed. Both a bare array and a
 * `{ steps: [...] }` wrapper are accepted.
 */
export function parseMacroFile(path: string): MacroStep[] {
  const raw = fs.readFileSync(path, "utf8");
  return parseMacro(raw, path.toLowerCase().endsWith(".json") ? "json" : "auto");
}

export function parseMacro(raw: string, format: "json" | "yaml" | "auto" = "auto"): MacroStep[] {
  let data: any;
  const tryYaml = () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const yaml = require("js-yaml");
      return yaml.load(raw);
    } catch {
      return undefined;
    }
  };
  if (format === "json") {
    data = JSON.parse(raw);
  } else if (format === "yaml") {
    data = tryYaml();
  } else {
    // auto: try JSON first (a superset of our needs), then YAML.
    try {
      data = JSON.parse(raw);
    } catch {
      data = tryYaml();
    }
  }
  if (!data) {
    throw new Error(
      "Could not parse macro file. Provide JSON, or install js-yaml for YAML."
    );
  }
  const steps = Array.isArray(data) ? data : data.steps;
  if (!Array.isArray(steps)) {
    throw new Error("Macro must be an array of steps or { steps: [...] }.");
  }
  return steps as MacroStep[];
}

/**
 * Execute a list of macro steps against the ComputerUse service, in order, in a
 * single process. Returns a per-step result log. By default it stops on the
 * first error; pass `continueOnError` to run best-effort.
 */
export async function runMacro(
  svc: ComputerUseService,
  steps: MacroStep[],
  opts?: {
    continueOnError?: boolean;
    onStep?: (r: MacroResult) => void;
    defaultStepDelayMs?: number;
  }
): Promise<MacroResult[]> {
  const results: MacroResult[] = [];
  const stepDelay = opts?.defaultStepDelayMs ?? 0;
  const anySvc = svc as any;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const rec = (ok: boolean, detail?: string) => {
      const r: MacroResult = { step: i, action: (step as any).action, ok, detail };
      results.push(r);
      opts?.onStep?.(r);
      return r;
    };
    try {
      switch (step.action) {
        case "move":
          await svc.moveMouse({ x: step.x, y: step.y });
          rec(true, `(${step.x}, ${step.y})`);
          break;
        case "click":
          await svc.click(step.button ?? "left", { double: !!step.double });
          rec(true, `${step.button ?? "left"}${step.double ? " x2" : ""}`);
          break;
        case "clickAt":
          await svc.moveMouse({ x: step.x, y: step.y });
          await svc.click(step.button ?? "left", { double: !!step.double });
          rec(true, `${step.button ?? "left"} @ (${step.x}, ${step.y})`);
          break;
        case "drag":
          await svc.drag(
            { x: step.fromX, y: step.fromY },
            { x: step.toX, y: step.toY },
            { button: step.button }
          );
          rec(true, `(${step.fromX},${step.fromY})->(${step.toX},${step.toY})`);
          break;
        case "scroll": {
          const dx = step.dx ?? 0;
          const dy = step.dy ?? 0;
          if (typeof anySvc.scrollBy === "function") {
            await anySvc.scrollBy(dx, dy, {
              repeat: step.repeat,
              intervalMs: step.intervalMs,
            });
          } else {
            const repeat = Math.max(1, Math.round(step.repeat ?? 1));
            for (let k = 0; k < repeat; k++) {
              await svc.scroll(dx, dy);
              if (step.intervalMs && k < repeat - 1) {
                await sleep(step.intervalMs);
              }
            }
          }
          rec(true, `dx=${dx} dy=${dy} x${step.repeat ?? 1}`);
          break;
        }
        case "type":
          await svc.typeText(step.text);
          rec(true, `${step.text.length} chars`);
          break;
        case "key":
          await svc.pressKey(step.key);
          rec(true, step.key);
          break;
        case "hotkey":
          await svc.hotkey(...step.keys);
          rec(true, step.keys.join("+"));
          break;
        case "focus": {
          const ok = await svc.focusWindow(step.match);
          rec(ok, step.match);
          break;
        }
        case "sleep":
          await sleep(step.ms);
          rec(true, `${step.ms}ms`);
          break;
        case "screenshot": {
          const shotOpts =
            step.displayId !== undefined ? { displayId: step.displayId } : undefined;
          let buf: Buffer;
          if (step.grid && typeof anySvc.screenshotAnnotated === "function") {
            buf = await anySvc.screenshotAnnotated({ ...shotOpts, grid: true });
          } else {
            buf = await svc.screenshot(shotOpts);
          }
          if (step.out) {
            fs.writeFileSync(step.out, buf);
            rec(true, `${step.out} (${buf.length}b)`);
          } else {
            rec(true, `${buf.length}b`);
          }
          break;
        }
        case "log":
          rec(true, step.message);
          break;
        default:
          rec(false, `unknown action: ${(step as any).action}`);
      }
    } catch (e: any) {
      rec(false, e?.message || String(e));
      if (!opts?.continueOnError) break;
    }
    if (stepDelay) await sleep(stepDelay);
  }
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
