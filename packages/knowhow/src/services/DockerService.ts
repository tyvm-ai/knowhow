import { execAsync } from "../utils";
import * as path from "path";
import * as os from "os";
import { Config } from "../types";
import { updateConfig } from "../config";

export interface DockerWorkerOptions {
  workspaceDir: string;
  jwt: string;
  apiUrl: string;
  config?: Config;
  share?: boolean;
  unshare?: boolean;
}

export class DockerService {
  private static readonly IMAGE_NAME = "knowhow-worker";
  private static readonly CONTAINER_PREFIX = "knowhow-worker";

  /**
   * Check if Docker is installed and running
   */
  async checkDockerAvailable(): Promise<boolean> {
    try {
      await execAsync("docker --version");
      await execAsync("docker info");
      return true;
    } catch (error) {
      console.log(error);
      return false;
    }
  }

  /**
   * Get the path to the Dockerfile
   */
  private getDockerfilePath(): string {
    const buildContext = process.cwd();
    return path.join(buildContext, ".knowhow", "Dockerfile.worker");
  }

  /**
   * Ensure the Dockerfile exists, creating it from template if needed
   */
  private async ensureDockerfile(): Promise<string> {
    const dockerfilePath = this.getDockerfilePath();
    const fs = require("fs");

    // Create .knowhow directory if it doesn't exist
    const knowhowDir = path.dirname(dockerfilePath);
    if (!fs.existsSync(knowhowDir)) {
      fs.mkdirSync(knowhowDir, { recursive: true });
    }

    // Only write the default Dockerfile if it doesn't exist
    if (!fs.existsSync(dockerfilePath)) {
      console.log("📝 Creating default worker.Dockerfile...");
      const dockerfile = this.generateDockerfile();
      fs.writeFileSync(dockerfilePath, dockerfile);
      console.log(`✓ Dockerfile created at ${dockerfilePath}`);
      console.log("  You can customize this file to modify the worker image\n");
    }

    return dockerfilePath;
  }

  /**
   * Build the Docker image for the knowhow worker
   */
  async buildWorkerImage(): Promise<void> {
    console.log("🔨 Building Docker image for knowhow worker...");

    const dockerfilePath = await this.ensureDockerfile();
    const buildContext = process.cwd();

    console.log("📦 Starting Docker build process...\n");

    return new Promise<void>((resolve, reject) => {
      const { spawn } = require("child_process");
      const buildProcess = spawn(
        "docker",
        [
          "build",
          "-t",
          DockerService.IMAGE_NAME,
          "-f",
          dockerfilePath,
          buildContext,
        ],
        {
          stdio: ["inherit", "pipe", "pipe"],
        }
      );

      buildProcess.stdout.on("data", (data: Buffer) => {
        const output = data.toString();
        // Add prefixes to make build steps more visible
        const lines = output.split("\n").filter((line) => line.trim());
        lines.forEach((line) => {
          if (line.includes("Step ")) {
            console.log(`🔧 ${line}`);
          } else if (line.includes("---> ")) {
            console.log(`   ${line}`);
          } else if (line.trim()) {
            console.log(`   ${line}`);
          }
        });
      });

      buildProcess.stderr.on("data", (data: Buffer) => {
        const output = data.toString();
        const lines = output.split("\n").filter((line) => line.trim());
        lines.forEach((line) => {
          console.log(`⚠️  ${line}`);
        });
      });

      buildProcess.on("close", (code: number) => {
        if (code === 0) {
          console.log("\n🎉 Docker image built successfully!");
          console.log(
            `✅ Image '${DockerService.IMAGE_NAME}' is ready to use\n`
          );
          resolve();
        } else {
          reject(new Error(`Docker build failed with exit code ${code}`));
        }
      });

      buildProcess.on("error", (error: Error) => {
        reject(error);
      });

      buildProcess.on("spawn", () => {
        console.log("🚀 Docker build process started...\n");
      });
    });
  }

  /**
   * Check if the worker image exists
   */
  async imageExists(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        `docker images -q ${DockerService.IMAGE_NAME}`
      );
      return stdout.trim().length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Expand ~ to home directory in paths
   */
  private expandPath(pathStr: string): string {
    if (pathStr.startsWith("~/") || pathStr === "~") {
      return pathStr.replace("~", os.homedir());
    }
    return pathStr;
  }

