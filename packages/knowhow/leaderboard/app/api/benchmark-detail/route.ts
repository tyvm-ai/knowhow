import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { BenchmarkResults } from '@/types/benchmark';

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
    const resultsDir = path.join(process.cwd(), 'results');
    
    if (!fs.existsSync(resultsDir)) {
      return NextResponse.json(
        { error: 'Results directory not found' },
        { status: 404 }
      );
    }

    // Search for matching benchmark result files
    const files = fs.readdirSync(resultsDir);
    const matchingFiles = files.filter(file => {
      // Look for files that match the pattern and contain our model/provider/language
      return file.endsWith('.json') && 
             file.includes(model.toLowerCase()) &&
             file.includes(provider.toLowerCase()) &&
             file.includes(language.toLowerCase());
    });

    if (matchingFiles.length === 0) {
      return NextResponse.json(
        { error: 'No benchmark results found for the specified model, provider, and language' },
        { status: 404 }
      );
    }

    // Use the most recent file (assuming timestamp in filename)
    const latestFile = matchingFiles.sort().reverse()[0];
    const filePath = path.join(resultsDir, latestFile);
    
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