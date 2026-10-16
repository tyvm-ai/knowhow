'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LeaderboardEntry } from '@/types/benchmark';
import { formatCurrency, formatTime, formatPercentage } from '@/utils/dataProcessor';

interface LeaderboardTableProps {
  entries: LeaderboardEntry[];
  showLanguageColumn?: boolean;
  showToolModeColumn?: boolean;
  selectedEntryKey?: string | null;
}

type SortField = keyof LeaderboardEntry;
type SortDirection = 'asc' | 'desc';

export const leaderboardEntryKey = (entry: LeaderboardEntry) =>
  `${entry.model}-${entry.provider}-${entry.language}-${entry.toolMode}`;

export default function LeaderboardTable({
  entries, showLanguageColumn = true, showToolModeColumn = true, selectedEntryKey,
}: LeaderboardTableProps) {
  const router = useRouter();
  const [sortField, setSortField] = useState<SortField>('successRate');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const sortedEntries = [...entries].sort((a, b) => {
    const aValue = a[sortField];
    const bValue = b[sortField];
    
    let comparison = 0;
    if (typeof aValue === 'string' && typeof bValue === 'string') {
      comparison = aValue.localeCompare(bValue);
    } else if (typeof aValue === 'number' && typeof bValue === 'number') {
      comparison = aValue - bValue;
    }
    
    return sortDirection === 'asc' ? comparison : -comparison;
  });

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return '↕️';
    return sortDirection === 'asc' ? '↑' : '↓';
  };

  const getStatusColor = (successRate: number) => {
    if (successRate >= 90) return 'text-green-400';
    if (successRate >= 70) return 'text-yellow-400';
    return 'text-red-400';
  };

  const handleRowClick = (entry: LeaderboardEntry) => {
    const model = encodeURIComponent(entry.model);
    const provider = encodeURIComponent(entry.provider);
    const language = encodeURIComponent(entry.language);
    router.push(`/details/${model}/${provider}/${language}`);
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-max w-full overflow-hidden rounded-lg border border-gray-700 bg-gray-900 shadow-sm">
        <thead className="bg-gray-800">
          <tr>
            <th 
              className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700"
              onClick={() => handleSort('model')}
            >
              Model {getSortIcon('model')}
            </th>
            <th
              className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700"
              onClick={() => handleSort('provider')}
            >
              Provider {getSortIcon('provider')}
            </th>
            <th
              className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700"
              onClick={() => handleSort('harness')}
            >
              Harness {getSortIcon('harness')}
            </th>
            {showLanguageColumn && (
              <th 
                className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700"
                onClick={() => handleSort('language')}
              >
                Language {getSortIcon('language')}
              </th>
            )}
            {showToolModeColumn && (
              <th
                className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700"
                onClick={() => handleSort('toolMode')}
              >
                Tools {getSortIcon('toolMode')}
              </th>
            )}
            <th
              className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700"
              onClick={() => handleSort('successRate')}
            >
              Success Rate {getSortIcon('successRate')}
            </th>
            <th 
              className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700"
              onClick={() => handleSort('totalExercises')}
            >
              Exercises {getSortIcon('totalExercises')}
            </th>
            <th 
              className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700"
              onClick={() => handleSort('averageCost')}
            >
              Avg Cost {getSortIcon('averageCost')}
            </th>
            <th 
              className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700"
              onClick={() => handleSort('averageTime')}
            >
              Avg Time {getSortIcon('averageTime')}
            </th>
            <th 
              className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700"
              onClick={() => handleSort('averageTurns')}
            >
              Avg Turns {getSortIcon('averageTurns')}
            </th>
            <th 
              className="px-4 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700"
              onClick={() => handleSort('totalInputTokens')}
            >
              Input Tokens {getSortIcon('totalInputTokens')}
            </th>
            <th 
              className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700"
              onClick={() => handleSort('totalRuns')}
            >
              Runs {getSortIcon('totalRuns')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800 bg-gray-900">
          {sortedEntries.map((entry) => (
            <tr
              key={leaderboardEntryKey(entry)}
              data-leaderboard-key={leaderboardEntryKey(entry)}
              className={`cursor-pointer transition-colors duration-150 ${selectedEntryKey === leaderboardEntryKey(entry)
                ? 'bg-blue-950 ring-2 ring-inset ring-blue-500' : 'hover:bg-gray-800'}`}
              onClick={() => handleRowClick(entry)}
            >
              <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-100">
                {entry.model}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                {entry.provider}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                {entry.harness}
              </td>
              {showLanguageColumn && (
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                  {entry.language}
                </td>
              )}
              {showToolModeColumn && (
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    entry.toolMode === 'lazy'
                      ? 'bg-purple-950 text-purple-300'
                      : 'bg-gray-700 text-gray-200'
                  }`}>
                    {entry.toolMode === 'lazy' ? '🦥 lazy' : '⚡ eager'}
                  </span>
                </td>
              )}
              <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${getStatusColor(entry.successRate)}`}>
                {formatPercentage(entry.successRate)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                {entry.totalExercises}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                {formatCurrency(entry.averageCost)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                {formatTime(entry.averageTime)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                {entry.averageTurns.toFixed(1)}
              </td>
              <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-400">
                {entry.totalInputTokens > 0 ? entry.totalInputTokens.toLocaleString() : '—'}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                {entry.totalRuns}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}