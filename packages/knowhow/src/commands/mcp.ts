import { Command } from "commander";
import { getConfig, updateConfig } from "../config";
import { McpConfig } from "../types";
import * as fs from "fs";
import { KnowhowSimpleClient, KNOWHOW_API_URL } from "../services/KnowhowClient";
import { McpService } from "../services/Mcp";
import http from "../utils/http";

// ──────────────────────────────────────────────────────────────────────────────
// Transport inference helper
// ──────────────────────────────────────────────────────────────────────────────

function inferTransport(opts: {
  url?: string;
  command?: string;
  transport?: string;
}): "http" | "sse" | "stdio" {
  if (opts.transport) return opts.transport as "http" | "sse" | "stdio";
  if (opts.url) {
    if (opts.url.endsWith("/sse") || opts.url.includes("/sse?")) return "sse";
    return "http";
  }
  return "stdio";
}

// ──────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ──────────────────────────────────────────────────────────────────────────────

function formatLocalMcpList(mcps: McpConfig[], statusMap: Record<string, { connected: boolean; toolCount: number; error?: string }> = {}) {
  if (!mcps || mcps.length === 0) {
    console.log("No MCP servers configured locally.");
    return;
  }
  console.log(`\n${"─".repeat(60)}`);
  console.log("  Local MCP Servers");
  console.log(`${"─".repeat(60)}`);
  for (const mcp of mcps) {
    const status = statusMap[mcp.name];
    const transport = inferTransport(mcp);
    const endpoint = mcp.url ? mcp.url : mcp.command ? `${mcp.command} ${(mcp.args || []).join(" ")}`.trim() : "(none)";
    let statusIcon = "○";
    let statusText = "not tested";
    if (status) {
      if (status.connected) {
        statusIcon = "✓";
        statusText = `connected (${status.toolCount} tools)`;
      } else {
        statusIcon = "✗";
        statusText = `failed: ${status.error || "unknown error"}`;
      }
    }
    console.log(`\n  ${statusIcon} ${mcp.name}`);
    console.log(`    transport : ${transport}`);
    console.log(`    endpoint  : ${endpoint}`);
    if (mcp.authorization_token_file) {
      console.log(`    auth file : ${mcp.authorization_token_file}`);
    }
    if (mcp.autoConnect === false) {
      console.log(`    auto-connect: false`);
    }
    if (status) {
      console.log(`    status    : ${statusText}`);
    }
  }
  console.log(`${"─".repeat(60)}\n`);
}

