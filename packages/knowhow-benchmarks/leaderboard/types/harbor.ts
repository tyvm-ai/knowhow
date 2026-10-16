export interface HarborDatasetRef {
  /** Harbor Hub dataset name, for example terminal-bench/terminal-bench-2-1. */
  name: string;
  /** Immutable Harbor dataset digest/ref recorded on the job. */
  ref?: string;
}

export interface HarborTaskMetadata {
  name: string;
  category?: string;
  difficulty?: string;
  description?: string;
  sourceUrl?: string;
}

export type HarborTrialStatus = 'pass' | 'fail' | 'error' | 'timeout';

export interface HarborTaskResult {
  taskName: string;
  trials: Array<{
    reward: number;
    durationSec: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    status: HarborTrialStatus;
    errorMessage?: string;
    trialId?: string;
  }>;
  passRate: number;
  avgDurationSec: number;
  avgCostUsd: number;
}

export interface HarborRunRow {
  submissionId: string;
  dataset: HarborDatasetRef;
  agent: string;
  agentDisplay: string;
  model: string;
  modelDisplay: string;
  reasoningEffort: string;
  date: string;
  accuracy: number;
  accuracyStderr: number;
  passAt5?: number;
  totalCostUsd: number;
  avgCostPerTask: number;
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
  taskResults?: HarborTaskResult[];
}

export interface HarborDatasetSummary extends HarborDatasetRef {
  jobCount: number;
  latestRunAt?: string;
}

export interface HarborDataResponse {
  dataset: string;
  datasets: HarborDatasetSummary[];
  rows: HarborRunRow[];
  tasks: HarborTaskMetadata[];
  refreshedAt: string;
}
