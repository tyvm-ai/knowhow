export interface BenchmarkConfig {
  language: string;
  maxExercises: number;
  model: string;
  provider: string;
  agent?: string; // Agent type to use (default: 'Patcher')
  limits: BenchmarkLimits;
  outputFile: string;
}

export interface BenchmarkLimits {
  maxTurns: number;
  maxTime: number; // in seconds
  maxCost: number; // in dollars
}

export interface ExerciseResult {
  exerciseName: string;
  status: 'success' | 'failure' | 'timeout' | 'cost_limit' | 'turn_limit';
  turns: number;
  timeElapsed: number; // in seconds
  cost: number; // in dollars
  startTime: Date;
  endTime: Date;
  errorMessage?: string;
  finalOutput?: string;
}

export interface BenchmarkResults {
  config: BenchmarkConfig;
  exercises: ExerciseResult[];
  summary: {
    totalExercises: number;
    successCount: number;
    failureCount: number;
    timeoutCount: number;
    costLimitCount: number;
    turnLimitCount: number;
    totalTime: number;
    totalCost: number;
    averageTurns: number;
    averageTime: number;
    successRate: number;
  };
  startTime: Date;
  endTime: Date;
}

export interface Exercise {
  name: string;
  path: string;
  description?: string;
  hasTests: boolean;
  files: string[];
}