import { ExerciseEvaluator, TestResult } from './types';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export class JavaScriptEvaluator implements ExerciseEvaluator {
  language = 'javascript';

  canEvaluate(exercisePath: string): boolean {
    // Check for package.json with test script or jest config
    const packageJsonPath = path.join(exercisePath, 'package.json');
    
    if (!fs.existsSync(packageJsonPath)) {
      return false;
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      
      // Check if there's a test script or jest configuration
      return !!(
        packageJson.scripts?.test ||
        packageJson.devDependencies?.jest ||
        packageJson.dependencies?.jest ||
        packageJson.jest ||
        fs.existsSync(path.join(exercisePath, 'jest.config.js')) ||
        fs.existsSync(path.join(exercisePath, 'jest.config.json'))
      );
    } catch (error) {
      return false;
    }
  }

  async evaluate(exercisePath: string): Promise<TestResult> {
    try {
      // First try to install dependencies if node_modules doesn't exist
      const nodeModulesPath = path.join(exercisePath, 'node_modules');
      if (!fs.existsSync(nodeModulesPath)) {
        try {
          execSync('npm install', { 
            cwd: exercisePath, 
            stdio: 'pipe',
            timeout: 60000 // 60 second timeout
          });
        } catch (installError) {
          // Continue anyway, maybe dependencies are not needed
          console.warn(`Failed to install dependencies in ${exercisePath}:`, installError);
        }
      }

      // Try to run tests with JSON output
      let command = 'npm test';
      
      // Check if we can use Jest directly with JSON reporter
      const packageJsonPath = path.join(exercisePath, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        
        // If jest is available, use it directly with JSON reporter
        if (packageJson.devDependencies?.jest || packageJson.dependencies?.jest) {
          command = 'npx jest --json --verbose';
        } else if (packageJson.scripts?.test) {
          // Try to modify the test script to include JSON output
          const testScript = packageJson.scripts.test;
          if (testScript.includes('jest')) {
            command = `${testScript} --json --verbose`;
          }
        }
      }

      const output = execSync(command, {
        cwd: exercisePath,
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 120000 // 2 minute timeout for tests
      });

      return this.parseJestOutput(output);

    } catch (error: any) {
      // Jest exits with non-zero code when tests fail, so we need to parse the output
      if (error.stdout) {
        try {
          return this.parseJestOutput(error.stdout);
        } catch (parseError) {
          // If JSON parsing fails, try to extract basic info from text output
          return this.parseTextOutput(error.stdout || error.stderr || '');
        }
      }

      return {
        passed: 0,
        failed: 0,
        total: 0,
        success: false,
        output: error.message || 'Test execution failed',
        errorMessage: error.message,
        details: error
      };
    }
  }

  private parseJestOutput(output: string): TestResult {
    try {
      // Try to find JSON output in the string
      const lines = output.split('\n');
      let jsonLine = '';
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && (trimmed.includes('"success"') || trimmed.includes('"numTotalTests"'))) {
          jsonLine = trimmed;
          break;
        }
      }

      if (jsonLine) {
        const result = JSON.parse(jsonLine);
        
        return {
          passed: result.numPassedTests || 0,
          failed: result.numFailedTests || 0,
          total: result.numTotalTests || 0,
          skipped: result.numPendingTests || 0,
          success: result.success || false,
          output: output,
          details: result
        };
      }
    } catch (error) {
      // Fall back to text parsing
    }

    return this.parseTextOutput(output);
  }

  private parseTextOutput(output: string): TestResult {
    // Try to parse Jest text output
    let passed = 0;
    let failed = 0;
    let total = 0;
    let success = false;

    // Look for Jest summary patterns
    const passedMatch = output.match(/(\d+) passed/);
    const failedMatch = output.match(/(\d+) failed/);
    const totalMatch = output.match(/(\d+) total/);

    if (passedMatch) passed = parseInt(passedMatch[1]);
    if (failedMatch) failed = parseInt(failedMatch[1]);
    if (totalMatch) total = parseInt(totalMatch[1]);

    // If we couldn't find specific numbers, try other patterns
    if (total === 0) {
      // Look for "Tests: " summary
      const testsMatch = output.match(/Tests:\s+(\d+)\s+failed,\s+(\d+)\s+passed,\s+(\d+)\s+total/);
      if (testsMatch) {
        failed = parseInt(testsMatch[1]);
        passed = parseInt(testsMatch[2]);
        total = parseInt(testsMatch[3]);
      } else {
        // Look for individual test results
        const testResults = output.match(/✓|✗|PASS|FAIL/g);
        if (testResults) {
          total = testResults.length;
          passed = testResults.filter(r => r === '✓' || r === 'PASS').length;
          failed = total - passed;
        }
      }
    }

    success = failed === 0 && total > 0;

    return {
      passed,
      failed,
      total,
      success,
      output,
      errorMessage: success ? undefined : 'Some tests failed'
    };
  }
}