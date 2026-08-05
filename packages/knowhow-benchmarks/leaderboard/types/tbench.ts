// Terminal-Bench 2.1 types

export interface TBenchTask {
  name: string;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard';
  description?: string;
  inCoreSubset: boolean;
}

export interface TBenchSubmission {
  id: string; // filename stem e.g. "2026-05-01-openai-gpt-5-5-xhigh-codex"
  date: string;
  displayDate: string;
  agent: string;
  agentDisplay: string;
  agentUrl: string;
  model: string;
  modelDisplay: string;
  reasoningEffort: string;
  accuracy: number;
  accuracyStderr: number;
  nTrials: number;
  passAt2?: number;
  passAt3?: number;
  passAt4?: number;
  passAt5?: number;
  totalCostUsd: number;
  avgTrialDurationSec: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  rewardHacks: number;
  sourceJobId: string;
  prUrl?: string;
  prLabel?: string;
}

export interface TBenchTrialResult {
  taskName: string;
  reward: number; // 0.0 to 1.0
  trialId?: string;
}

export interface TBenchKnowhowRunConfig {
  model: string;
  provider: string;
  reasoningEffort?: string;
  agent: string;
  trialsPerTask: number;
  taskSubset: string[]; // task names
  runDate: string;
  commitHash?: string;
}

export interface TBenchKnowhowTaskResult {
  taskName: string;
  trials: Array<{
    reward: number;
    durationSec: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    status: 'pass' | 'fail' | 'error' | 'timeout';
    errorMessage?: string;
  }>;
  passRate: number; // fraction of trials that passed
  avgDurationSec: number;
  avgCostUsd: number;
}

export interface TBenchKnowhowResults {
  config: TBenchKnowhowRunConfig;
  tasks: TBenchKnowhowTaskResult[];
  summary: {
    totalTasks: number;
    totalTrials: number;
    overallPassRate: number; // mean of per-task pass rates (= accuracy)
    totalCostUsd: number;
    avgCostPerTask: number;
    avgDurationSec: number;
    tasksWon: number; // tasks where passRate > 0
    successfulTrials: number;
  };
}

// For display in the leaderboard comparison table
export interface TBenchLeaderboardRow {
  submissionId: string;
  agent: string;
  agentDisplay: string;
  model: string;
  modelDisplay: string;
  reasoningEffort: string;
  date: string;
  accuracy: number;
  accuracyStderr: number;
  passAt5?: number;
  totalCostUsd: number; // normalized cost for one trial across all tasks
  avgCostPerTask: number; // published total / tasks / trials per task
  // Historical submissions retain their reported spend. This multiplier lets
  // the UI estimate that same token usage at today's model prices.
  priceAdjustmentFactor?: number;
  avgTrialDurationSec: number;
  isKnowhow: boolean;
  nTasks: number;
  nTrials: number;
  runStatus?: 'running' | 'completed' | 'failed';
  completedTrials?: number;
  runningTrials?: number;
  pendingTrials?: number;
  updatedAt?: string;
  jobName?: string;
  // per-task results if available (Knowhow runs)
  taskResults?: TBenchKnowhowTaskResult[];
}
