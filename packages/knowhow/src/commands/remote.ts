import { Command } from "commander";
import { getConfig, updateConfig } from "../config";
import {
  createRemote,
  DEFAULT_API_URL,
  DEFAULT_REMOTE_NAME,
  getConfiguredRemotes,
  registerRemote,
} from "../remotes";

export function addRemoteCommand(program: Command): void {
  const command = program
    .command("remote")
    .description("Manage Knowhow API remotes");

  command
    .command("add")
    .description("Register a Knowhow-compatible backend")
    .argument("<name>", "Remote name")
    .argument("<api-url>", "API base URL")
    .action(async (name: string, apiUrl: string) => {
      const config = await getConfig();
      if (config.remotes?.[name]) {
        throw new Error(`Remote '${name}' already exists.`);
      }
      const remote = createRemote(name, apiUrl);
      registerRemote(config, remote);
      await updateConfig(config);
      console.log(`Added remote '${name}' (${remote.apiUrl}).`);
    });

  command
    .command("use")
    .description("Select the remote used by Knowhow commands in this configuration")
    .argument("<name>", "Remote name")
    .action(async (name: string) => {
      const config = await getConfig();
      const remote = getConfiguredRemotes(config)[name] ??
        (name === DEFAULT_REMOTE_NAME ? createRemote(DEFAULT_REMOTE_NAME, DEFAULT_API_URL) : undefined);
      if (!remote) {
        throw new Error(`Unknown remote '${name}'. Add it with: knowhow remote add ${name} <api-url>`);
      }
      registerRemote(config, remote);
      config.activeRemote = name;
      await updateConfig(config);
      console.log(`Using remote '${name}' (${remote.apiUrl}).`);
    });

  command
    .command("list")
    .alias("ls")
    .description("List configured remotes")
    .action(async () => {
      const config = await getConfig();
      const remotes = { ...getConfiguredRemotes(config) };
      if (!remotes[DEFAULT_REMOTE_NAME]) {
        remotes[DEFAULT_REMOTE_NAME] = createRemote(DEFAULT_REMOTE_NAME, DEFAULT_API_URL);
      }
      for (const [name, remote] of Object.entries(remotes)) {
        const marker = (config.activeRemote ?? DEFAULT_REMOTE_NAME) === name ? "*" : " ";
        console.log(`${marker} ${name}\t${remote.apiUrl}\t${remote.jwtPath}${remote.orgId ? `\t${remote.orgId}` : ""}`);
      }
    });

  command
    .command("get-url")
    .description("Print a remote API URL")
    .argument("[name]", "Remote name")
    .action(async (name?: string) => {
      const config = await getConfig();
      const selectedName = name ?? config.activeRemote ?? DEFAULT_REMOTE_NAME;
      const remote = getConfiguredRemotes(config)[selectedName] ??
        (selectedName === DEFAULT_REMOTE_NAME ? createRemote(DEFAULT_REMOTE_NAME, DEFAULT_API_URL) : undefined);
      if (!remote) throw new Error(`Unknown remote '${selectedName}'.`);
      console.log(remote.apiUrl);
    });
}