  /**
   * Parse and validate a volume mount specification
   * Format: "host_path:container_path[:mode]"
   */
  private parseVolumeMount(volumeSpec: string): {
    hostPath: string;
    containerPath: string;
    mode?: string;
    isValid: boolean;
    error?: string;
  } {
    const parts = volumeSpec.split(":");

    if (parts.length < 2) {
      return {
        hostPath: "",
        containerPath: "",
        isValid: false,
        error: `Invalid volume format: "${volumeSpec}". Expected format: "host_path:container_path[:mode]"`,
      };
    }

    const hostPath = this.expandPath(parts[0]);
    const containerPath = parts[1];
    const mode = parts[2]; // optional, can be "ro" (read-only) or "rw" (read-write)

    // Check if host path exists
    const fs = require("fs");
    if (!fs.existsSync(hostPath)) {
      return {
        hostPath,
        containerPath,
        mode,
        isValid: false,
        error: `Host path does not exist: ${hostPath} (from "${volumeSpec}")`,
      };
    }

    return {
      hostPath,
      containerPath,
      mode,
      isValid: true,
    };
  }

  /**
   * Validate and format volume mounts from config
   */
  private processVolumeMounts(volumes: string[]): {
    valid: string[];
    errors: string[];
  } {
    const valid: string[] = [];
    const errors: string[] = [];

    for (const volumeSpec of volumes) {
      const parsed = this.parseVolumeMount(volumeSpec);

      if (!parsed.isValid) {
        errors.push(parsed.error!);
      } else {
        // Rebuild the volume mount string with expanded paths
        const mount = parsed.mode
          ? `${parsed.hostPath}:${parsed.containerPath}:${parsed.mode}`
          : `${parsed.hostPath}:${parsed.containerPath}`;
        valid.push(mount);
      }
    }

    return { valid, errors };
  }

  /**
   * Run the knowhow worker in a Docker container
   */
  async runWorkerContainer(options: DockerWorkerOptions): Promise<string> {
    const containerName = `${DockerService.CONTAINER_PREFIX}-${Date.now()}`;
    const homedir = os.homedir();
    const relativeWorkspace = options.workspaceDir.replace(homedir, "~");
    const knowhowDir = path.join(homedir, ".knowhow");
    const relativeKnowhowDir = "~/.knowhow";

    let config = options.config;

    // Ensure config has the default volumes that we always mount
    const defaultVolumes = [
      `${relativeWorkspace}:/workspace`,
      `${relativeKnowhowDir}:/root/.knowhow`,
    ];

    // Initialize worker.volumes if not present or merge with defaults
    if (!config?.worker?.volumes || config.worker.volumes.length === 0) {
      console.log("📝 Initializing default volume mounts in config...");
      config = {
        ...config,
        worker: {
          ...config?.worker,
          volumes: defaultVolumes,
        },
      };
      await updateConfig(config);
      console.log("✓ Config updated with default volume mounts\n");
    } else {
      // Ensure default volumes are present in the config
      const configVolumes = config.worker.volumes;
      const missingDefaults = defaultVolumes.filter(
        (dv) => !configVolumes.some((cv) => cv.split(":")[1] === dv.split(":")[1])
      );

      if (missingDefaults.length > 0) {
        console.log("📝 Adding missing default volumes to config...");
        config.worker.volumes = [...missingDefaults, ...configVolumes];
        await updateConfig(config);
        console.log("✓ Config updated with missing default volumes\n");
      }
    }


    // Build docker run command from config volumes
    const volumeMounts: string[] = [];

    console.log(
      `📁 Processing ${config.worker.volumes.length} volume mount(s)...`
    );

    const { valid, errors } = this.processVolumeMounts(config.worker.volumes);

    // Report errors but continue with valid volumes
    if (errors.length > 0) {
      console.warn("⚠️  Some volume mounts could not be processed:");
      errors.forEach((error) => console.warn(`   ${error}`));
    }

    if (valid.length > 0) {
      console.log(`✓ Mounting ${valid.length} volume(s):`);
      valid.forEach((mount) => {
        const parts = mount.split(":");
        const mode = parts[2] ? ` (${parts[2]})` : "";
        console.log(`   ${parts[0]} → ${parts[1]}${mode}`);
        volumeMounts.push(`-v "${mount}"`);
      });
    } else {
      console.error("❌ No valid volume mounts available!");
      throw new Error("Cannot start container without valid volume mounts");
    }

    // Prepare hostname and root for display in Docker
    const hostname = `${os.hostname()}.docker`;
    const workspaceRoot = process.env.WORKER_ROOT || relativeWorkspace;

    const envVars = [
      `-e KNOWHOW_JWT="${options.jwt}"`,
      `-e KNOWHOW_API_URL="${options.apiUrl}"`,
      `-e WORKSPACE_ROOT="${relativeWorkspace}"`,
      `-e WORKER_HOSTNAME="${hostname}"`,
      `-e WORKER_ROOT="${workspaceRoot}"`,
    ];

    if (options.share) {
      envVars.push(`-e WORKER_SHARED="true"`);
    } else if (options.unshare) {
      envVars.push(`-e WORKER_SHARED="false"`);
    }

    // Handle envFile from config
    const envFileArgs: string[] = [];
    if (config?.worker?.envFile) {
      const envFilePath = this.expandPath(config.worker.envFile);
      const fs = require("fs");

      if (fs.existsSync(envFilePath)) {
        console.log(`📄 Using environment file: ${envFilePath}`);
        envFileArgs.push(`--env-file "${envFilePath}"`);
      } else {
        console.warn(`⚠️  Environment file not found: ${envFilePath}`);
        console.warn(`   Container will run without the environment file.`);
      }
    }

    const dockerCmd = [
      "docker run",
      "-d",
      `--name ${containerName}`,
      "--network host", // Use host network for easier API connectivity
      ...volumeMounts,
      ...envVars,
      ...envFileArgs,
      `-w /workspace`,
      DockerService.IMAGE_NAME,
    ].join(" ");

    console.log("Starting Docker container...");

    try {
      const { stdout } = await execAsync(dockerCmd);
      const containerId = stdout.trim();

      console.log(
        `✓ Container started: ${containerName} (${containerId.substring(
          0,
          12
        )})`
      );
      console.log(`  Workspace: ${options.workspaceDir}`);
      console.log(`  Container ID: ${containerId.substring(0, 12)}`);

      return containerId;
    } catch (error) {
      console.error("Failed to start container:", error.message);
      throw error;
    }
  }

