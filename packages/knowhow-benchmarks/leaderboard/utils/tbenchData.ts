import { TBenchTask, TBenchSubmission } from '@/types/tbench';

// All 89 Terminal-Bench 2.1 tasks with metadata from GitHub task.toml files
export const ALL_TBENCH_TASKS: TBenchTask[] = [
  { name: 'adaptive-rejection-sampler', category: 'scientific-computing', difficulty: 'medium', inCoreSubset: false },
  { name: 'bn-fit-modify', category: 'scientific-computing', difficulty: 'hard', inCoreSubset: false },
  { name: 'break-filter-js-from-html', category: 'security', difficulty: 'medium', inCoreSubset: false },
  { name: 'build-cython-ext', category: 'debugging', difficulty: 'medium', inCoreSubset: false },
  { name: 'build-pmars', category: 'software-engineering', difficulty: 'medium', inCoreSubset: false },
  { name: 'build-pov-ray', category: 'software-engineering', difficulty: 'medium', inCoreSubset: false },
  { name: 'caffe-cifar-10', category: 'machine-learning', difficulty: 'medium', inCoreSubset: false },
  { name: 'cancel-async-tasks', category: 'software-engineering', difficulty: 'hard', inCoreSubset: false },
  { name: 'chess-best-move', category: 'games', difficulty: 'medium', inCoreSubset: false },
  { name: 'circuit-fibsqrt', category: 'software-engineering', difficulty: 'hard', inCoreSubset: false },
  { name: 'cobol-modernization', category: 'software-engineering', difficulty: 'easy', inCoreSubset: false },
  { name: 'code-from-image', category: 'software-engineering', difficulty: 'medium', inCoreSubset: false },
  { name: 'compile-compcert', category: 'system-administration', difficulty: 'medium', inCoreSubset: false },
  { name: 'configure-git-webserver', category: 'system-administration', difficulty: 'hard', inCoreSubset: false },
  { name: 'constraints-scheduling', category: 'personal-assistant', difficulty: 'medium', inCoreSubset: false },
  { name: 'count-dataset-tokens', category: 'model-training', difficulty: 'medium', inCoreSubset: false },
  { name: 'crack-7z-hash', category: 'security', difficulty: 'medium', inCoreSubset: false },
  { name: 'custom-memory-heap-crash', category: 'debugging', difficulty: 'medium', inCoreSubset: false },
  { name: 'db-wal-recovery', category: 'file-operations', difficulty: 'medium', inCoreSubset: false },
  { name: 'distribution-search', category: 'machine-learning', difficulty: 'medium', inCoreSubset: false },
  { name: 'dna-assembly', category: 'scientific-computing', difficulty: 'hard', inCoreSubset: false },
  { name: 'dna-insert', category: 'scientific-computing', difficulty: 'medium', inCoreSubset: false },
  { name: 'extract-elf', category: 'file-operations', difficulty: 'medium', inCoreSubset: false },
  { name: 'extract-moves-from-video', category: 'file-operations', difficulty: 'hard', inCoreSubset: false },
  { name: 'feal-differential-cryptanalysis', category: 'mathematics', difficulty: 'hard', inCoreSubset: false },
  { name: 'feal-linear-cryptanalysis', category: 'mathematics', difficulty: 'hard', inCoreSubset: false },
  { name: 'filter-js-from-html', category: 'security', difficulty: 'medium', inCoreSubset: false },
  { name: 'financial-document-processor', category: 'data-processing', difficulty: 'medium', inCoreSubset: false },
  { name: 'fix-code-vulnerability', category: 'security', difficulty: 'hard', inCoreSubset: false },
  { name: 'fix-git', category: 'software-engineering', difficulty: 'easy', inCoreSubset: false },
  { name: 'fix-ocaml-gc', category: 'software-engineering', difficulty: 'hard', inCoreSubset: false },
  { name: 'gcode-to-text', category: 'file-operations', difficulty: 'medium', inCoreSubset: false },
  { name: 'git-leak-recovery', category: 'software-engineering', difficulty: 'medium', inCoreSubset: false },
  { name: 'git-multibranch', category: 'system-administration', difficulty: 'medium', inCoreSubset: false },
  { name: 'gpt2-codegolf', category: 'software-engineering', difficulty: 'hard', inCoreSubset: false },
  { name: 'headless-terminal', category: 'software-engineering', difficulty: 'medium', inCoreSubset: false },
  { name: 'hf-model-inference', category: 'data-science', difficulty: 'medium', inCoreSubset: false },
  { name: 'install-windows-3.11', category: 'system-administration', difficulty: 'hard', inCoreSubset: false },
  { name: 'kv-store-grpc', category: 'software-engineering', difficulty: 'medium', inCoreSubset: false },
  { name: 'large-scale-text-editing', category: 'file-operations', difficulty: 'medium', inCoreSubset: false },
  { name: 'largest-eigenval', category: 'mathematics', difficulty: 'medium', inCoreSubset: false },
  { name: 'llm-inference-batching-scheduler', category: 'machine-learning', difficulty: 'hard', inCoreSubset: false },
  { name: 'log-summary-date-ranges', category: 'data-processing', difficulty: 'medium', inCoreSubset: false },
  { name: 'mailman', category: 'system-administration', difficulty: 'medium', inCoreSubset: false },
  { name: 'make-doom-for-mips', category: 'software-engineering', difficulty: 'hard', inCoreSubset: false },
  { name: 'make-mips-interpreter', category: 'software-engineering', difficulty: 'hard', inCoreSubset: false },
  { name: 'mcmc-sampling-stan', category: 'data-science', difficulty: 'hard', inCoreSubset: false },
  { name: 'merge-diff-arc-agi-task', category: 'debugging', difficulty: 'medium', inCoreSubset: false },
  { name: 'model-extraction-relu-logits', category: 'mathematics', difficulty: 'hard', inCoreSubset: false },
  { name: 'modernize-scientific-stack', category: 'scientific-computing', difficulty: 'medium', inCoreSubset: false },
  { name: 'mteb-leaderboard', category: 'data-science', difficulty: 'medium', inCoreSubset: false },
  { name: 'mteb-retrieve', category: 'data-science', difficulty: 'medium', inCoreSubset: false },
  { name: 'multi-source-data-merger', category: 'data-processing', difficulty: 'medium', inCoreSubset: false },
  { name: 'nginx-request-logging', category: 'system-administration', difficulty: 'medium', inCoreSubset: false },
  { name: 'openssl-selfsigned-cert', category: 'security', difficulty: 'medium', inCoreSubset: false },
  { name: 'overfull-hbox', category: 'debugging', difficulty: 'easy', inCoreSubset: false },
  { name: 'password-recovery', category: 'security', difficulty: 'hard', inCoreSubset: false },
  { name: 'path-tracing-reverse', category: 'software-engineering', difficulty: 'hard', inCoreSubset: false },
  { name: 'path-tracing', category: 'software-engineering', difficulty: 'hard', inCoreSubset: false },
  { name: 'polyglot-c-py', category: 'software-engineering', difficulty: 'medium', inCoreSubset: false },
  { name: 'polyglot-rust-c', category: 'software-engineering', difficulty: 'hard', inCoreSubset: false },
  { name: 'portfolio-optimization', category: 'optimization', difficulty: 'medium', inCoreSubset: false },
  { name: 'protein-assembly', category: 'scientific-computing', difficulty: 'hard', inCoreSubset: false },
  { name: 'prove-plus-comm', category: 'software-engineering', difficulty: 'easy', inCoreSubset: false },
  { name: 'pypi-server', category: 'software-engineering', difficulty: 'medium', inCoreSubset: false },
  { name: 'pytorch-model-cli', category: 'model-training', difficulty: 'medium', inCoreSubset: false },
  { name: 'pytorch-model-recovery', category: 'model-training', difficulty: 'medium', inCoreSubset: false },
  { name: 'qemu-alpine-ssh', category: 'system-administration', difficulty: 'medium', inCoreSubset: false },
  { name: 'qemu-startup', category: 'system-administration', difficulty: 'medium', inCoreSubset: false },
  { name: 'query-optimize', category: 'data-science', difficulty: 'medium', inCoreSubset: false },
  { name: 'raman-fitting', category: 'scientific-computing', difficulty: 'medium', inCoreSubset: false },
  { name: 'regex-chess', category: 'software-engineering', difficulty: 'hard', inCoreSubset: false },
  { name: 'regex-log', category: 'data-processing', difficulty: 'medium', inCoreSubset: false },
  { name: 'reshard-c4-data', category: 'data-science', difficulty: 'medium', inCoreSubset: false },
  { name: 'rstan-to-pystan', category: 'data-science', difficulty: 'medium', inCoreSubset: false },
  { name: 'sam-cell-seg', category: 'data-science', difficulty: 'hard', inCoreSubset: false },
  { name: 'sanitize-git-repo', category: 'security', difficulty: 'medium', inCoreSubset: false },
  { name: 'schemelike-metacircular-eval', category: 'software-engineering', difficulty: 'medium', inCoreSubset: false },
  { name: 'sparql-university', category: 'data-querying', difficulty: 'hard', inCoreSubset: false },
  { name: 'sqlite-db-truncate', category: 'debugging', difficulty: 'medium', inCoreSubset: false },
  { name: 'sqlite-with-gcov', category: 'system-administration', difficulty: 'medium', inCoreSubset: false },
  { name: 'torch-pipeline-parallelism', category: 'software-engineering', difficulty: 'hard', inCoreSubset: false },
  { name: 'torch-tensor-parallelism', category: 'software-engineering', difficulty: 'hard', inCoreSubset: false },
  { name: 'train-fasttext', category: 'model-training', difficulty: 'hard', inCoreSubset: false },
  { name: 'tune-mjcf', category: 'scientific-computing', difficulty: 'medium', inCoreSubset: false },
  { name: 'video-processing', category: 'video-processing', difficulty: 'hard', inCoreSubset: false },
  { name: 'vulnerable-secret', category: 'security', difficulty: 'medium', inCoreSubset: false },
  { name: 'winning-avg-corewars', category: 'software-engineering', difficulty: 'medium', inCoreSubset: false },
  { name: 'write-compressor', category: 'software-engineering', difficulty: 'hard', inCoreSubset: false },
];

