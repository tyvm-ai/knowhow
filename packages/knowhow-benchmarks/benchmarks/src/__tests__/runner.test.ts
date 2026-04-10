import { BenchmarkRunner } from '../runner';
import { BenchmarkConfig } from '../types';

describe('BenchmarkRunner', () => {
  const mockConfig: BenchmarkConfig = {
    language: 'javascript',
    maxExercises: 5,
    model: 'gpt-4o-mini',
    provider: 'openai',
    limits: {
      maxTurns: 20,
      maxTime: 300,
      maxCost: 1.0
    },
    outputFile: 'test-results.json'
  };

  it('should create a BenchmarkRunner instance', () => {
    const runner = new BenchmarkRunner(mockConfig);
    expect(runner).toBeInstanceOf(BenchmarkRunner);
  });

  it('should have the correct configuration', () => {
    const runner = new BenchmarkRunner(mockConfig);
    expect(runner['config']).toEqual(mockConfig);
  });
});