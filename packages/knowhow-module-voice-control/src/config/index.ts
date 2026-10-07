export * from "./schema";
export * from "./resolver";
export * from "./services";

import { ConfigResolver } from "./resolver";
import { SERVICE_SCHEMAS } from "./services";

/** Build a resolver that already knows every service's settings. */
export function createConfigResolver(options: ConstructorParameters<typeof ConfigResolver>[0] = {}): ConfigResolver {
  const resolver = new ConfigResolver(options);
  for (const [name, schema] of Object.entries(SERVICE_SCHEMAS)) resolver.register({ kind: "services", name }, schema);
  return resolver;
}

let defaultResolver: ConfigResolver | undefined;

/**
 * Process-wide resolver for code that has no `services` handle (free helpers like `resolveGazeHubUrl()`,
 * `resolveEyePython()`, the default logger). Sessions use `services.config`.
 */
export function getDefaultConfig(): ConfigResolver {
  return (defaultResolver ??= createConfigResolver());
}
