import { Message } from '../../clients/types';

// Basic trace event interface
export interface TraceEvent {
  id: string;
  type: string;
  timestamp: number;
  data: any;
}

// Trace metrics for performance monitoring
export interface TraceMetrics {
  executionTimeMs: number;
  toolCallCount: number;
  llmCallCount: number;
  tokenUsage: {
    prompt: number;
    completion: number;
    total: number;
  };
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
  };
  costUsd: number;
}

// Complete execution trace
export interface ExecutionTrace {
  id: string;
  startTime: number;
  endTime: number;
  events: TraceEvent[];
  metrics: TraceMetrics;
  success: boolean;
  error?: string;
}

// Resource quotas for script execution
export interface ResourceQuotas {
  maxToolCalls: number;
  maxTokens: number;
  maxExecutionTimeMs: number;
  maxCostUsd: number;
  maxMemoryMb: number;
}

// Security policy configuration
export interface SecurityPolicy {
  allowlistedTools: string[];
  denylistedTools: string[];
  maxScriptLength: number;
  allowNetworkAccess: boolean;
  allowFileSystemAccess: boolean;
}

// Current quota usage tracking
export interface QuotaUsage {
  toolCalls: number;
  tokens: number;
  executionTimeMs: number;
  costUsd: number;
}

// Policy violation record
export interface PolicyViolation {
  id: string;
  type: 'quota_exceeded' | 'tool_denied' | 'tool_not_allowed' | 'script_validation';
  message: string;
  timestamp: number;
  usage: QuotaUsage;
}

// Script execution request
export interface ExecutionRequest {
  script: string;
  context?: Record<string, any>;
  quotas?: Partial<ResourceQuotas>;
  policy?: Partial<SecurityPolicy>;
}

// Script execution result
export interface ExecutionResult {
  success: boolean;
  error: string | null;
  result: any;
  trace: ExecutionTrace;
  artifacts: Artifact[];
  consoleOutput: string[];
}

// Artifact created by script
export interface Artifact {
  id: string;
  name: string;
  type: 'text' | 'json' | 'csv' | 'html' | 'markdown';
  content: string;
  createdAt: string;
}

// Tool execution result
export interface ToolResult {
  success: boolean;
  result?: any;
  error?: string;
}

// Tool call record
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  result?: any;
  error?: string;
  timestamp: number;
  duration?: number;
}

// LLM call record
export interface LLMCall {
  id: string;
  model: string;
  messages: Message[];
  response?: any;
  error?: string;
  timestamp: number;
  duration?: number;
  tokenUsage?: {
    prompt: number;
    completion: number;
    total: number;
  };
  cost?: number;
}