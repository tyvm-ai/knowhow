import { exec, spawn, ChildProcess } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

describe("Full Workflow Integration Test", () => {
  const testOutputDir = path.join(__dirname, "..", "test-workflow-output");
  const PETSTORE_SWAGGER_URL = "https://petstore.swagger.io/v2/swagger.json";
  const CLI_PATH = path.join(__dirname, "..", "dist", "index.js");

  // Cleanup before and after tests
  beforeAll(async () => {
    // Build the CLI first
    console.log("Building CLI...");
    await execAsync("npm run build", { cwd: path.join(__dirname, "..") });
  });

  beforeEach(async () => {
    await cleanupTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  async function cleanupTestDir() {
    try {
      await fs.rm(testOutputDir, { recursive: true, force: true });
    } catch (error) {
      // Directory might not exist, that's ok
    }
  }

  async function waitForServerReady(
    process: ChildProcess,
    timeoutMs: number = 10000
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let output = "";
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      }, timeoutMs);

      const handleData = (data: Buffer) => {
        output += data.toString();
        // Look for signs that the server is ready
        if (
          output.includes("MCP server is running") ||
          output.includes("MCP Server running") ||
          output.includes("Server started") ||
          output.includes("listening") ||
          output.includes("running on stdio") ||
          // If we see JSON-RPC messages, the server is responding
          output.includes('"jsonrpc"')
        ) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(true);
          }
        }
      };

      if (process.stdout) {
        process.stdout.on("data", handleData);
      }
      if (process.stderr) {
        process.stderr.on("data", handleData);
      }

      process.on("exit", (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          // If process exits cleanly early, that might be ok too
          resolve(code === 0);
        }
      });
    });
  }

  it("should complete full workflow: generate -> build -> start server", async () => {
    console.log("🚀 Starting full workflow test...");

    // Step 1: Generate the MCP server from REAL Petstore API (no mocking)
    console.log("📋 Step 1: Generating MCP server from Petstore API...");
    const generateCommand = `node "${CLI_PATH}" --url "${PETSTORE_SWAGGER_URL}" --output "${testOutputDir}"`;

    const { stdout: generateStdout, stderr: generateStderr } = await execAsync(
      generateCommand,
      {
        cwd: path.join(__dirname, ".."),
        timeout: 30000,
      }
    );

    console.log("Generate stdout:", generateStdout);
    if (generateStderr) {
      console.log("Generate stderr:", generateStderr);
    }

    // Step 2: Verify directory structure was created
    console.log("🔍 Step 2: Verifying generated directory structure...");

    // Check that output directory exists
    const outputDirExists = await fs
      .stat(testOutputDir)
      .then(() => true)
      .catch(() => false);
    expect(outputDirExists).toBe(true);

    // Check for key generated files
    const expectedFiles = [
      "package.json",
      "tsconfig.json",
      "src/mcp-server.ts",
      "src/server-factory.ts",
      "src/express-app.ts",
    ];

    for (const file of expectedFiles) {
      const filePath = path.join(testOutputDir, file);
      const fileExists = await fs
        .stat(filePath)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);
    }

    // Verify package.json has correct structure
    const packageJsonPath = path.join(testOutputDir, "package.json");
    const packageJsonContent = await fs.readFile(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageJsonContent);

    expect(packageJson.name).toBeDefined();
    expect(packageJson.scripts).toHaveProperty("build");
    expect(packageJson.scripts).toHaveProperty("start");
    expect(packageJson.dependencies).toHaveProperty(
      "@modelcontextprotocol/sdk"
    );

    // Step 3: Install dependencies and build
    console.log("📦 Step 3: Installing dependencies...");
    await execAsync("npm install", {
      cwd: testOutputDir,
      timeout: 60000,
    });

    console.log("🔨 Step 4: Building generated code...");
    const { stdout: buildStdout, stderr: buildStderr } = await execAsync(
      "npm run build",
      {
        cwd: testOutputDir,
        timeout: 30000,
      }
    );

    console.log("Build stdout:", buildStdout);
    if (buildStderr) {
      console.log("Build stderr:", buildStderr);
    }

    // Verify build artifacts exist
    const builtServerPath = path.join(testOutputDir, "dist", "mcp-server.js");
    const builtServerExists = await fs
      .stat(builtServerPath)
      .then(() => true)
      .catch(() => false);
    expect(builtServerExists).toBe(true);

    // Step 4: Start the server and verify it doesn't crash
    console.log("🚀 Step 5: Starting MCP server...");

    const serverProcess = spawn("node", [builtServerPath], {
      cwd: testOutputDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let serverStartedSuccessfully = false;

    try {
      // Wait for server to be ready or timeout
      serverStartedSuccessfully = await waitForServerReady(
        serverProcess,
        15000
      );

      if (serverStartedSuccessfully) {
        console.log("✅ Server started successfully!");

        // Give it a moment to run
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Check if process is still running
        const isStillRunning =
          !serverProcess.killed && serverProcess.exitCode === null;
        expect(isStillRunning).toBe(true);
      } else {
        console.log("❌ Server failed to start within timeout");
      }
    } finally {
      // Clean up the server process
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill("SIGTERM");

        // Give it a moment to shut down gracefully
        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (!serverProcess.killed) {
          serverProcess.kill("SIGKILL");
        }
      }
    }

    expect(serverStartedSuccessfully).toBe(true);

    console.log("🎉 Full workflow test completed successfully!");
  }, 120000); // 2 minute timeout for the entire test

  it("should generate tools that match expected Petstore endpoints", async () => {
    console.log("🔍 Testing generated tools against REAL Petstore API...");

    // Generate the server
    const generateCommand = `node "${CLI_PATH}" --url "${PETSTORE_SWAGGER_URL}" --output "${testOutputDir}"`;
    await execAsync(generateCommand, { timeout: 30000 });

    // Read the generated server factory to check what tools were created
    const serverFactoryPath = path.join(
      testOutputDir,
      "src",
      "server-factory.ts"
    );
    const serverFactoryContent = await fs.readFile(serverFactoryPath, "utf-8");

    // Check for key Petstore endpoints
    const expectedEndpoints = [
      "getPetById",
      "addPet",
      "findPetsByStatus",
      "updatePet",
      "deletePet",
    ];

    for (const endpoint of expectedEndpoints) {
      expect(serverFactoryContent).toContain(endpoint);
    }

    console.log("✅ Generated tools match expected Petstore endpoints");
  }, 60000);

  it("should handle --start-stdio flag and build+start in one command", async () => {
    console.log("🔄 Testing --start-stdio workflow with REAL API...");

    // This test will use the --start-stdio flag which should generate, build, and start
    const command = `node "${CLI_PATH}" --url "${PETSTORE_SWAGGER_URL}" --output "${testOutputDir}" --start-stdio`;

    const childProcess = spawn("bash", ["-c", command], {
      cwd: path.join(__dirname, ".."),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let processSucceeded = false;

    try {
      // The --start-stdio command should:
      // 1. Generate the files
      // 2. Run npm install
      // 3. Run npm run build
      // 4. Start the server

      processSucceeded = await waitForServerReady(childProcess, 60000); // Longer timeout for full process

      if (processSucceeded) {
        // Verify the directory was created and built
        const builtServerPath = path.join(
          testOutputDir,
          "dist",
          "mcp-server.js"
        );
        const builtServerExists = await fs
          .stat(builtServerPath)
          .then(() => true)
          .catch(() => false);
        expect(builtServerExists).toBe(true);

        console.log("✅ --start-stdio workflow completed successfully");
      }
    } finally {
      // Clean up
      if (childProcess && !childProcess.killed) {
        childProcess.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!childProcess.killed) {
          childProcess.kill("SIGKILL");
        }
      }
    }

    expect(processSucceeded).toBe(true);
  }, 180000); // 3 minute timeout for full build process
});
