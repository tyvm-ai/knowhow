export interface TestResult {
  passed: number;
  failed: number;
  total: number;
  skipped?: number;
  success: boolean;
  output: string;
  errorMessage?: string;
  details?: any; // Raw test runner output
}

export interface ExerciseEvaluator {
  language: string;
  canEvaluate(exercisePath: string): boolean;
  evaluate(exercisePath: string): Promise<TestResult>;
}

export interface TestEvaluationResult {
  exerciseName: string;
  testResult: TestResult;
  evaluatedBy: string; // Which evaluator was used
}