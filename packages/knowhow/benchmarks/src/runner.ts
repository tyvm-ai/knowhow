import { spawn } from "child_process";
import { promises as fsasync } from "fs";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import ora from "ora";
import { services, agents } from "../../ts_build/src/index";
import {
  BenchmarkConfig,
  BenchmarkResults,
  ExerciseResult,
  Exercise,
} from "./types";
import { registerProvider } from "./providers";
import {
  XmlToolCallProcessor,
  HarmonyToolProcessor,
} from "../../ts_build/src/processors";
import { EvaluatorRegistry } from "./evaluators";

export class BenchmarkRunner {
  private config: BenchmarkConfig;
  private exercisesDir: string;
  private knowhowPath: string;
  private defaultServices = services.services();
  private defaultAgents = agents.agents(this.defaultServices);
  private selectedAgent: agents.BaseAgent;
  private model: string = "";
  private provider: string = "";
  private isShuttingDown: boolean = false;
  private cleanup: (() => Promise<void>)[] = [];
  private activeSpinners: Set<any> = new Set();
  private childProcesses: Set<any> = new Set();
  private evaluatorRegistry: EvaluatorRegistry;

  constructor(config: BenchmarkConfig) {
    this.config = config;
    // Use different paths for local vs container
    if (process.env.CONTAINER) {
      this.exercisesDir = "/app/exercises";
    } else {
      this.exercisesDir = path.join(__dirname, "..", "exercises");
    }
    this.knowhowPath = "/app/knowhow";

    // Initialize Knowhow services
    this.defaultServices = services.services();
    this.defaultAgents = agents.agents(this.defaultServices);

    // Register agents
    this.defaultServices.Agents.registerAgent(this.defaultAgents.Researcher);
    this.defaultServices.Agents.registerAgent(this.defaultAgents.Patcher);
    this.defaultServices.Agents.registerAgent(this.defaultAgents.Developer);

    // Select the agent to use (default to Patcher)
    const agentName = config.agent || "Patcher";
    this.selectedAgent =
      this.defaultAgents[agentName as keyof typeof this.defaultAgents];

    if (!this.selectedAgent) {
      throw new Error(`Unknown agent: ${agentName}`);
    }

    // Initialize test evaluator registry
    this.evaluatorRegistry = new EvaluatorRegistry();

    this.setupSignalHandlers();
  }

  private setupSignalHandlers(): void {
    const gracefulShutdown = async (signal: string) => {
      if (this.isShuttingDown) {
        console.log(
          chalk.red(`\n💥 Force killing process (${signal} received again)`)
        );
        process.exit(1);
      }

      this.isShuttingDown = true;
      console.log(
        chalk.yellow(`\n🛑 Graceful shutdown initiated (${signal} received)`)
      );
      console.log(chalk.gray("Press Ctrl+C again to force quit"));

      try {
        // Run cleanup functions
        await Promise.all(this.cleanup.map((fn) => fn().catch(console.error)));

        // Kill all child processes
        for (const child of this.childProcesses) {
          child.kill("SIGTERM");
        }

        // Stop all active spinners
        for (const spinner of this.activeSpinners) {
          spinner.stop();
        }

        // Disconnect MCP servers
        if (this.defaultServices?.Mcp) {
          await this.defaultServices.Mcp.closeAll();
        }

        console.log(chalk.green("✅ Cleanup completed"));
        process.exit(0);
      } catch (error) {
        console.error(chalk.red("❌ Error during cleanup:"), error);
        process.exit(1);
      }
    };

    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  }

  customProviders() {
    // Load custom providers if they exist
    const customProvidersPath = path.join(__dirname, "custom_providers.json");

    if (fs.existsSync(customProvidersPath)) {
      return require(customProvidersPath);
    }

    return [];
  }

  async loadModels() {
    // Register configured models
    await this.defaultServices.Clients.registerConfiguredModels();
    const customProviders = this.customProviders();
    for (const custom of customProviders) {
      await registerProvider(
        custom.provider,
        custom.url,
        custom.headers,
        this.defaultServices.Clients
      );
    }

    const { model, provider } =
      this.defaultServices.Clients.detectProviderModel(
        this.config.provider,
        this.config.model
      );

    if (!model || !provider) {
      throw new Error(
        `Invalid model/provider combination: options are: ${JSON.stringify(
          this.defaultServices.Clients.listAllModels(),
          null,
          2
        )}`
      );
    }

    console.log(chalk.blue(`Using provider: ${provider}`));
    console.log(chalk.blue(`Using model: ${model}`));

    this.model = model;
    this.provider = provider;
  }

