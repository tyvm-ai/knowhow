import type { BaseControl, ProcessDocument } from "../types";
import type { Channel, ChannelContext, OutputPolicy } from "./Channel";

/** Output-only channel: implement `publish`. Never changes state. */
export abstract class OutputChannel<S = any, C extends BaseControl = BaseControl, E = any>
  implements Channel<S, C, E>
{
  abstract readonly id: string;
  readonly direction: "out" | "duplex" = "out";
  policy?: OutputPolicy;
  protected ctx?: ChannelContext<S, C, E>;

  async start(ctx: ChannelContext<S, C, E>): Promise<void> {
    this.ctx = ctx;
  }
  abstract publish(doc: ProcessDocument<S, C>, events: E[]): Promise<void>;
  async stop(): Promise<void> {}
}

/**
 * Input-only channel: in `onStart` watch your medium and call
 * `ctx.applyControl(...)` / `ctx.deliver(...)`. YOU translate the medium's
 * vocabulary into typed control and decide whether unknown values are errors
 * or ignored; the process does no schema validation.
 */
export abstract class InputChannel<S = any, C extends BaseControl = BaseControl, E = any>
  implements Channel<S, C, E>
{
  abstract readonly id: string;
  readonly direction = "in" as const;
  protected ctx!: ChannelContext<S, C, E>;

  async start(ctx: ChannelContext<S, C, E>): Promise<void> {
    this.ctx = ctx;
    await this.onStart();
  }
  protected abstract onStart(): void | Promise<void>;
  async stop(): Promise<void> {}
}

/** Both: `publish` plus an input side started in `onStart`. */
export abstract class DuplexChannel<S = any, C extends BaseControl = BaseControl, E = any>
  implements Channel<S, C, E>
{
  abstract readonly id: string;
  readonly direction = "duplex" as const;
  policy?: OutputPolicy;
  protected ctx!: ChannelContext<S, C, E>;

  async start(ctx: ChannelContext<S, C, E>): Promise<void> {
    this.ctx = ctx;
    await this.onStart();
  }
  protected onStart(): void | Promise<void> {}
  abstract publish(doc: ProcessDocument<S, C>, events: E[]): Promise<void>;
  async stop(): Promise<void> {}
}
