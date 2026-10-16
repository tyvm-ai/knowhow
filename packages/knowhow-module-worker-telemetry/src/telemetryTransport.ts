/** Minimal TunnelHandler interface needed to register addons. */
export type TunnelHandlerLike = {
  use(addon: {
    name: string;
    handles: string[];
    onMessage(...args: unknown[]): unknown;
  }): unknown;
  readonly readyState?: number;
};

export type TelemetryTransport = {
  readonly generation: number;
  readonly bufferedAmount: number;
  readonly writable: boolean;
  send(message: Record<string, unknown>): boolean;
  subscribe(
    messageTypes: readonly string[],
    listener: (message: Record<string, unknown>) => void | Promise<void>
  ): () => void;
};

export type InitParams = {
  config: unknown;
  cwd: string;
  context?: {
    Events?: {
      log?: (scope: string, message: string, level?: string) => void;
    };
    Tunnel?: TunnelHandlerLike;
    [key: string]: unknown;
  };
};

export type KnowhowModule = {
  init: (params: InitParams) => Promise<void>;
  destroy?: (params: InitParams) => Promise<void>;
  tools: unknown[];
  agents: unknown[];
  plugins: unknown[];
  clients: unknown[];
  commands: unknown[];
};
