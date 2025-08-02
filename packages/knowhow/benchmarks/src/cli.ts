#!/usr/bin/env node

import { Command } from 'commander';
import { BenchmarkRunner } from './runner';
import { BenchmarkConfig } from './types';
import chalk from 'chalk';

const program = new Command();

program
  .name('knowhow-bench')
  .description('Benchmark Knowhow terminal agent against coding exercises')
  .version('0.0.1');

program
  .command('run')
  .description('Run benchmarks against Exercism exercises')
  .option('-l, --language <language>', 'Programming language to test', 'javascript')
  .option('-c, --count <count>', 'Maximum number of exercises to run', '10')
  .option('-m, --model <model>', 'AI model to use', 'gpt-4o-mini')
  .option('-p, --provider <provider>', 'AI provider to use', 'openai')
  .option('--max-turns <turns>', 'Maximum turns per exercise', '30')
  .option('--max-time <seconds>', 'Maximum time per exercise in seconds', '300')
  .option('--max-cost <dollars>', 'Maximum cost per exercise in dollars', '1.0')
  .option('--output <file>', 'Output file for results', 'results.json')
  .action(async (options) => {
    try {
      console.log(chalk.blue('🚀 Starting Knowhow benchmarks...'));

      const config: BenchmarkConfig = {
        language: options.language,
        maxExercises: parseInt(options.count),
        model: options.model,
        provider: options.provider,
        limits: {
          maxTurns: parseInt(options.maxTurns),
          maxTime: parseInt(options.maxTime),
          maxCost: parseFloat(options.maxCost)
        },
        outputFile: options.output
      };

      const runner = new BenchmarkRunner(config);
      await runner.run();

      console.log(chalk.green('✅ Benchmarks completed successfully!'));
    } catch (error) {
      console.error(chalk.red('❌ Benchmark failed:'), error);
      process.exit(1);
    }
  });

program
  .command('setup')
  .description('Set up exercises for benchmarking')
  .option('-l, --language <language>', 'Programming language to setup', 'javascript')
  .option('-c, --count <count>', 'Maximum number of exercises to setup', '10')
  .action(async (options) => {
    try {
      console.log(chalk.blue('📦 Setting up exercises...'));

      const runner = new BenchmarkRunner({
        language: options.language,
        maxExercises: parseInt(options.count),
        model: 'gpt-4o-mini', // Dummy values for setup
        provider: 'openai',
        limits: { maxTurns: 20, maxTime: 300, maxCost: 1.0 },
        outputFile: 'results.json'
      });

      await runner.setupExercises();

      console.log(chalk.green('✅ Exercises setup completed!'));
    } catch (error) {
      console.error(chalk.red('❌ Setup failed:'), error);
      process.exit(1);
    }
  });

program.parse();
