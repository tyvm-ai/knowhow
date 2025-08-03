import { NextRequest, NextResponse } from 'next/server';
import { BenchmarkResults, LeaderboardEntry } from '@/types/benchmark';
import fs from 'fs';
import path from 'path';

export async function GET(request: NextRequest) {
  try {
    const results = await loadAllBenchmarkResults();

    const leaderboardData = aggregateResults(results);
    return NextResponse.json(leaderboardData);
  } catch (error) {
    console.error('Error loading benchmark results:', error);
    
    // Return mock data for development
    const mockData: LeaderboardEntry[] = [
      {
        model: 'sample-model',
        provider: 'sample-provider',
        language: 'javascript',
        successRate: 85.5,
        totalExercises: 6,
        averageCost: 0.05,
        averageTime: 145.2,
        averageTurns: 12.4,
        totalRuns: 1,
        lastRun: new Date().toISOString()
      }
    ];
    
    return NextResponse.json(mockData);
  }
}

async function loadAllBenchmarkResults(): Promise<BenchmarkResults[]> {
  const resultsPath = path.join(process.cwd(), '..', 'benchmarks', 'results');
  const results: BenchmarkResults[] = [];

  if (!fs.existsSync(resultsPath)) {
    console.warn('Benchmark results directory not found:', resultsPath);
    return results;
  }

  // Recursively scan the directory structure: commit-hash/date/provider/model.json
  const commitDirs = fs.readdirSync(resultsPath, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  for (const commitHash of commitDirs) {
    const commitPath = path.join(resultsPath, commitHash);
    const dateDirs = fs.readdirSync(commitPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const dateDir of dateDirs) {
      const datePath = path.join(commitPath, dateDir);
      const providerDirs = fs.readdirSync(datePath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      for (const providerDir of providerDirs) {
        const providerPath = path.join(datePath, providerDir);
        const resultFiles = fs.readdirSync(providerPath, { withFileTypes: true })
          .filter(dirent => dirent.isFile() && dirent.name.endsWith('.json'))
          .map(dirent => dirent.name);

        for (const resultFile of resultFiles) {
          try {
            const filePath = path.join(providerPath, resultFile);
            const data = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(data);
            results.push(parsed);
          } catch (error) {
            console.error(`Error loading result file ${resultFile}:`, error);
          }
        }
      }
    }
  }

  return results;
}
function aggregateResults(results: BenchmarkResults[]): LeaderboardEntry[] {
  const entries: LeaderboardEntry[] = [];
  
  for (const result of results) {
    const entry: LeaderboardEntry = {
      model: result.config.model,
      provider: result.config.provider,
      language: result.config.language,
      successRate: result.summary.successRate * 100, // Convert from decimal to percentage
      totalExercises: result.summary.totalExercises,
      averageCost: result.summary.totalCost / result.summary.totalExercises,
      averageTime: result.summary.averageTime,
      averageTurns: result.summary.averageTurns,
      totalRuns: 1,
      lastRun: result.endTime
    };
    
    entries.push(entry);
  }
  
  return entries;
}