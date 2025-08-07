import { ExerciseEvaluator, TestResult, TestEvaluationResult } from './types';
import { JavaScriptEvaluator } from './JavaScriptEvaluator';

export class EvaluatorRegistry {
  private evaluators: ExerciseEvaluator[] = [];

  constructor() {
    // Register default evaluators
    this.registerEvaluator(new JavaScriptEvaluator());
  }

  registerEvaluator(evaluator: ExerciseEvaluator): void {
    this.evaluators.push(evaluator);
  }

  evalForExercise(exercisePath: string): ExerciseEvaluator | null {
    return this.evaluators.find(e => e.canEvaluate(exercisePath)) || null;
  }

  async evaluateExercise(exercisePath: string, exerciseName: string): Promise<TestEvaluationResult | null> {
    // Find the first evaluator that can handle this exercise
    const evaluator = this.evalForExercise(exercisePath);

    if (!evaluator) {
      console.warn(`No evaluator found for exercise: ${exerciseName} at ${exercisePath}`);
      return null;
    }

    try {
      console.log(`Evaluating ${exerciseName} using ${evaluator.language} evaluator...`);
      const testResult = await evaluator.evaluate(exercisePath);

      return {
        exerciseName,
        testResult,
        evaluatedBy: evaluator.language
      };
    } catch (error) {
      console.error(`Error evaluating exercise ${exerciseName}:`, error);

      // Return a failed test result instead of null
      return {
        exerciseName,
        testResult: {
          passed: 0,
          failed: 0,
          total: 0,
          success: false,
          output: '',
          errorMessage: `Evaluation failed: ${error instanceof Error ? error.message : String(error)}`
        },
        evaluatedBy: evaluator.language
      };
    }
  }

  getAvailableEvaluators(): string[] {
    return this.evaluators.map(e => e.language);
  }

  canEvaluateExercise(exercisePath: string): boolean {
    return this.evaluators.some(e => e.canEvaluate(exercisePath));
  }
}