// Curated 20-task "Knowhow-TBench-Core" subset
// Stratified by category, seed=42, frozen forever for apples-to-apples comparison.
// Selection: 4 software-eng (2 medium, 2 hard), 3 system-admin, 3 data-science,
//            3 debugging, 2 security, 2 scientific-computing, 1 data-processing,
//            1 model-training, 1 mathematics
export const CORE_SUBSET_TASKS: string[] = [
  // software-engineering (4)
  'fix-git',            // easy  - good baseline sanity check
  'kv-store-grpc',      // medium
  'headless-terminal',  // medium
  'cancel-async-tasks', // hard
  // system-administration (3)
  'nginx-request-logging', // medium
  'git-multibranch',       // medium
  'configure-git-webserver', // hard
  // data-science (3)
  'hf-model-inference', // medium
  'query-optimize',     // medium
  'sam-cell-seg',       // hard
  // debugging (3)
  'overfull-hbox',          // easy
  'build-cython-ext',       // medium
  'custom-memory-heap-crash', // medium
  // security (2)
  'openssl-selfsigned-cert', // medium
  'fix-code-vulnerability',  // hard
  // scientific-computing (2)
  'raman-fitting',       // medium
  'protein-assembly',    // hard
  // data-processing (1)
  'financial-document-processor', // medium
  // model-training (1)
  'pytorch-model-cli',  // medium
  // mathematics (1)
  'largest-eigenval',   // medium
];

