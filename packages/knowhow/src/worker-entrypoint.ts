#!/usr/bin/env node
/**
 * Docker container entrypoint for knowhow worker
 * This file is executed inside the Docker container
 */
import { worker } from "./worker";

async function main() {
  // Get configuration from environment variables
  const jwt = process.env.KNOWHOW_JWT;
  const apiUrl = process.env.KNOWHOW_API_URL;
  const shared = process.env.WORKER_SHARED;
  
  if (!jwt) {
    console.error("Error: KNOWHOW_JWT environment variable not set");
    process.exit(1);
  }
  
  if (!apiUrl) {
    console.error("Error: KNOWHOW_API_URL environment variable not set");
    process.exit(1);
  }
  
  // Change to workspace directory if running in Docker
  // The workspace is mounted at /workspace, but we run from /app where code is
  if (process.env.WORKSPACE_ROOT && require("fs").existsSync("/workspace")) {
    process.chdir("/workspace");
    console.log("Changed working directory to /workspace");
  }
  
  console.log("Starting knowhow worker in Docker container...");
  console.log(`API URL: ${apiUrl}`);
  console.log(`Workspace: ${process.cwd()}`);
  
  // Determine share/unshare options
  const options: { share?: boolean; unshare?: boolean } = {};
  if (shared === "true") {
    options.share = true;
  } else if (shared === "false") {
    options.unshare = true;
  }
  
  // Start the worker
  await worker(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error in worker entrypoint:", error);
    process.exit(1);
  });
}