  /**
   * Follow container logs
   */
  async followContainerLogs(containerId: string): Promise<void> {
    console.log("\nFollowing container logs (Ctrl+C to stop)...\n");

    const { spawn } = require("child_process");
    const logsProcess = spawn("docker", ["logs", "-f", containerId], {
      stdio: "inherit",
    });

    return new Promise((resolve, reject) => {
      logsProcess.on("error", reject);

      // Handle Ctrl+C gracefully
      process.on("SIGINT", () => {
        logsProcess.kill();
        resolve();
      });
    });
  }

  /**
   * Stop and remove a container
   */
  async stopContainer(containerId: string): Promise<void> {
    try {
      console.log(`\nStopping container ${containerId.substring(0, 12)}...`);
      await execAsync(`docker stop ${containerId}`);
      await execAsync(`docker rm ${containerId}`);
      console.log("✓ Container stopped and removed");
    } catch (error) {
      console.error("Failed to stop container:", error.message);
    }
  }

  /**
   * Clean up all knowhow worker containers
   */
  async cleanupAllWorkerContainers(): Promise<void> {
    try {
      const { stdout } = await execAsync(
        `docker ps -a --filter "name=${DockerService.CONTAINER_PREFIX}" --format "{{.ID}}"`
      );

      const containerIds = stdout.trim().split("\n").filter(Boolean);

      if (containerIds.length === 0) {
        console.log("No worker containers to clean up");
        return;
      }

      console.log(`Cleaning up ${containerIds.length} worker container(s)...`);

      for (const containerId of containerIds) {
        await this.stopContainer(containerId);
      }

      console.log("✓ All worker containers cleaned up");
    } catch (error) {
      console.error("Failed to clean up containers:", error.message);
    }
  }

  /**
   * Generate Dockerfile content for the worker
   */
  private generateDockerfile(): string {
    return `FROM node:20

# Install necessary system dependencies
RUN apt-get update && apt-get install -y \
curl \
ffmpeg \
&& rm -rf /var/lib/apt/lists/*

# Install necessary packages
RUN apt-get install git python3 make g++ bash curl

# Install knowhow CLI globally
RUN npm install -g @tyvm/knowhow

# Create workspace directory
WORKDIR /workspace

RUN knowhow init

# Set environment variables
ENV NODE_ENV=production
ENV KNOWHOW_DOCKER=true

# Set the default command to run the worker
CMD ["knowhow", "worker"]
`;
  }
}
