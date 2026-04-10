import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { BenchmarkResults } from '@/types/benchmark';

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

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const model = searchParams.get('model');
  const provider = searchParams.get('provider');
  const language = searchParams.get('language');
  const timestamp = searchParams.get('timestamp'); // Optional parameter to get specific run

  if (!model || !provider || !language) {
    return NextResponse.json(
      { error: 'Missing required parameters: model, provider, language' },
      { status: 400 }
    );
  }

  try {
    // Look for benchmark result files in the results directory
    const resultsDir = path.join(process.cwd(), '..', 'benchmarks', 'results');

    if (!fs.existsSync(resultsDir)) {
      return NextResponse.json(
        { error: 'Results directory not found' },
        { status: 404 }
      );
    }

    // Find all JSON files recursively in the results directory
    const allFiles = findBenchmarkFiles(resultsDir);

    // Filter files that match our model/provider/language criteria
    const matchingFiles = allFiles.filter(filePath => {
      try {
        // Read and parse the JSON file to check its config
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(fileContent);

        if (!data.config) {
          return false;
        }

        const configModel = data.config.model;
        const configProvider = data.config.provider;
        const configLanguage = data.config.language;

        // Exact match on all three parameters
        return configModel === model &&
               configProvider === provider &&
               configLanguage === language;
      } catch (error) {
        return false;
      }
    });

    if (matchingFiles.length === 0) {
      return NextResponse.json(
        { error: 'No benchmark results found for the specified model, provider, and language' },
        { status: 404 }
      );
    }

    // Load all matching benchmark results
    const allResults: BenchmarkResults[] = [];
    const filePathMap = new Map<BenchmarkResults, string>(); // Track file paths for commit extraction

    for (const filePath of matchingFiles) {
      try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const benchmarkData = JSON.parse(fileContent);

        // Validate that we have the expected structure
        if (benchmarkData.exercises && benchmarkData.summary && benchmarkData.config) {
          allResults.push(benchmarkData);
          filePathMap.set(benchmarkData, filePath);
        }
      } catch (parseError) {
        console.error(`Error parsing file ${filePath}:`, parseError);
        // Continue with other files
      }
    }

    if (allResults.length === 0) {
      return NextResponse.json(
        { error: 'No valid benchmark results found' },
        { status: 404 }
      );
    }

    // Sort results by endTime (most recent first)
    allResults.sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime());

    // If timestamp is provided, return that specific run
    if (timestamp) {
      const targetTime = timestamp;
      const specificRun = allResults.find(result => result.endTime === targetTime);

      if (specificRun) {
        return NextResponse.json({
          latest: specificRun,
          history: [], // Don't need history for specific run view
          totalRuns: allResults.length
        });
      }
    }

    // Get the most recent result as the main data
    const latestResult = allResults[0];

    // Create historical summary for previous runs (excluding the latest)
    const previousRuns = allResults; // Skip the first (latest) result
    const historicalRuns = previousRuns.map(result => ({
      endTime: result.endTime,
      successRate: result.summary.successRate * 100, // Convert to percentage
      totalExercises: result.summary.totalExercises,
      totalCost: result.summary.totalCost,
      averageTime: result.summary.averageTime,
      averageTurns: result.summary.averageTurns,
      // Include commit info if available
      commitHash: result.commitHash || 'unknown',
      // Calculate average cost per exercise
      averageCost: result.summary.totalCost / result.summary.totalExercises
    }));

    // Return both the latest detailed result and historical summary
    const response = {
      // Latest detailed benchmark data
      latest: latestResult,
      // Historical performance summary
      history: historicalRuns,
      // Total number of runs
      totalRuns: allResults.length
    };

    return NextResponse.json(response);


  } catch (error) {
    console.error('Error reading benchmark detail:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
