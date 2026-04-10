# 🧠 knowhow Mono-Repo

This repo contains the **Knowhow** toolchain and related packages, managed as a single monorepo. It includes the main **@tyvm/knowhow** AI CLI plus supporting packages for generating MCP servers and tunneling requests to your local services.

---

## 🚀 Quickstart (primary: `@tyvm/knowhow`)

```bash
npm install -g @tyvm/knowhow
```

Initialize a workspace in your project:

```bash
knowhow init
```

Log in to Knowhow Cloud:

```bash
knowhow login
```

Start chatting:

```bash
knowhow chat
```

> For full setup, configuration, and command usage, see the package README for **@tyvm/knowhow**.

---

## 📦 Packages

| Package (npm) | What it does | README |
|---|---|---|
| `@tyvm/knowhow` | Main AI CLI for docs generation, embeddings, and interactive chat/agents | [packages/knowhow/README.md](packages/knowhow/README.md) |
| `@tyvm/swagger-mcp` | Generate MCP servers (or a runtime proxy) from Swagger/OpenAPI specs | [packages/swagger-mcp/README.md](packages/swagger-mcp/README.md) |
| `@tyvm/knowhow-tunnel` | HTTP tunnel library for the worker system (proxy to localhost) | [packages/knowhow-tunnel/README.md](packages/knowhow-tunnel/README.md) |

---

## 🔗 Links

- Website: https://knowhow.tyvm.ai
- Twitter/X: https://x.com/micahriggan
