import { Form } from "./Form";
import type { GuiBackend, WindowSpec } from "./types";

export interface GuiServiceOptions {
  log: (data: Record<string, unknown>) => void;
  /** Lifetime hooks: retain("gui") on create, release on destroy. */
  retain: () => symbol;
  release: (token: symbol) => void;
  /** closeBehavior "exit". */
  exit: () => void;
}

let windowSeq = 0;

/** Per-run factory behind `sdk.gui`: creates forms and destroys them on exit. */
export class GuiService {
  private forms = new Map<Form, symbol>();

  constructor(readonly backend: GuiBackend, private opts: GuiServiceOptions) {}

  /** Create a (hidden) form. Retains the automation until the form is destroyed. */
  async form(spec: WindowSpec): Promise<Form> {
    const windowId = `w${++windowSeq}`;
    const token = this.opts.retain();
    try {
      const form = await Form.create(windowId, spec, this.backend, {
        log: this.opts.log,
        onExit: this.opts.exit,
        onDestroyed: (f) => {
          const t = this.forms.get(f);
          this.forms.delete(f);
          if (t) this.opts.release(t);
        },
      });
      this.forms.set(form, token);
      return form;
    } catch (e) {
      this.opts.release(token);
      throw e;
    }
  }

  /** Number of live forms. */
  get count(): number {
    return this.forms.size;
  }

  /** Destroy every form (runner exit). */
  destroyAll(): void {
    for (const form of [...this.forms.keys()]) {
      try {
        form.destroy();
      } catch (e: any) {
        this.opts.log({ guiError: "destroyAll", error: e?.message ?? String(e) });
      }
    }
  }
}