// Pilot subset — 5 tasks for initial smoke-test run
// Chosen to be fast, diverse, and Docker-friendly
export const PILOT_SUBSET_TASKS: string[] = [
  'fix-git',              // software-engineering / easy / ~5 min
  'overfull-hbox',        // debugging / easy / ~5 min
  'nginx-request-logging',// system-administration / medium / ~10 min
  'largest-eigenval',     // mathematics / medium / ~10 min
  'openssl-selfsigned-cert', // security / medium / ~10 min
];

// Harbor uses the full "terminal-bench/<name>" format for --include-task-name
export const PILOT_SUBSET_HARBOR: string[] = PILOT_SUBSET_TASKS.map(t => `terminal-bench/${t}`);
export const CORE_SUBSET_HARBOR: string[] = CORE_SUBSET_TASKS.map(t => `terminal-bench/${t}`);

// Mark inCoreSubset on the full list
export const TBENCH_TASKS: TBenchTask[] = ALL_TBENCH_TASKS.map(t => ({
  ...t,
  inCoreSubset: CORE_SUBSET_TASKS.includes(t.name),
}));

// Multipliers for estimating historical benchmark spend at current prices.
// These deliberately adjust cost only: benchmark accuracy, tokens and runtime
// are properties of the original run and must not change.
export const TBENCH_PRICE_ADJUSTMENTS: Record<string, number> = {
  'openai/gpt-5.6-luna': 0.20, // 80% price reduction
  'openai/gpt-5.6-terra': 0.80, // 20% price reduction
};

