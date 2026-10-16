/**
 * RecoveryEngine — the ONE recovery policy.
 *
 *   rewrite + learned key / high confidence / trusted app in front → run it
 *   rewrite otherwise                                              → ask "did you mean …?" (pending store)
 *   latch                                                          → wait for the next utterance
 *   user says "yes"                                                → run it and learn it (learned store)
 *
 * `KNOWHOW_VOICE_INFER=auto|confirm|off` overrides the run/ask decision for every recoverer.
 * No VoiceSession dependency: the caller passes `run(text)` for dispatching a rewritten command.
 */

import { ConfigResolver, RECOVERY_SERVICE_CONFIG, getDefaultConfig } from "../config";
import { normaliseTranscript } from "../grammar/normalise";
import type { VoiceServices } from "../services";
import type { PendingAction } from "../services/pending";
import type { IntentRecoverer, RecoveryContext, RecoveryInput, RewriteResult } from "./types";

export type InferPolicy = "auto" | "confirm" | "off";

export function inferPolicy(source?: NodeJS.ProcessEnv | ConfigResolver): InferPolicy | undefined {
  const config =
    source instanceof ConfigResolver
      ? source
      : source
        ? new ConfigResolver({ env: () => source, json: () => ({}) })
        : getDefaultConfig();
  return config.get({ kind: "services", name: "recovery" }, "infer", RECOVERY_SERVICE_CONFIG.infer);
}

/** How long a "did you mean …?" stays answerable. */
export const RECOVERY_CONFIRM_TTL_MS = 20_000;

export type RecoveryOutcome =
  /** Nothing to recover — carry on as usual. */
  | { kind: "none" }
  /** Consumed: a latch was armed or a question is pending. `asked` = the proposed command text, when asking. */
  | { kind: "handled"; asked?: string }
  /** Dispatch `text` instead of the original utterance. */
  | { kind: "rewrite"; text: string; reason: string };

export interface RecoverOptions {
  /** Frontmost app (resolved lazily, only when a guess needs a trust decision). */
  frontApp?: string | (() => Promise<string | undefined>);
  /** Dispatch a command text (used when the user answers "yes"). */
  run(text: string): Promise<void>;
  /** Override the env policy (tests). */
  policy?: InferPolicy;
}

export interface RecoveryEngineOptions {
  recoverers: readonly IntentRecoverer[];
  services: VoiceServices;
  /** Where lines like `[voice] inferred: …` go (default: the services' tagged logger). */
  log?: (line: string) => void;
}

type Decision = { action: "run"; reason: string } | { action: "confirm" } | { action: "ignore" };

export class RecoveryEngine {
  private recoverers: readonly IntentRecoverer[];
  private readonly services: VoiceServices;
  private readonly log: (line: string) => void;
  private initialised = false;

  constructor(opts: RecoveryEngineOptions) {
    this.recoverers = opts.recoverers;
    this.services = opts.services;
    this.log = opts.log ?? ((line) => this.services.log.info(line.replace(/^\[voice\] /, "")));
  }

  /** Add recoverers contributed after construction (third-party packs); a recoverer with an already-known name is skipped. */
  addRecoverers(extra: readonly IntentRecoverer[]): void {
    const known = new Set(this.recoverers.map((r) => r.name));
    const fresh = extra.filter((r) => !known.has(r.name));
    if (!fresh.length) return;
    this.recoverers = [...this.recoverers, ...fresh];
    if (this.initialised) {
      for (const r of fresh) for (const key of r.onLearned ? this.services.learned.list(r.name) : []) r.onLearned!(key);
    }
  }

  /** Let each recoverer apply what was learned in earlier sessions. Idempotent. */
  init(): void {
    if (this.initialised) return;
    this.initialised = true;
    for (const r of this.recoverers) {
      if (!r.onLearned) continue;
      for (const key of this.services.learned.list(r.name)) r.onLearned(key);
    }
  }

  private context(frontApp?: string): RecoveryContext {
    return { frontApp, learned: this.services.learned, latch: this.services.latch, services: this.services };
  }

  /**
   * Would any (synchronous, unmatched-stage) recoverer do something with `text`?
   * Pure — arms nothing. whisperServer uses it to decide whether the plain
   * (unprompted) transcription is worth handing on.
   */
  canRecover(text: string, alternatives?: string[]): boolean {
    const input: RecoveryInput = { text, normalised: normaliseTranscript(text), alternatives };
    for (const r of this.recoverers) {
      if ((r.stage ?? "unmatched") !== "unmatched") continue;
      try {
        const res = r.recover(input, this.context());
        if (res && !(typeof (res as { then?: unknown }).then === "function")) return true;
      } catch { /* a broken recoverer must not break STT */ }
    }
    return false;
  }

