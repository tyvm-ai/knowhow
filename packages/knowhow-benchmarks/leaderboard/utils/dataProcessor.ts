import { LeaderboardEntry } from '@/types/benchmark';

export async function loadLeaderboardData(): Promise<LeaderboardEntry[]> {
  try {
    const response = await fetch('/api/benchmark-data');
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error loading benchmark results:', error);
    return [];
  }
}

export function formatPercentage(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatCurrency(value: number): string {
  return `$${value.toFixed(3)}`;
}

export function formatTime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(1)}s`;
}

export function formatNumber(value: number): string {
  return value.toFixed(1);
}