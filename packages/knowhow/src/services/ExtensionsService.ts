export interface ModuleExtension {
  type: string;
  [key: string]: unknown;
}

export interface RegisteredExtension extends ModuleExtension {
  owner: string;
}

export interface ExtensionPointOptions<T extends ModuleExtension> {
  /**
   * Called before an extension of this type is registered. Return a string (or
   * throw) to reject it; return nothing to accept. `existing` is the list of
   * already-registered extensions of this type.
   */
  validate?(ext: T, existing: readonly T[]): string | void;
}

export interface OnRegisterOptions {
  /**
   * When true, the callback is also invoked (synchronously, in registration
   * order) for every extension of this type that was registered BEFORE the
   * subscription. Default: false (only future registrations).
   */
  replay?: boolean;
}

/** Typed handle returned by `ExtensionsService.defineExtensionPoint`. */
export interface ExtensionPoint<T extends ModuleExtension> {
  readonly type: string;
  list(): readonly T[];
  register(owner: string, ext: T): void;
  /** Subscribe to registrations of this type. Returns an unsubscribe function. */
  onRegister(cb: (ext: T, owner: string) => void, opts?: OnRegisterOptions): () => void;
}

type Listener = (ext: any, owner: string) => void;

/** Process-local registry for optional, consumer-defined module capabilities. */
export class ExtensionsService {
  private extensions: RegisteredExtension[] = [];
  private validators = new Map<string, (ext: any, existing: readonly any[]) => string | void>();
  private listeners = new Map<string, Set<Listener>>();

  /**
   * Register an extension. If an extension point with a validator was defined
   * for `extension.type`, it is validated first; a failure throws an Error
   * naming the owner and type and the extension is NOT registered.
   */
  register(owner: string, extension: ModuleExtension): void {
    const validate = this.validators.get(extension.type);
    if (validate) {
      let problem: string | void;
      try {
        problem = validate(extension, this.list(extension.type));
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err);
      }
      if (typeof problem === "string" && problem) {
        throw new Error(
          `Invalid "${extension.type}" extension from "${owner}": ${problem}`
        );
      }
    }

    const registered: RegisteredExtension = { ...extension, owner };
    this.extensions.push(registered);

    for (const cb of Array.from(this.listeners.get(extension.type) ?? [])) {
      try {
        cb(registered, owner);
      } catch (err) {
        console.warn(
          `Extension listener for "${extension.type}" threw:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  list<T extends ModuleExtension>(type: T["type"]): readonly T[] {
    return this.extensions.filter((item) => item.type === type) as unknown as readonly T[];
  }

  removeOwner(owner: string): void {
    this.extensions = this.extensions.filter((item) => item.owner !== owner);
  }

  /**
   * Declare a typed extension point. Safe to call repeatedly for the same
   * `type` (e.g. from several modules): the latest `validate` wins, and
   * omitting `validate` keeps any existing validator.
   */
  defineExtensionPoint<T extends ModuleExtension>(
    type: string,
    options: ExtensionPointOptions<T> = {}
  ): ExtensionPoint<T> {
    if (options.validate) {
      this.validators.set(type, options.validate as any);
    }
    return {
      type,
      list: () => this.list<T>(type),
      register: (owner, ext) => this.register(owner, ext),
      onRegister: (cb, opts = {}) => {
        let set = this.listeners.get(type);
        if (!set) {
          set = new Set();
          this.listeners.set(type, set);
        }
        set.add(cb as Listener);
        if (opts.replay) {
          for (const existing of this.extensions.filter((e) => e.type === type)) {
            cb(existing as unknown as T, existing.owner);
          }
        }
        return () => {
          set!.delete(cb as Listener);
        };
      },
    };
  }
}