  async recover(input: RecoveryInput, opts: RecoverOptions): Promise<RecoveryOutcome> {
    const stage = input.match ? "matched" : "unmatched";
    const policy = opts.policy ?? inferPolicy(this.services.config);
    const { latch, learned } = this.services;

    // A latch armed by an earlier utterance ("tmux" … "left").
    if (stage === "unmatched") {
      const done = latch.tryComplete(input.text);
      if (done) {
        this.log(`[voice] inferred: "${input.text}" → "${done.text}" (follow-up to ${done.owner})`);
        return { kind: "rewrite", text: done.text, reason: `follow-up to ${done.owner}` };
      }
    }

    for (const r of this.recoverers) {
      if ((r.stage ?? "unmatched") !== stage) continue;
      let res;
      try {
        res = await r.recover(input, this.context(typeof opts.frontApp === "string" ? opts.frontApp : undefined));
      } catch (err) {
        this.log(`[voice] recoverer "${r.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!res) continue;
      if (res.kind === "latch") {
        latch.arm(r.name, res.ttlMs, res.complete);
        if (res.message) this.log(res.message);
        return { kind: "handled" };
      }
      const decision = await this.decide(r, res, policy, opts.frontApp);
      if (decision.action === "ignore") continue;
      if (decision.action === "run") {
        this.log(`[voice] inferred: "${input.text}" → "${res.text}" (${decision.reason}, ${res.confidence})`);
        return { kind: "rewrite", text: res.text, reason: decision.reason };
      }
      this.ask(r, res, input, opts);
      return { kind: "handled", asked: res.text };
    }
    return { kind: "none" };
  }

  private async decide(
    r: IntentRecoverer,
    res: RewriteResult,
    policy: InferPolicy | undefined,
    frontApp: RecoverOptions["frontApp"],
  ): Promise<Decision> {
    if (policy === "off") return { action: "ignore" };
    if (policy === "auto") return { action: "run", reason: "policy" };
    if (policy === "confirm") return { action: "confirm" };
    if (res.learnKey && this.services.learned.has(r.name, res.learnKey)) return { action: "run", reason: "learned" };
    if (res.confidence === "high") return { action: "run", reason: "high confidence" };
    if (r.trustedContext?.apps) {
      const app = typeof frontApp === "function" ? await frontApp().catch(() => undefined) : frontApp;
      if (app && appMatches(r.trustedContext.apps, app)) return { action: "run", reason: `frontmost ${app}` };
    }
    return { action: "confirm" };
  }

  private ask(r: IntentRecoverer, res: RewriteResult, input: RecoveryInput, opts: RecoverOptions): void {
    const { pending, clock, learned } = this.services;
    const action: PendingAction = {
      describe: res.describe ?? `${res.text} (heard "${input.text}")`,
      accept: async () => {
        if (res.learnKey) {
          await learned.add(r.name, res.learnKey);
          r.onLearned?.(res.learnKey);
        }
        this.log(`[voice] ok, running "${res.text}"${res.learnKey ? " (remembered for next time)" : ""}`);
        await opts.run(res.text);
      },
      reject: () => {
        this.log(`[voice] ok, not running "${res.text}"`);
        res.onReject?.();
      },
    };
    pending.set(action);
    const timer = clock.setTimeout(() => {
      if (pending.peek() === action) pending.clear();
    }, RECOVERY_CONFIRM_TTL_MS);
    timer.unref?.();
    this.log(`[voice] ${res.prompt ?? `did you mean "${res.text}"? (heard "${input.text}") — say "yes" or "no"`}`);
    res.onAsk?.();
  }
}

export function appMatches(apps: RegExp | string[], app: string): boolean {
  const name = app.trim();
  if (apps instanceof RegExp) return apps.test(name);
  const lower = name.toLowerCase();
  return apps.some((a) => a.toLowerCase() === lower);
}

/** Every recoverer contributed by `packs`, in pack order. */
export function collectRecoverers(packs: ReadonlyArray<{ recoverers?: readonly IntentRecoverer[] }>): IntentRecoverer[] {
  return packs.flatMap((p) => [...(p.recoverers ?? [])]);
}
