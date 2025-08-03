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

// Recursive function to find JSON files in nested directories
function findBenchmarkFiles(dir: string): string[] {
  const files: string[] = [];
  
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      
      if (item.isDirectory()) {
        // Recursively search subdirectories
        files.push(...findBenchmarkFiles(fullPath));
      } else if (item.isFile() && item.name.endsWith('.json')) {
        // Add JSON files to our list
        files.push(fullPath);
      }
    }
  } catch (error) {
    // Ignore directories we can't read
  }
  
  return files;
}

async function loadAllBenchmarkResults(): Promise<BenchmarkResults[]> {
  const resultsPath = path.join(process.cwd(), '..', 'benchmarks', 'results');
  const results: BenchmarkResults[] = [];

  if (!fs.existsSync(resultsPath)) {
    console.warn('Benchmark results directory not found:', resultsPath);
    return results;
  }

  // Find all JSON files recursively - handles both old and new file structures
  const allFiles = findBenchmarkFiles(resultsPath);
  
  for (const filePath of allFiles) {
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(data);
      
      // Validate that this is a valid benchmark result
      if (parsed.config && parsed.summary && parsed.exercises) {
        results.push(parsed);
      }
    } catch (error) {
      console.error(`Error loading result file ${filePath}:`, error);
    }
  }

  return results;
}

function aggregateResults(results: BenchmarkResults[]): LeaderboardEntry[] {
  const entriesMap = new Map<string, LeaderboardEntry>();
  
  for (const result of results) {
    const key = `${result.config.model}-${result.config.provider}-${result.config.language}`;
    
    if (entriesMap.has(key)) {
      // Keep track of total runs, but only show most recent performance
      const existing = entriesMap.get(key)!;
      
      // Increment total runs count
      existing.totalRuns = existing.totalRuns + 1;
      
      // If this result is more recent, replace the performance data
      if (result.endTime > existing.lastRun) {
        existing.successRate = result.summary.successRate * 100; // Convert from decimal to percentage
        existing.totalExercises = result.summary.totalExercises;
        existing.averageCost = result.summary.totalCost / result.summary.totalExercises;
        existing.averageTime = result.summary.averageTime;
        existing.averageTurns = result.summary.averageTurns;
        existing.lastRun = result.endTime;
      }
    } else {
      // Create new entry
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
      
      entriesMap.set(key, entry);
    }
  }
  
  return Array.from(entriesMap.values());
}