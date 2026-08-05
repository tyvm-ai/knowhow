import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_HARBOR_DATASET, discoverHarborDatasets, loadHarborDataset } from '@/utils/harborData';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const dataset = request.nextUrl.searchParams.get('dataset') || DEFAULT_HARBOR_DATASET;
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(dataset)) {
    return NextResponse.json({ error: 'dataset must be an organization/dataset name' }, { status: 400 });
  }

  const datasets = discoverHarborDatasets();
  if (!datasets.some(item => item.name === dataset)) {
    datasets.push({ name: dataset, jobCount: 0 });
    datasets.sort((a, b) => a.name.localeCompare(b.name));
  }
  const data = loadHarborDataset(dataset);
  return NextResponse.json({ dataset, datasets, ...data, refreshedAt: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-store' } });
}