  async initializeServices(): Promise<void> {
    const spinner = ora("Initializing Knowhow services...").start();

    // Track spinner for cleanup
    this.activeSpinners.add(spinner);
    const cleanupSpinner = () => {
      this.activeSpinners.delete(spinner);
    };

    try {
      // Define tools
      this.defaultServices.Tools.defineTools(
        agents.includedTools,
        agents.tools
      );

      // Connect to MCP servers
      await this.defaultServices.Mcp.connectToConfigured(
        this.defaultServices.Tools
      );

      // Set agent model preferences
      this.selectedAgent.setModelPreferences([
        { model: this.model, provider: this.provider as any },
      ]);

      spinner.succeed("Services initialized successfully");
      cleanupSpinner();
    } catch (error) {
      spinner.fail("Failed to initialize services");
      cleanupSpinner();
      throw error;
    }
  }

  async setupExercises(): Promise<void> {
    const spinner = ora("Setting up exercises...").start();

    // Track spinner for cleanup
    this.activeSpinners.add(spinner);
    const cleanupSpinner = () => {
      this.activeSpinners.delete(spinner);
    };

    try {
      // Run the clone script
      await this.runCommand("bash", [
        path.join(__dirname, "..", "scripts", "clone-exercism.sh"),
        this.config.language,
        this.config.maxExercises.toString(),
      ]);

      spinner.succeed("Exercises setup completed");
      cleanupSpinner();
    } catch (error) {
      spinner.fail("Failed to setup exercises");
      cleanupSpinner();
      throw error;
    }
  }

  async run(): Promise<BenchmarkResults> {
    console.log(chalk.blue(`Running benchmarks with config:`));
    console.log(chalk.gray(`  Language: ${this.config.language}`));

    await this.loadModels();
    await this.initializeServices();

    console.log(chalk.gray(`  Max exercises: ${this.config.maxExercises}`));
    console.log(chalk.gray(`  Model: ${this.model}`));
    console.log(chalk.gray(`  Provider: ${this.provider}`));

    const startTime = new Date();
    await this.setupExercises();
    const exercises = await this.discoverExercises();
    const results: ExerciseResult[] = [];

    console.log(chalk.blue(`\nFound ${exercises.length} exercises to run\n`));

    for (const exercise of exercises) {
      // Check if we should stop due to shutdown signal
      if (this.isShuttingDown) {
        console.log(
          chalk.yellow("⏹️  Stopping exercise execution due to shutdown signal")
        );
        break;
      }

      console.log(chalk.yellow(`Running exercise: ${exercise.name}`));

      const result = await this.runExercise(exercise);
      results.push(result);

      // Log individual result with progress
      console.log(
        chalk.green(
          `✓ Exercise ${results.length}/${exercises.length} completed: ${exercise.name}`
        )
      );
      const statusColor = result.status === "success" ? chalk.green : chalk.red;
      console.log(statusColor(`  Status: ${result.status}`));
      console.log(chalk.gray(`  Turns: ${result.turns}`));
      console.log(chalk.gray(`  Time: ${result.timeElapsed.toFixed(2)}s`));
      console.log(chalk.gray(`  Cost: $${result.cost.toFixed(4)}\n`));

      // Save incremental results after each exercise
      const incrementalResults = this.generateResults(
        results,
        startTime,
        new Date()
      );
      await this.saveIncrementalResults(incrementalResults);
    }

    const endTime = new Date();
    const benchmarkResults = this.generateResults(results, startTime, endTime);

    // Save results
    await this.saveResults(benchmarkResults);

    // Print summary
    this.printSummary(benchmarkResults);

    return benchmarkResults;
  }

  private async discoverExercises(): Promise<Exercise[]> {
    const filteredDir = path.join(this.exercisesDir, "filtered");

    try {
      const exerciseNames = await fsasync.readdir(filteredDir);
      const exercises: Exercise[] = [];

      for (const name of exerciseNames) {
        const exercisePath = path.join(filteredDir, name);
        const stat = await fsasync.stat(exercisePath);

        if (stat.isDirectory()) {
          const files = await fsasync.readdir(exercisePath);
          const hasTests = files.some(
            (f) => f.includes("test") || f.includes("spec")
          );

          exercises.push({
            name,
            path: exercisePath,
            hasTests,
            files,
          });
        }
      }

      return exercises.slice(0, this.config.maxExercises);
    } catch (error) {
      throw new Error(`Failed to discover exercises: ${error}`);
    }
  }