function formatRemoteMcpList(servers: any[]) {
  if (!servers || servers.length === 0) {
    console.log("No remote MCP servers configured for this organisation.");
    return;
  }
  console.log(`\n${"─".repeat(60)}`);
  console.log("  Remote MCP Servers (backend)");
  console.log(`${"─".repeat(60)}`);
  for (const s of servers) {
    const transport = s.url ? (s.url.endsWith("/sse") ? "sse" : "http") : "stdio";
    const endpoint = s.url ? s.url : s.command ? `${s.command} ${(s.args || []).join(" ")}`.trim() : "(none)";
    const enabledIcon = s.enabled !== false ? "✓" : "○";
    console.log(`\n  ${enabledIcon} ${s.name}  (${s.uniqueName})`);
    console.log(`    id        : ${s.id}`);
    console.log(`    transport : ${transport}`);
    console.log(`    endpoint  : ${endpoint}`);
    if (s.url) {
      const proxyUrl = `${KNOWHOW_API_URL}/api/mcp-proxy/${s.id}/mcp`;
      console.log(`    proxy url : ${proxyUrl}`);
    }
    if (s.enabled === false) {
      console.log(`    enabled   : false`);
    }
    if (s.authConfig && typeof s.authConfig === "object") {
      const ac = s.authConfig as Record<string, any>;
      console.log(`    auth type : ${ac.type || "unknown"}`);
      if (ac.type === "basic") {
        console.log(`    username  : secret:${ac.usernameSecretKey || "(not set)"}`);
        console.log(`    password  : secret:${ac.passwordSecretKey || "(not set)"}`);
      } else if (ac.type === "api_key") {
        console.log(`    api key   : secret:${ac.keySecretKey || "(not set)"} (${ac.location || "header"}:${ac.keyName || "?"})`);
      } else if (ac.type === "oauth2_static" || ac.type === "oauth2_dynamic") {
        console.log(`    oauth     : ${ac.tokenUrl || ac.discoveryUrl || "(url not set)"}`);
      }
    }
  }
  console.log(`${"─".repeat(60)}\n`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Test connectivity of local servers
// ──────────────────────────────────────────────────────────────────────────────

async function testLocalConnections(mcps: McpConfig[]): Promise<Record<string, { connected: boolean; toolCount: number; error?: string }>> {
  const results: Record<string, { connected: boolean; toolCount: number; error?: string }> = {};
  const mcpService = new McpService();

  for (const mcp of mcps) {
    try {
      await mcpService.createStdioClients([mcp]);
      await mcpService.connectAutoServers();
      const tools = await mcpService.getTools();
      results[mcp.name] = { connected: true, toolCount: tools.length };
      await mcpService.closeTransports();
      // Reset for next iteration
      (mcpService as any).clients = [];
      (mcpService as any).transports = [];
      (mcpService as any).config = [];
      (mcpService as any).connected = [];
      (mcpService as any).tools = [];
    } catch (err: any) {
      results[mcp.name] = { connected: false, toolCount: 0, error: err.message };
    }
  }
  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main command registrar
// ──────────────────────────────────────────────────────────────────────────────

export function addMcpCommands(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Manage MCP (Model Context Protocol) servers");

  // ── mcp add ────────────────────────────────────────────────────────────────
  mcp
    .command("add <name> [endpoint]")
    .description(
      "Add an MCP server.\n" +
      "  For HTTP/SSE servers:  knowhow mcp add myserver https://example.com/mcp\n" +
      "  For stdio servers:     knowhow mcp add myserver --command npx --args '-y,some-mcp-server'\n" +
      "  Remote (backend):      knowhow mcp add myserver https://example.com/mcp --remote"
    )
    .option("--transport <transport>", "Transport type: http, sse, stdio (auto-detected if omitted)")
    .option("--command <cmd>", "Command to run for stdio servers (e.g. npx)")
    .option("--args <args>", "Comma-separated args for stdio command (e.g. '-y,some-mcp-server')")
    .option("--env <KEY=VALUE...>", "Environment variables for stdio servers (repeatable)", collect, [])
    .option("--header <Header: Value...>", "HTTP headers (stored as authorization_token_file hint)", collect, [])
    .option("--auth-token-file <path>", "Path to file containing the bearer/basic auth token")
    .option("--auth-scheme <scheme>", "Auth scheme: bearer or basic (default: bearer)", "bearer")
    .option("--no-auto-connect", "Do not auto-connect to this server on startup")
    .option("--remote", "Add to the knowhow backend instead of the local config")
    .option("--unique-name <uniqueName>", "Unique name for remote MCP server (defaults to <name>)")
    .option("--secret-mapping <json>", "Secret mapping JSON for remote MCP (e.g. '{\"MY_ENV\": \"secret.name.field\"}')")
    .option("--auth-config <json>", "Auth config JSON for remote MCP (e.g. '{\"type\":\"basic\",\"usernameSecretKey\":\"grafana.username\",\"passwordSecretKey\":\"grafana.password\"}')")
    .action(async (name: string, endpoint: string | undefined, opts: any) => {
      // Build stdioArgs from --command / --args options
      const stdioArgs: string[] = [];
      if (opts.command) {
        stdioArgs.push(opts.command);
        if (opts.args) {
          // Support both comma-separated and space-separated args
          const parsedArgs = opts.args.includes(",")
            ? opts.args.split(",").map((a: string) => a.trim())
            : opts.args.split(" ").map((a: string) => a.trim()).filter(Boolean);
          stdioArgs.push(...parsedArgs);
        }
      }

      const transport = inferTransport({ url: endpoint, command: stdioArgs[0], transport: opts.transport });

      if (opts.remote) {
        await addRemoteMcp(name, endpoint, transport, opts, stdioArgs);
      } else {
        await addLocalMcp(name, endpoint, transport, opts, stdioArgs);
      }
    });

  // ── mcp list ───────────────────────────────────────────────────────────────
  mcp
    .command("list")
    .description("List configured MCP servers")
    .option("--remote", "List MCP servers from the knowhow backend")
    .option("--test", "Test connectivity and show tool counts (local only)")
    .action(async (opts: any) => {
      if (opts.remote) {
        await listRemoteMcps();
      } else {
        await listLocalMcps(opts.test);
      }
    });

  // ── mcp remove ─────────────────────────────────────────────────────────────
  mcp
    .command("remove <name>")
    .description("Remove an MCP server from the local config")
    .option("--remote", "Remove from the knowhow backend instead")
    .action(async (name: string, opts: any) => {
      if (opts.remote) {
        await removeRemoteMcp(name);
      } else {
        await removeLocalMcp(name);
      }
    });

  // ── mcp get ────────────────────────────────────────────────────────────────
  mcp
    .command("get <name>")
    .description("Show details for a specific MCP server")
    .option("--remote", "Look up from the knowhow backend")
    .action(async (name: string, opts: any) => {
      if (opts.remote) {
        await getRemoteMcp(name);
      } else {
        await getLocalMcp(name);
      }
    });

  // ── mcp secrets ────────────────────────────────────────────────────────────
  // ── mcp update ─────────────────────────────────────────────────────────────
  mcp
    .command("update <name>")
    .description("Update a remote MCP server configuration")
    .option("--remote", "Update in the knowhow backend (required)")
    .option("--url <url>", "New URL for the server")
    .option("--auth-config <json>", "New auth config JSON")
    .option("--secret-mapping <json>", "New secret mapping JSON")
    .option("--env <KEY=VALUE...>", "Environment variables (repeatable)", collect, [])
    .option("--enabled <bool>", "Enable or disable (true/false)")
    .action(async (name: string, opts: any) => {
      if (!opts.remote) {
        console.error("✗ mcp update currently only supports --remote. Use mcp remove + mcp add for local updates.");
        process.exit(1);
      }
      await updateRemoteMcp(name, opts);
    });

  mcp
    .command("secrets")
    .description("Manage remote secrets for MCP servers (requires --remote)")
    .option("--list", "List all org secrets")
    .option("--create <name>", "Create a secret with the given name")
    .option("--value <value>", "Value for the secret (used with --create)")
    .option("--value-file <path>", "Read secret value from file (used with --create)")
    .option("--delete <nameOrId>", "Delete a secret by name or id")
    .action(async (opts: any) => {
      if (opts.list) {
        await listRemoteSecrets();
      } else if (opts.create) {
        let value = opts.value;
        if (!value && opts.valueFile) {
          value = fs.readFileSync(opts.valueFile, "utf-8").trim();
        }
        if (!value) {
          console.error("✗ --value or --value-file is required with --create");
          process.exit(1);
        }
        await createRemoteSecret(opts.create, value);
      } else if (opts.delete) {
        await deleteRemoteSecret(opts.delete);
      } else {
        // Default: list
        await listRemoteSecrets();
      }
    });
}

// ──────────────────────────────────────────────────────────────────────────────
// Local operations
// ──────────────────────────────────────────────────────────────────────────────

async function addLocalMcp(
  name: string,
  endpoint: string | undefined,
  transport: "http" | "sse" | "stdio",
  opts: any,
  stdioArgs: string[]
) {
  const config = await getConfig();
  const mcps: McpConfig[] = config.mcps || [];

  if (mcps.find((m) => m.name === name)) {
    console.error(`✗ MCP server '${name}' already exists. Use 'mcp remove ${name}' first.`);
    process.exit(1);
  }

  const entry: McpConfig = { name };

  if (transport === "stdio") {
    if (!stdioArgs.length) {
      console.error("✗ Stdio transport requires a command. Use: knowhow mcp add <name> -- <command> [args...]");
      process.exit(1);
    }
    entry.command = stdioArgs[0];
    entry.args = stdioArgs.slice(1);
    if (opts.env && opts.env.length) {
      entry.env = parseEnvList(opts.env);
    }
  } else {
    // http or sse
    if (!endpoint) {
      console.error("✗ HTTP/SSE transport requires a URL.");
      process.exit(1);
    }
    entry.url = endpoint;

    // Auth token file
    if (opts.authTokenFile) {
      entry.authorization_token_file = opts.authTokenFile;
      // Store the auth scheme (bearer or basic) - only needed for non-default
      if (opts.authScheme && opts.authScheme !== "bearer") {
        entry.authorization_scheme = opts.authScheme as "bearer" | "basic";
      }
    }

    // Inline headers (e.g. --header "Authorization: Bearer token")
    if (opts.header && opts.header.length) {
      const authHeader = (opts.header as string[]).find((h) =>
        h.toLowerCase().startsWith("authorization:")
      );
      if (authHeader) {
        const tokenMatch = authHeader.match(/:\s*(?:Bearer|Basic)\s+(.+)/i);
        if (tokenMatch) {
          entry.authorization_token = tokenMatch[1].trim();
        }
      }
    }
  }

  if (opts.autoConnect === false) {
    entry.autoConnect = false;
  }

  mcps.push(entry);
  config.mcps = mcps;
  await updateConfig(config);

  console.log(`✓ Added MCP server '${name}' (transport: ${transport}) to .knowhow/knowhow.json`);
  if (entry.url) console.log(`  URL: ${entry.url}`);
  if (entry.command) console.log(`  Command: ${entry.command} ${(entry.args || []).join(" ")}`);
}

async function listLocalMcps(test = false) {
  const config = await getConfig();
  const mcps: McpConfig[] = config.mcps || [];

  let statusMap: Record<string, { connected: boolean; toolCount: number; error?: string }> = {};
  if (test && mcps.length > 0) {
    console.log("Testing connections…");
    statusMap = await testLocalConnections(mcps);
  }

  formatLocalMcpList(mcps, statusMap);
}

async function removeLocalMcp(name: string) {
  const config = await getConfig();
  const mcps: McpConfig[] = config.mcps || [];
  const idx = mcps.findIndex((m) => m.name === name);
  if (idx < 0) {
    console.error(`✗ MCP server '${name}' not found in local config.`);
    process.exit(1);
  }
  mcps.splice(idx, 1);
  config.mcps = mcps;
  await updateConfig(config);
  console.log(`✓ Removed MCP server '${name}' from .knowhow/knowhow.json`);
}

async function getLocalMcp(name: string) {
  const config = await getConfig();
  const mcps: McpConfig[] = config.mcps || [];
  const mcp = mcps.find((m) => m.name === name);
  if (!mcp) {
    console.error(`✗ MCP server '${name}' not found in local config.`);
    process.exit(1);
  }
  console.log(JSON.stringify(mcp, null, 2));
}

// ──────────────────────────────────────────────────────────────────────────────
// Remote (backend) operations
// ──────────────────────────────────────────────────────────────────────────────

async function getRemoteClient() {
  const client = new KnowhowSimpleClient();
  await client.checkJwt();
  return client;
}

async function addRemoteMcp(
  name: string,
  endpoint: string | undefined,
  transport: "http" | "sse" | "stdio",
  opts: any,
  stdioArgs: string[]
) {
  const client = await getRemoteClient();
  const uniqueName = opts.uniqueName || name;

  const body: Record<string, any> = {
    name,
    uniqueName,
    command: "url",
    args: [],
  };

  if (transport === "stdio") {
    if (!stdioArgs.length) {
      console.error("✗ Stdio transport requires a command. Use: knowhow mcp add --remote <name> -- <command> [args...]");
      process.exit(1);
    }
    body.command = stdioArgs[0];
    body.args = stdioArgs.slice(1);
    if (opts.env && opts.env.length) {
      body.env = parseEnvList(opts.env);
    }
  } else {
    if (!endpoint) {
      console.error("✗ HTTP/SSE transport requires a URL.");
      process.exit(1);
    }
    body.url = endpoint;
    body.command = "url";
    body.args = [];
    if (opts.env && opts.env.length) {
      body.env = parseEnvList(opts.env);
    }
  }

  // Optional secretMapping (JSON string or object)
  if (opts.secretMapping) {
    try {
      body.secretMapping = typeof opts.secretMapping === "string" ? JSON.parse(opts.secretMapping) : opts.secretMapping;
    } catch {
      console.error("✗ --secret-mapping must be valid JSON.");
      process.exit(1);
    }
  }

  // Optional authConfig (JSON string or object)
  if (opts.authConfig) {
    try {
      body.authConfig = typeof opts.authConfig === "string" ? JSON.parse(opts.authConfig) : opts.authConfig;
    } catch {
      console.error("✗ --auth-config must be valid JSON.");
      process.exit(1);
    }
  }

  try {
    const response = await http.post(
      `${KNOWHOW_API_URL}/api/org-mcp-servers`,
      body,
      { headers: (client as any).headers }
    );
    const server = (response as any).data || response;
    console.log(`✓ Created remote MCP server '${name}' (id: ${server.id})`);
    const proxyUrl = `${KNOWHOW_API_URL}/api/mcp-proxy/${server.id}/mcp`;
    console.log(`  Proxy URL: ${proxyUrl}`);
    console.log(`\nTo use this MCP locally via the backend proxy, add to your config:`);
    console.log(`  knowhow mcp add ${name}-remote ${proxyUrl} --auth-token-file .knowhow/.jwt`);

    // Remind users to create secrets if authConfig references secret keys
    if (body.authConfig) {
      const ac = body.authConfig;
      const secretsNeeded: string[] = [];
      if (ac.type === "basic") {
        if (ac.usernameSecretKey) secretsNeeded.push(ac.usernameSecretKey);
        if (ac.passwordSecretKey) secretsNeeded.push(ac.passwordSecretKey);
      } else if (ac.type === "api_key" && ac.keySecretKey) {
        secretsNeeded.push(ac.keySecretKey);
      } else if (ac.type === "oauth2_static") {
        if (ac.clientIdSecretKey) secretsNeeded.push(ac.clientIdSecretKey);
        if (ac.clientSecretSecretKey) secretsNeeded.push(ac.clientSecretSecretKey);
      }
      if (secretsNeeded.length > 0) {
        console.log(`\n⚠  This server uses auth secrets. Ensure the following org secrets exist:`);
        for (const key of secretsNeeded) {
          console.log(`     knowhow mcp secrets --create ${key} --value <YOUR_VALUE>`);
        }
      }
    }
  } catch (err: any) {
    const msg = err?.response?.data?.message || err.message;
    console.error(`✗ Failed to create remote MCP server: ${msg}`);
    process.exit(1);
  }
}

async function listRemoteMcps() {
  const client = await getRemoteClient();

  try {
    const response = await http.get(
      `${KNOWHOW_API_URL}/api/org-mcp-servers`,
      { headers: (client as any).headers }
    );
    const servers: any[] = (response as any).data || response;
    formatRemoteMcpList(Array.isArray(servers) ? servers : []);
  } catch (err: any) {
    const msg = err?.response?.data?.message || err.message;
    console.error(`✗ Failed to list remote MCP servers: ${msg}`);
    process.exit(1);
  }
}

async function removeRemoteMcp(nameOrId: string) {
  const client = await getRemoteClient();

  // First fetch the list to resolve name → id
  let servers: any[] = [];
  try {
    const response = await http.get(
      `${KNOWHOW_API_URL}/api/org-mcp-servers`,
      { headers: (client as any).headers }
    );
    servers = (response as any).data || response;
    if (!Array.isArray(servers)) servers = [];
  } catch (err: any) {
    console.error(`✗ Failed to fetch remote MCP servers: ${err.message}`);
    process.exit(1);
  }

  const server = servers.find((s) => s.id === nameOrId || s.name === nameOrId || s.uniqueName === nameOrId);
  if (!server) {
    console.error(`✗ Remote MCP server '${nameOrId}' not found.`);
    process.exit(1);
  }

  try {
    await http.delete(
      `${KNOWHOW_API_URL}/api/org-mcp-servers/${server.id}`,
      { headers: (client as any).headers }
    );
    console.log(`✓ Removed remote MCP server '${server.name}' (id: ${server.id})`);
  } catch (err: any) {
    const msg = err?.response?.data?.message || err.message;
    console.error(`✗ Failed to remove remote MCP server: ${msg}`);
    process.exit(1);
  }
}

async function getRemoteMcp(nameOrId: string) {
  const client = await getRemoteClient();

  let servers: any[] = [];
  try {
    const response = await http.get(
      `${KNOWHOW_API_URL}/api/org-mcp-servers`,
      { headers: (client as any).headers }
    );
    servers = (response as any).data || response;
    if (!Array.isArray(servers)) servers = [];
  } catch (err: any) {
    console.error(`✗ Failed to fetch remote MCP servers: ${err.message}`);
    process.exit(1);
  }

  const server = servers.find((s) => s.id === nameOrId || s.name === nameOrId || s.uniqueName === nameOrId);
  if (!server) {
    console.error(`✗ Remote MCP server '${nameOrId}' not found.`);
    process.exit(1);
  }

  console.log(JSON.stringify(server, null, 2));
  const proxyUrl = `${KNOWHOW_API_URL}/api/mcp-proxy/${server.id}/mcp`;
  console.log(`\n  Proxy URL: ${proxyUrl}`);
}

async function updateRemoteMcp(nameOrId: string, opts: any) {
  const client = await getRemoteClient();

  // First list to resolve name → id
  let servers: any[] = [];
  try {
    const response = await http.get(
      `${KNOWHOW_API_URL}/api/org-mcp-servers`,
      { headers: (client as any).headers }
    );
    servers = (response as any).data || response;
    if (!Array.isArray(servers)) servers = [];
  } catch (err: any) {
    console.error(`✗ Failed to fetch remote MCP servers: ${err.message}`);
    process.exit(1);
  }

  const server = servers.find((s) => s.id === nameOrId || s.name === nameOrId || s.uniqueName === nameOrId);
  if (!server) {
    console.error(`✗ Remote MCP server '${nameOrId}' not found.`);
    process.exit(1);
  }

  const body: Record<string, any> = {};
  if (opts.url) body.url = opts.url;
  if (opts.enabled !== undefined) body.enabled = opts.enabled === "true";
  if (opts.env && opts.env.length) body.env = parseEnvList(opts.env);
  if (opts.secretMapping) {
    try { body.secretMapping = JSON.parse(opts.secretMapping); } catch { console.error("✗ --secret-mapping must be valid JSON."); process.exit(1); }
  }
  if (opts.authConfig) {
    try { body.authConfig = JSON.parse(opts.authConfig); } catch { console.error("✗ --auth-config must be valid JSON."); process.exit(1); }
  }

  try {
    const response = await http.put(
      `${KNOWHOW_API_URL}/api/org-mcp-servers/${server.id}`,
      body,
      { headers: (client as any).headers }
    );
    const updated = (response as any).data || response;
    console.log(`✓ Updated remote MCP server '${updated.name}' (id: ${updated.id})`);
    console.log(JSON.stringify(updated, null, 2));
  } catch (err: any) {
    const msg = err?.response?.data?.message || err.message;
    console.error(`✗ Failed to update remote MCP server: ${msg}`);
    process.exit(1);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Utility
// ──────────────────────────────────────────────────────────────────────────────

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function parseEnvList(envList: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const item of envList) {
    const eqIdx = item.indexOf("=");
    if (eqIdx > 0) {
      env[item.slice(0, eqIdx)] = item.slice(eqIdx + 1);
    }
  }
  return env;
}

// ──────────────────────────────────────────────────────────────────────────────
// Remote secrets operations
// ──────────────────────────────────────────────────────────────────────────────

async function listRemoteSecrets() {
  const client = await getRemoteClient();

  try {
    const response = await http.get(
      `${KNOWHOW_API_URL}/api/secrets/org`,
      { headers: (client as any).headers }
    );
    const secrets: any[] = (response as any).data || response;
    const list = Array.isArray(secrets) ? secrets : [];

    if (list.length === 0) {
      console.log("No org secrets found.");
      return;
    }

    console.log(`\n${"─".repeat(60)}`);
    console.log("  Remote Org Secrets");
    console.log(`${"─".repeat(60)}`);
    for (const s of list) {
      console.log(`\n  • ${s.name}`);
      console.log(`    id         : ${s.id}`);
      console.log(`    created    : ${s.createdAt}`);
      console.log(`    secret path: secret.${s.name}`);
    }
    console.log(`${"─".repeat(60)}\n`);
  } catch (err: any) {
    const msg = err?.response?.data?.message || err.message;
    console.error(`✗ Failed to list remote secrets: ${msg}`);
    process.exit(1);
  }
}

async function createRemoteSecret(name: string, value: string) {
  const client = await getRemoteClient();

  try {
    const response = await http.post(
      `${KNOWHOW_API_URL}/api/secrets/org`,
      { name, value },
      { headers: (client as any).headers }
    );
    const secret = (response as any).data || response;
    console.log(`✓ Created org secret '${name}' (id: ${secret.id})`);
    console.log(`  Secret path: secret.${name}`);
    console.log(`  Use in secretMapping: { "MY_ENV_VAR": "secret.${name}" }`);
    console.log(`  Use in authConfig usernameSecretKey: "${name}"`);
  } catch (err: any) {
    const msg = err?.response?.data?.message || err.message;
    console.error(`✗ Failed to create remote secret: ${msg}`);
    process.exit(1);
  }
}

async function deleteRemoteSecret(nameOrId: string) {
  const client = await getRemoteClient();

  // First list to resolve name → id
  let secrets: any[] = [];
  try {
    const response = await http.get(
      `${KNOWHOW_API_URL}/api/secrets/org`,
      { headers: (client as any).headers }
    );
    secrets = (response as any).data || response;
    if (!Array.isArray(secrets)) secrets = [];
  } catch (err: any) {
    console.error(`✗ Failed to fetch remote secrets: ${err.message}`);
    process.exit(1);
  }

  const secret = secrets.find((s) => s.id === nameOrId || s.name === nameOrId);
  if (!secret) {
    console.error(`✗ Remote secret '${nameOrId}' not found.`);
    process.exit(1);
  }

  try {
    await http.delete(
      `${KNOWHOW_API_URL}/api/secrets/org/${secret.id}`,
      { headers: (client as any).headers }
    );
    console.log(`✓ Deleted org secret '${secret.name}' (id: ${secret.id})`);
  } catch (err: any) {
    const msg = err?.response?.data?.message || err.message;
    console.error(`✗ Failed to delete remote secret: ${msg}`);
    process.exit(1);
  }
}
