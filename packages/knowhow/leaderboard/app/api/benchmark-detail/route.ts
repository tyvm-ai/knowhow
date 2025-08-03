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

    // Use the most recent file (sort by full path to get most recent based on directory structure)
    const latestFile = matchingFiles.sort().reverse()[0];
    const filePath = latestFile; // Already a full path from our recursive search
    
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    let benchmarkData: BenchmarkResults;
    
    try {
      benchmarkData = JSON.parse(fileContent);
    } catch (parseError) {
      return NextResponse.json(
        { error: 'Invalid JSON in benchmark result file' },
        { status: 500 }
      );
    }

    // Validate that we have the expected structure
    if (!benchmarkData.exercises || !benchmarkData.summary || !benchmarkData.config) {
      return NextResponse.json(
        { error: 'Invalid benchmark data structure' },
        { status: 500 }
      );
    }

    return NextResponse.json(benchmarkData);
    
  } catch (error) {
    console.error('Error reading benchmark detail:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}