  private async runExercise(exercise: Exercise): Promise<ExerciseResult> {
    const startTime = new Date();

    // Check for shutdown before starting exercise
    if (this.isShuttingDown) {
      throw new Error("Exercise cancelled due to shutdown");
    }

    try {
      // Create the benchmark prompt for the exercise
      const prompt = await this.createExercisePrompt(exercise);

      // Run knowhow agent on the exercise
      const result = await this.runKnowhowAgent(exercise, prompt);

      // Run test evaluation after agent execution
      let testResult;
      if (this.evaluatorRegistry.canEvaluateExercise(exercise.path)) {
        const evaluation = await this.evaluatorRegistry.evaluateExercise(
          exercise.path,
          exercise.name
        );
        if (evaluation) {
          testResult = evaluation.testResult;
          console.log(
            chalk.gray(
              `  Tests: ${testResult.passed}/${testResult.total} passed`
            )
          );
        }
      }

      const endTime = new Date();
      const timeElapsed = (endTime.getTime() - startTime.getTime()) / 1000;

      return {
        exerciseName: exercise.name,
        status: result.success ? "success" : "failure",
        turns: result.turns,
        testResult,
        timeElapsed,
        cost: result.cost,
        startTime,
        endTime,
        errorMessage: result.error,
        finalOutput: result.output,
      };
    } catch (error: any) {
      const endTime = new Date();
      const timeElapsed = (endTime.getTime() - startTime.getTime()) / 1000;

      return {
        exerciseName: exercise.name,
        status: "failure",
        testResult: undefined,
        turns: error?.turns || 0,
        timeElapsed,
        cost: error?.cost || 0,
        startTime,
        endTime,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async createExercisePrompt(exercise: Exercise): Promise<string> {
    let prompt = `I need you to solve this coding exercise:\n\n`;

    // Add description if available
    const descriptionPath = path.join(exercise.path, "description.md");
    try {
      const description = await fsasync.readFile(descriptionPath, "utf-8");
      prompt += `## Exercise Description\n${description}\n\n`;
    } catch {
      prompt += `## Exercise: ${exercise.name}\n\n`;
    }

    // List the files in the exercise
    prompt += `## Files in this exercise:\n`;
    for (const file of exercise.files) {
      prompt += `- ${file}\n`;
    }

    prompt += `\nPlease implement the solution and make sure all tests pass. Focus on:\n`;
    prompt += `1. Reading and understanding the problem\n`;
    prompt += `2. Implementing the required functionality\n`;
    prompt += `3. Running tests to ensure correctness\n`;
    prompt += `4. Fixing any issues that arise\n\n`;
    prompt += `5. If tests are skipped you should unskip them after the initial test passes\n\n`;
    prompt += `You should expect to have to do typical project setup tasks like npm install as a part of this eval`;
    prompt += `Work in the current directory where all the exercise files are located.`;
    prompt += `Your score will be based on whether the tests run, and how many total passed from the file`;
    prompt += `You are allowed to run the tests as many times as your want while you work.`;

    return prompt;
  }

  private async runKnowhowAgent(
    exercise: Exercise,
    prompt: string
  ): Promise<{
    success: boolean;
    turns: number;
    cost: number;
    error?: string;
    output?: string;
  }> {
    let turns = 0;
    let totalCost = 0;
    let success = false;
    let error: string | undefined;
    let output = "";
    const toolUsage = {} as Record<string, number>;

    // Check for shutdown before starting agent
    if (this.isShuttingDown) {
      throw new Error("Agent execution cancelled due to shutdown");
    }

    try {
      // Set up event tracking for metrics
      const eventHandlers = {
        threadUpdate: (messages: any) => {
          // Turn count is tracked internally by the agent
          totalCost = this.selectedAgent.getTotalCostUsd();
          turns = this.selectedAgent.getTurnCount();
        },
        [this.selectedAgent.eventTypes.toolUsed]: (call: any) => {
          const name = call.toolCall.function.name;
          toolUsage[name] = toolUsage[name] || 0;
          toolUsage[name] += 1;
        },
        costUpdate: (cost: any) => {
          if (typeof cost === "number") {
            totalCost = cost;
          }
        },
        done: (data: any) => {
          success = !data.error;
          totalCost = this.selectedAgent.getTotalCostUsd();
          turns = this.selectedAgent.getTurnCount();
          if (data.error) {
            error = data.error;
          }
          if (data.output) {
            output = data.output;
          }
        },
      };

      // Add event listeners
      Object.entries(eventHandlers).forEach(([event, handler]) => {
        this.selectedAgent.agentEvents.on(event, handler);
      });

      // Set limits on the agent before calling
      if (this.selectedAgent.setMaxTurns) {
        this.selectedAgent.setMaxTurns(this.config.limits.maxTurns);
      }
      if (this.selectedAgent.setMaxSpend) {
        this.selectedAgent.setMaxSpend(this.config.limits.maxCost);
      }
      if (this.selectedAgent.setMaxRunTime) {
        this.selectedAgent.setMaxRunTime(this.config.limits.maxTime * 1000); // Convert seconds to milliseconds
      }

      this.selectedAgent.messageProcessor.setProcessors("post_call", [
        new XmlToolCallProcessor().createProcessor(),
        new HarmonyToolProcessor().createProcessor(),
      ]);

      // Change to exercise directory
      const originalCwd = process.cwd();
      process.chdir(exercise.path);

      try {
        // Call the agent directly with the prompt
        this.selectedAgent.newTask();
        const result = await this.selectedAgent.call(prompt);

        // Extract final output from result
        if (result && typeof result === "string") {
          output = result;
        } else if (
          result &&
          typeof result === "object" &&
          "content" in result
        ) {
          output = String(result.content);
        }

        success = true;

        // Get turn count from the agent
        if (this.selectedAgent.getTurnCount) {
          turns = this.selectedAgent.getTurnCount();
        }
      } finally {
        // Restore original directory
        process.chdir(originalCwd);

        // Remove event listeners
        Object.entries(eventHandlers).forEach(([event, handler]) => {
          this.selectedAgent.agentEvents.off(event, handler);
        });
      }

      return {
        success,
        turns,
        cost: totalCost,
        output,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        turns,
        cost: totalCost,
        error: errorMessage,
      };
    }
  }

  private runCommand(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      timeout?: number;
    }
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options?.cwd || process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Track child process for cleanup
      this.childProcesses.add(child);

      // Remove from tracking when it exits
      child.on("close", () => {
        this.childProcesses.delete(child);
      });
      child.on("error", () => {
        this.childProcesses.delete(child);
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      const timeout = options?.timeout;
      let timeoutId: NodeJS.Timeout | undefined;
      // Check for shutdown signal during command execution
      if (this.isShuttingDown) {
        child.kill("SIGTERM");
        reject(new Error("Command cancelled due to shutdown"));
        return;
      }

      if (timeout) {
        timeoutId = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Command timed out after ${timeout}ms`));
        }, timeout);
      }

      child.on("close", (code) => {
        if (timeoutId) clearTimeout(timeoutId);

        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr}`));
        }
      });

      child.on("error", (error) => {
        if (timeoutId) clearTimeout(timeoutId);
        reject(error);
      });
    });
  }

  private generateResults(
    results: ExerciseResult[],
    startTime: Date,
    endTime: Date
  ): BenchmarkResults {
    const totalTime = (endTime.getTime() - startTime.getTime()) / 1000;
    const successCount = results.filter((r) => r.status === "success").length;
    const failureCount = results.filter((r) => r.status === "failure").length;
    const timeoutCount = results.filter((r) => r.status === "timeout").length;
    const costLimitCount = results.filter(
      (r) => r.status === "cost_limit"
    ).length;
    const turnLimitCount = results.filter(
      (r) => r.status === "turn_limit"
    ).length;

    // Calculate test-based metrics
    const testableExercises = results.filter(
      (r) => r.testResult !== undefined
    ).length;
    const testsPassedCount = results.filter(
      (r) => r.testResult?.success === true
    ).length;
    const testsFailedCount = results.filter(
      (r) => r.testResult && !r.testResult.success
    ).length;
    const testPassRate =
      testableExercises > 0 ? testsPassedCount / testableExercises : 0;
    const agentSuccessRate = successCount / results.length || 0;
    const actualSuccessRate =
      testableExercises > 0 ? testPassRate : agentSuccessRate;

    const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
    const totalTurns = results.reduce((sum, r) => sum + r.turns, 0);
    const totalExerciseTime = results.reduce(
      (sum, r) => sum + r.timeElapsed,
      0
    );

    return {
      config: this.config,
      exercises: results,
      summary: {
        totalExercises: results.length,
        successCount,
        testableExercises,
        testsPassedCount,
        testsFailedCount,
        testPassRate,
        agentSuccessRate,
        failureCount,
        timeoutCount,
        costLimitCount,
        turnLimitCount,
        totalTime: totalExerciseTime,
        totalCost,
        averageTurns: totalTurns / results.length || 0,
        averageTime: totalExerciseTime / results.length || 0,
        successRate: actualSuccessRate,
      },
      startTime,
      endTime,
    };
  }

  private getCommitHash(): string {
    try {
      // Get the current git commit hash (short format)
      const commitHash = execSync("git rev-parse --short HEAD", {
        encoding: "utf8",
        cwd: process.cwd(),
      }).trim();
      return commitHash;
    } catch (error) {
      // Fallback to a timestamp-based identifier if git is not available
      return `fallback-${Date.now()}`;
    }
  }

  private formatDateDash(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private generateResultsPath(): string {
    const commitHash = this.getCommitHash();
    const dateStr = this.formatDateDash();
    const modelFileName = `${this.provider}-${this.model.replace(
      /\//g,
      "-"
    )}.json`;

    // Use different base paths for local vs container
    const baseDir = process.env.CONTAINER
      ? "/app/knowhow/benchmarks/results"
      : path.join(__dirname, "..", "results");

    return path.join(
      baseDir,
      commitHash,
      dateStr,
      this.provider,
      modelFileName
    );
  }

  private async saveResults(results: BenchmarkResults): Promise<void> {
    // Generate the new structured path
    const resultsPath = this.generateResultsPath();

    // Ensure the directory exists
    await fsasync.mkdir(path.dirname(resultsPath), { recursive: true });
    await fsasync.writeFile(resultsPath, JSON.stringify(results, null, 2));
  }

  private async saveIncrementalResults(
    results: BenchmarkResults
  ): Promise<void> {
    try {
      // Generate the new structured path for incremental results
      const resultsPath = this.generateResultsPath();

      // Ensure the directory exists
      await fsasync.mkdir(path.dirname(resultsPath), { recursive: true });
      await fsasync.writeFile(resultsPath, JSON.stringify(results, null, 2));
      console.log(chalk.gray(`  → Incremental results saved`));
    } catch (error) {
      // Don't crash the benchmark if incremental save fails
      console.log(
        chalk.yellow(
          `  ⚠ Warning: Failed to save incremental results: ${error}`
        )
      );
    }
  }

  private printSummary(results: BenchmarkResults): void {
    console.log(chalk.blue("\n📊 Benchmark Summary"));
    console.log(chalk.gray("━".repeat(50)));
    console.log(
      chalk.white(`Total Exercises: ${results.summary.totalExercises}`)
    );

    if (results.summary.testableExercises > 0) {
      console.log(chalk.blue("\n🧪 Test Evaluation Results:"));
      console.log(
        chalk.white(
          `  Testable exercises: ${results.summary.testableExercises}`
        )
      );
      console.log(
        chalk.green(`  Tests passed: ${results.summary.testsPassedCount}`)
      );
      console.log(
        chalk.red(`  Tests failed: ${results.summary.testsFailedCount}`)
      );
      console.log(
        chalk.white(
          `  Test pass rate: ${(results.summary.testPassRate * 100).toFixed(
            1
          )}%`
        )
      );
      console.log(
        chalk.white(
          `  Agent success rate: ${(
            results.summary.agentSuccessRate * 100
          ).toFixed(1)}%`
        )
      );
      console.log(
        chalk.white(
          `  Overall success rate: ${(
            results.summary.successRate * 100
          ).toFixed(1)}%`
        )
      );
    } else {
      console.log(chalk.blue("\n🤖 Agent Evaluation Results:"));
      console.log(chalk.green(`  Successful: ${results.summary.successCount}`));
      console.log(chalk.red(`  Failed: ${results.summary.failureCount}`));
      console.log(chalk.yellow(`  Timeouts: ${results.summary.timeoutCount}`));
      console.log(
        chalk.yellow(`  Turn limits: ${results.summary.turnLimitCount}`)
      );
      console.log(
        chalk.yellow(`  Cost limits: ${results.summary.costLimitCount}`)
      );
      console.log(
        chalk.white(
          `  Success Rate: ${(results.summary.successRate * 100).toFixed(1)}%`
        )
      );
    }
    console.log(
      chalk.white(`Average Turns: ${results.summary.averageTurns.toFixed(1)}`)
    );
    console.log(
      chalk.white(`Average Time: ${results.summary.averageTime.toFixed(1)}s`)
    );
    console.log(chalk.blue("\n📈 Performance Metrics:"));
    console.log(
      chalk.white(`Total Cost: $${results.summary.totalCost.toFixed(4)}`)
    );
    console.log(chalk.gray(`Results saved to: ${this.generateResultsPath()}`));
  }
}
