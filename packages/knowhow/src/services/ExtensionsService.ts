export interface ModuleExtension {
  type: string;
  [key: string]: unknown;
}

interface RegisteredExtension extends ModuleExtension {
  owner: string;
}

/** Process-local registry for optional, consumer-defined module capabilities. */
export class ExtensionsService {
  private extensions: RegisteredExtension[] = [];

  register(owner: string, extension: ModuleExtension): void {
    this.extensions.push({ ...extension, owner });
  }

  list<T extends ModuleExtension>(type: T["type"]): readonly T[] {
    return this.extensions.filter((item) => item.type === type) as unknown as readonly T[];
  }

  removeOwner(owner: string): void {
    this.extensions = this.extensions.filter((item) => item.owner !== owner);
  }
}