// Published benchmark results. Most entries are official Harbor leaderboard
// submissions parsed from the repository below. Entries from another source
// identify that source explicitly in prUrl/prLabel.
// https://github.com/harbor-framework/terminal-bench-2-1/tree/main/leaderboard/submissions
export const TBENCH_SUBMISSIONS: TBenchSubmission[] = [
  {
    // Artificial Analysis runs every task three times with Terminus 2 in an
    // E2B sandbox and reports mean pass@1. This is independent of DeepSeek's
    // separately published 82.7% result using its unreleased minimal harness.
    id: '2026-08-04-deepseek-v4-flash-0731-max-terminus-2-artificial-analysis',
    date: '2026-08-04',
    displayDate: 'Aug 4, 2026',
    agent: 'terminus-2',
    agentDisplay: 'Terminus 2',
    agentUrl: 'https://github.com/harbor-framework/harbor/tree/main/harbor/agents/terminus_2',
    model: 'deepseek/deepseek-v4-flash-0731',
    modelDisplay: 'DeepSeek V4 Flash 0731',
    reasoningEffort: 'max',
    accuracy: 78.6516853932584,
    accuracyStderr: 2.51,
    nTrials: 267,
    // Artificial Analysis publishes an average cost breakdown per trial.
    totalCostUsd: 8.723797905417182,
    avgTrialDurationSec: 450.77029373973346,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    rewardHacks: 0,
    sourceJobId: '',
    prUrl: 'https://artificialanalysis.ai/evaluations/terminalbench-v2-1',
    prLabel: 'Artificial Analysis',
  },
  {
    id: '2026-05-01-openai-gpt-5-5-xhigh-codex',
    date: '2026-05-01',
    displayDate: 'May 1, 2026',
    agent: 'codex',
    agentDisplay: 'Codex',
    agentUrl: 'https://openai.com/codex/',
    model: 'openai/gpt-5.5',
    modelDisplay: 'GPT-5.5',
    reasoningEffort: 'xhigh',
    accuracy: 83.15,
    accuracyStderr: 1.13,
    nTrials: 445,
    passAt2: 0.8888,
    passAt3: 0.9135,
    passAt4: 0.9303,
    passAt5: 0.9438,
    totalCostUsd: 2059.19,
    avgTrialDurationSec: 482.6,
    uncachedInputTokens: 336797311,
    cachedInputTokens: 392433664,
    outputTokens: 5966373,
    rewardHacks: 0.22,
    sourceJobId: '10e2e56b-ed31-5f65-a489-69f78b902adf',
    prUrl: 'https://github.com/harbor-framework/terminal-bench-2-1/pull/45',
    prLabel: '#45',
  },
  {
    id: '2026-05-01-openai-gpt-5-5-xhigh-terminus-2',
    date: '2026-05-01',
    displayDate: 'May 1, 2026',
    agent: 'terminus-2',
    agentDisplay: 'Terminus 2',
    agentUrl: '',
    model: 'openai/gpt-5.5',
    modelDisplay: 'GPT-5.5',
    reasoningEffort: 'xhigh',
    accuracy: 75.06,
    accuracyStderr: 1.31,
    nTrials: 445,
    passAt5: 0.8764,
    totalCostUsd: 893.45,
    avgTrialDurationSec: 391.2,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    rewardHacks: 0,
    sourceJobId: '',
  },
  {
    id: '2026-05-01-anthropic-claude-opus-4-7-max-claude-code',
    date: '2026-05-01',
    displayDate: 'May 1, 2026',
    agent: 'claude-code',
    agentDisplay: 'Claude Code',
    agentUrl: 'https://www.anthropic.com/claude-code',
    model: 'anthropic/claude-opus-4',
    modelDisplay: 'Claude Opus 4',
    reasoningEffort: 'max',
    accuracy: 72.81,
    accuracyStderr: 1.35,
    nTrials: 445,
    passAt5: 0.8539,
    totalCostUsd: 1247.63,
    avgTrialDurationSec: 523.8,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    rewardHacks: 0,
    sourceJobId: '',
  },
  {
    id: '2026-05-01-anthropic-claude-opus-4-7-max-terminus-2',
    date: '2026-05-01',
    displayDate: 'May 1, 2026',
    agent: 'terminus-2',
    agentDisplay: 'Terminus 2',
    agentUrl: '',
    model: 'anthropic/claude-opus-4',
    modelDisplay: 'Claude Opus 4',
    reasoningEffort: 'max',
    accuracy: 67.42,
    accuracyStderr: 1.42,
    nTrials: 445,
    passAt5: 0.8090,
    totalCostUsd: 687.22,
    avgTrialDurationSec: 445.1,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    rewardHacks: 0,
    sourceJobId: '',
  },
  {
    id: '2026-05-01-gemini-gemini-3-pro-preview-high-gemini-cli',
    date: '2026-05-01',
    displayDate: 'May 1, 2026',
    agent: 'gemini-cli',
    agentDisplay: 'Gemini CLI',
    agentUrl: '',
    model: 'gemini/gemini-3-pro-preview',
    modelDisplay: 'Gemini 3 Pro Preview',
    reasoningEffort: 'high',
    accuracy: 61.35,
    accuracyStderr: 1.48,
    nTrials: 445,
    passAt5: 0.7663,
    totalCostUsd: 412.80,
    avgTrialDurationSec: 398.4,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    rewardHacks: 0,
    sourceJobId: '',
  },
  {
    id: '2026-07-09-anthropic-claude-opus-4-8-high-claude-code',
    date: '2026-07-09',
    displayDate: 'Jul 9, 2026',
    agent: 'claude-code',
    agentDisplay: 'Claude Code',
    agentUrl: 'https://www.anthropic.com/claude-code',
    model: 'anthropic/claude-opus-4',
    modelDisplay: 'Claude Opus 4 (Jul)',
    reasoningEffort: 'high',
    accuracy: 78.43,
    accuracyStderr: 1.25,
    nTrials: 445,
    passAt5: 0.8989,
    totalCostUsd: 934.12,
    avgTrialDurationSec: 487.3,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    rewardHacks: 0,
    sourceJobId: '',
  },
  {
    id: '2026-07-09-anthropic-claude-sonnet-5-high-claude-code',
    date: '2026-07-09',
    displayDate: 'Jul 9, 2026',
    agent: 'claude-code',
    agentDisplay: 'Claude Code',
    agentUrl: 'https://www.anthropic.com/claude-code',
    model: 'anthropic/claude-sonnet-5',
    modelDisplay: 'Claude Sonnet 5',
    reasoningEffort: 'high',
    accuracy: 71.24,
    accuracyStderr: 1.37,
    nTrials: 445,
    passAt5: 0.8427,
    totalCostUsd: 298.56,
    avgTrialDurationSec: 412.7,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    rewardHacks: 0,
    sourceJobId: '',
  },
  {
    id: '2026-07-11-openai-gpt-5-6-luna-max-codex',
    date: '2026-07-11',
    displayDate: 'Jul 11, 2026',
    agent: 'codex',
    agentDisplay: 'Codex',
    agentUrl: 'https://openai.com/codex/',
    model: 'openai/gpt-5.6-luna',
    modelDisplay: 'GPT-5.6 Luna',
    reasoningEffort: 'max',
    accuracy: 75.73,
    accuracyStderr: 1.32,
    nTrials: 445,
    passAt2: 0.8348,
    passAt3: 0.864,
    passAt4: 0.8787,
    passAt5: 0.8876,
    totalCostUsd: 241.45,
    avgTrialDurationSec: 457.3,
    uncachedInputTokens: 40023670,
    cachedInputTokens: 1376567117,
    outputTokens: 10628905,
    rewardHacks: 0.9,
    sourceJobId: '4860a28f-bc1a-5367-9885-57ff9ccc3a15',
    prUrl: 'https://github.com/harbor-framework/terminal-bench-2-1/pull/112',
    prLabel: '#112',
  },
  {
    id: '2026-07-11-openai-gpt-5-6-terra-max-codex',
    date: '2026-07-11',
    displayDate: 'Jul 11, 2026',
    agent: 'codex',
    agentDisplay: 'Codex',
    agentUrl: 'https://openai.com/codex/',
    model: 'openai/gpt-5.6-terra',
    modelDisplay: 'GPT-5.6 Terra',
    reasoningEffort: 'max',
    accuracy: 79.10,
    accuracyStderr: 1.23,
    nTrials: 445,
    passAt5: 0.9101,
    totalCostUsd: 398.72,
    avgTrialDurationSec: 463.8,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    rewardHacks: 0,
    sourceJobId: '',
  },
];

export const CATEGORY_COLORS: Record<string, string> = {
  'software-engineering': '#3b82f6',
  'system-administration': '#8b5cf6',
  'data-science': '#10b981',
  'debugging': '#f59e0b',
  'security': '#ef4444',
  'scientific-computing': '#06b6d4',
  'data-processing': '#84cc16',
  'model-training': '#f97316',
  'mathematics': '#ec4899',
  'machine-learning': '#14b8a6',
  'file-operations': '#a78bfa',
  'data-querying': '#fb923c',
  'optimization': '#4ade80',
  'personal-assistant': '#94a3b8',
  'games': '#fbbf24',
  'video-processing': '#c084fc',
};

export const DIFFICULTY_COLORS: Record<string, string> = {
  easy: '#22c55e',
  medium: '#f59e0b',
  hard: '#ef4444',
};
