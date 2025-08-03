export interface BenchmarkConfig {
  language: string;
  maxExercises: number;
  model: string;
  provider: string;
  agent?: string;
  limits: BenchmarkLimits;
  outputFile: string;
}

export interface BenchmarkLimits {
  maxTurns: number;
  maxTime: number;
  maxCost: number;
}

export interface ExerciseResult {
  exerciseName: string;
  status: 'success' | 'failure' | 'timeout' | 'cost_limit' | 'turn_limit';
  testResult?: any;
  turns: number;
  timeElapsed: number;
  cost: number;
  startTime: string;
  endTime: string;
  errorMessage?: string;
  finalOutput?: string;
}

export interface BenchmarkResults {
  config: BenchmarkConfig;
  exercises: ExerciseResult[];
  summary: {
    totalExercises: number;
    testableExercises?: number;
    testsPassedCount?: number;
    testsFailedCount?: number;
    testPassRate?: number;
    agentSuccessRate?: number;
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
  startTime: string;
  endTime: string;
}

export interface LeaderboardEntry {
  model: string;
  provider: string;
  language: string;
  successRate: number;
  totalExercises: number;
  averageCost: number;
  averageTime: number;
  averageTurns: number;
  totalRuns: number;
  lastRun: string;
}