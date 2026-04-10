'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LeaderboardEntry } from '@/types/benchmark';
import { formatCurrency, formatTime, formatPercentage } from '@/utils/dataProcessor';

interface LeaderboardTableProps {
  entries: LeaderboardEntry[];
  showLanguageColumn?: boolean;
}

type SortField = keyof LeaderboardEntry;
type SortDirection = 'asc' | 'desc';

export default function LeaderboardTable({ entries, showLanguageColumn = true }: LeaderboardTableProps) {
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
    if (successRate >= 90) return 'text-green-600';
    if (successRate >= 70) return 'text-yellow-600';
    return 'text-red-600';
  };

  const handleRowClick = (entry: LeaderboardEntry) => {
    const model = encodeURIComponent(entry.model);
    const provider = encodeURIComponent(entry.provider);
    const language = encodeURIComponent(entry.language);
    router.push(`/details/${model}/${provider}/${language}`);
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full bg-white border border-gray-200 rounded-lg shadow-sm">
        <thead className="bg-gray-50">
          <tr>
            <th 
              className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
              onClick={() => handleSort('model')}
            >
              Model {getSortIcon('model')}
            </th>
            <th 
              className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
              onClick={() => handleSort('provider')}
            >
              Provider {getSortIcon('provider')}
            </th>
            {showLanguageColumn && (
              <th 
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('language')}
              >
                Language {getSortIcon('language')}
              </th>
            )}
            <th 
              className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
              onClick={() => handleSort('successRate')}
            >
              Success Rate {getSortIcon('successRate')}
            </th>
            <th 
              className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
              onClick={() => handleSort('totalExercises')}
            >
              Exercises {getSortIcon('totalExercises')}
            </th>
            <th 
              className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
              onClick={() => handleSort('averageCost')}
            >
              Avg Cost {getSortIcon('averageCost')}
            </th>
            <th 
              className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
              onClick={() => handleSort('averageTime')}
            >
              Avg Time {getSortIcon('averageTime')}
            </th>
            <th 
              className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
              onClick={() => handleSort('averageTurns')}
            >
              Avg Turns {getSortIcon('averageTurns')}
            </th>
            <th 
              className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
              onClick={() => handleSort('totalRuns')}
            >
              Runs {getSortIcon('totalRuns')}
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {sortedEntries.map((entry) => (
            <tr 
              key={`${entry.model}-${entry.provider}-${entry.language}`} 
              className="hover:bg-gray-50 cursor-pointer transition-colors duration-150"
              onClick={() => handleRowClick(entry)}
              title="Click to view detailed results"
            >
              <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                {entry.model}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {entry.provider}
              </td>
              {showLanguageColumn && (
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {entry.language}
                </td>
              )}
              <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${getStatusColor(entry.successRate)}`}>
                {formatPercentage(entry.successRate)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {entry.totalExercises}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {formatCurrency(entry.averageCost)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {formatTime(entry.averageTime)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {entry.averageTurns.toFixed(1)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {entry.totalRuns}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}