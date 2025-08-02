import { spawn } from "child_process";
import { promises as fs } from "fs";
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

export class BenchmarkRunner {
  private config: BenchmarkConfig;
  private exercisesDir: string;
  private knowhowPath: string;
  private defaultServices = services.services();
  private defaultAgents = agents.agents(this.defaultServices);
  private selectedAgent: any;

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
  }

  async initializeServices(): Promise<void> {
    const spinner = ora("Initializing Knowhow services...").start();

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

      // Register configured models
      await this.defaultServices.Clients.registerConfiguredModels();

      // Set agent model preferences
      this.selectedAgent.setModelPreferences([
        { model: this.config.model, provider: this.config.provider as any },
      ]);

      spinner.succeed("Services initialized successfully");
    } catch (error) {
      spinner.fail("Failed to initialize services");
      throw error;
    }
  }

  async setupExercises(): Promise<void> {
    const spinner = ora("Setting up exercises...").start();

    try {
      // Run the clone script
      await this.runCommand("bash", [
        path.join(__dirname, "..", "scripts", "clone-exercism.sh"),
        this.config.language,
        this.config.maxExercises.toString(),
      ]);

      spinner.succeed("Exercises setup completed");
    } catch (error) {
      spinner.fail("Failed to setup exercises");
      throw error;
    }
  }

  async run(): Promise<BenchmarkResults> {
    console.log(chalk.blue(`Running benchmarks with config:`));
    console.log(chalk.gray(`  Language: ${this.config.language}`));
    await this.initializeServices();
    console.log(chalk.gray(`  Max exercises: ${this.config.maxExercises}`));
    console.log(chalk.gray(`  Model: ${this.config.model}`));
    console.log(chalk.gray(`  Provider: ${this.config.provider}`));

    const startTime = new Date();
    await this.setupExercises();
    const exercises = await this.discoverExercises();
    const results: ExerciseResult[] = [];

    console.log(chalk.blue(`\nFound ${exercises.length} exercises to run\n`));

    for (const exercise of exercises) {
      console.log(chalk.yellow(`Running exercise: ${exercise.name}`));

      const result = await this.runExercise(exercise);
      results.push(result);

      // Log result
      const statusColor = result.status === "success" ? chalk.green : chalk.red;
      console.log(statusColor(`  Status: ${result.status}`));
      console.log(chalk.gray(`  Turns: ${result.turns}`));
      console.log(chalk.gray(`  Time: ${result.timeElapsed.toFixed(2)}s`));
      console.log(chalk.gray(`  Cost: $${result.cost.toFixed(4)}\n`));
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
      const exerciseNames = await fs.readdir(filteredDir);
      const exercises: Exercise[] = [];

      for (const name of exerciseNames) {
        const exercisePath = path.join(filteredDir, name);
        const stat = await fs.stat(exercisePath);

        if (stat.isDirectory()) {
          const files = await fs.readdir(exercisePath);
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
    const turns = 0;
    const cost = 0;

    try {
      // Create the benchmark prompt for the exercise
      const prompt = await this.createExercisePrompt(exercise);

      // Run knowhow agent on the exercise
      const result = await this.runKnowhowAgent(exercise, prompt);

      const endTime = new Date();
      const timeElapsed = (endTime.getTime() - startTime.getTime()) / 1000;

      return {
        exerciseName: exercise.name,
        status: result.success ? "success" : "failure",
        turns: result.turns,
        timeElapsed,
        cost: result.cost,
        startTime,
        endTime,
        errorMessage: result.error,
        finalOutput: result.output,
      };
    } catch (error) {
      const endTime = new Date();
      const timeElapsed = (endTime.getTime() - startTime.getTime()) / 1000;

      return {
        exerciseName: exercise.name,
        status: "failure",
        turns,
        timeElapsed,
        cost,
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
      const description = await fs.readFile(descriptionPath, "utf-8");
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
    prompt += `Work in the current directory where all the exercise files are located.`;

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

    try {
      // Set up event tracking for metrics
      const eventHandlers = {
        threadsUpdate: (data: any) => {
          if (data.threads && data.threads.length > 0) {
            turns = data.threads[0].messages.length;
          }
        },
        costUpdate: (data: any) => {
          if (data.cost !== undefined) {
            totalCost = data.cost;
          }
        },
        done: (data: any) => {
          success = !data.error;
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

      // Change to exercise directory
      const originalCwd = process.cwd();
      process.chdir(exercise.path);

      try {
        // Call the agent directly with the prompt
        const result = await this.selectedAgent.call(prompt, {
          maxTurns: this.config.limits.maxTurns,
          maxCost: this.config.limits.maxCost,
          maxTime: this.config.limits.maxTime * 1000,
        });

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
        failureCount,
        timeoutCount,
        costLimitCount,
        turnLimitCount,
        totalTime: totalExerciseTime,
        totalCost,
        averageTurns: totalTurns / results.length || 0,
        averageTime: totalExerciseTime / results.length || 0,
        successRate: successCount / results.length || 0,
      },
      startTime,
      endTime,
    };
  }

  private async saveResults(results: BenchmarkResults): Promise<void> {
    // Use different paths for local vs container
    const resultsDir = process.env.CONTAINER
      ? "/app/knowhow/benchmarks/results"
      : path.join(__dirname, "..", "results");

    const resultsPath = path.join(resultsDir, this.config.outputFile);
    await fs.mkdir(path.dirname(resultsPath), { recursive: true });
    await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
  }

  private printSummary(results: BenchmarkResults): void {
    console.log(chalk.blue("\n📊 Benchmark Summary"));
    console.log(chalk.gray("━".repeat(50)));
    console.log(
      chalk.white(`Total Exercises: ${results.summary.totalExercises}`)
    );
    console.log(chalk.green(`Successful: ${results.summary.successCount}`));
    console.log(chalk.red(`Failed: ${results.summary.failureCount}`));
    console.log(chalk.yellow(`Timeouts: ${results.summary.timeoutCount}`));
    console.log(
      chalk.white(
        `Success Rate: ${(results.summary.successRate * 100).toFixed(1)}%`
      )
    );
    console.log(
      chalk.white(`Average Turns: ${results.summary.averageTurns.toFixed(1)}`)
    );
    console.log(
      chalk.white(`Average Time: ${results.summary.averageTime.toFixed(1)}s`)
    );
    console.log(
      chalk.white(`Total Cost: $${results.summary.totalCost.toFixed(4)}`)
    );
    console.log(chalk.gray(`Results saved to: ${this.config.outputFile}`));
  }
}
