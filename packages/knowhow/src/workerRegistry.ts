import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, ChildProcess } from "child_process";

interface WorkerRegistry {
  workers: string[];
}

function getWorkerRegistryPath(): string {
  return path.join(os.homedir(), ".knowhow", "workers.json");
}

export async function loadWorkerRegistry(): Promise<WorkerRegistry> {
  const registryPath = getWorkerRegistryPath();
  
  try {
    if (fs.existsSync(registryPath)) {
      const content = await fs.promises.readFile(registryPath, "utf8");
      return JSON.parse(content);
    }
  } catch (error) {
    console.warn("Failed to load worker registry:", error);
  }
  
  return { workers: [] };
}

export async function saveWorkerRegistry(registry: WorkerRegistry): Promise<void> {
  const registryPath = getWorkerRegistryPath();
  const dir = path.dirname(registryPath);
  
  // Ensure the directory exists
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
  
  await fs.promises.writeFile(
    registryPath,
    JSON.stringify(registry, null, 2),
    "utf8"
  );
}

export async function registerWorkerPath(workerPath: string): Promise<void> {
  const registry = await loadWorkerRegistry();
  const normalizedPath = path.resolve(workerPath);
  
  if (!registry.workers.includes(normalizedPath)) {
    registry.workers.push(normalizedPath);
    await saveWorkerRegistry(registry);
    console.log(`✓ Registered worker path: ${normalizedPath}`);
  } else {
    console.log(`Worker path already registered: ${normalizedPath}`);
  }
}

export async function unregisterWorkerPath(workerPath: string): Promise<void> {
  const registry = await loadWorkerRegistry();
  const normalizedPath = path.resolve(workerPath);
  
  const index = registry.workers.indexOf(normalizedPath);
  if (index !== -1) {
    registry.workers.splice(index, 1);
    await saveWorkerRegistry(registry);
    console.log(`✓ Unregistered worker path: ${normalizedPath}`);
  } else {
    console.log(`Worker path not found in registry: ${normalizedPath}`);
  }
}

export async function listWorkerPaths(): Promise<string[]> {
  const registry = await loadWorkerRegistry();
  return registry.workers;
}

export async function clearWorkerRegistry(): Promise<void> {
  await saveWorkerRegistry({ workers: [] });
  console.log("✓ Cleared all registered worker paths");
}

interface WorkerProcess {
  path: string;
  process: ChildProcess;
}

export async function startAllWorkers(): Promise<void> {
  const workerPaths = await listWorkerPaths();
  
  if (workerPaths.length === 0) {
    console.log("No workers registered. Use 'knowhow worker --register' to register workers.");
    return;
  }
  
  console.log(`Starting ${workerPaths.length} worker(s)...`);
  
  const processes: WorkerProcess[] = [];
  
  for (const workerPath of workerPaths) {
    if (!fs.existsSync(workerPath)) {
      console.warn(`⚠ Worker path does not exist: ${workerPath}`);
      continue;
    }
    
    console.log(`Starting worker at: ${workerPath}`);
    
    const workerProcess = spawn("knowhow", ["worker"], {
      cwd: workerPath,
      stdio: "inherit",
      detached: false,
    });
    
    workerProcess.on("error", (error) => {
      console.error(`Error in worker at ${workerPath}:`, error);
    });
    
    workerProcess.on("exit", (code, signal) => {
      console.log(`Worker at ${workerPath} exited with code ${code} and signal ${signal}`);
    });
    
    processes.push({ path: workerPath, process: workerProcess });
  }
  
  console.log(`\n✓ Started ${processes.length} worker(s)`);
  console.log("Press Ctrl+C to stop all workers\n");
  
  // Handle graceful shutdown
  const shutdownHandler = () => {
    console.log("\nShutting down all workers...");
    
    for (const { path: workerPath, process: proc } of processes) {
      console.log(`Stopping worker at: ${workerPath}`);
      proc.kill("SIGTERM");
    }
    
    // Give processes time to shut down gracefully
    setTimeout(() => {
      for (const { process: proc } of processes) {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }
      process.exit(0);
    }, 5000);
  };
  
  process.on("SIGINT", shutdownHandler);
  process.on("SIGTERM", shutdownHandler);
  
  // Keep the process alive
  await new Promise(() => {});
}
