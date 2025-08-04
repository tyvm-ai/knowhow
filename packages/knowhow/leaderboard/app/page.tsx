'use client';

import { useState, useEffect } from 'react';
import { loadLeaderboardData } from '@/utils/dataProcessor';
import LeaderboardTable from '@/components/LeaderboardTable';
import PerformanceChart from '@/components/PerformanceChart';
import { LeaderboardEntry } from '@/types/benchmark';

export default function Home() {
  const [leaderboardEntries, setLeaderboardEntries] = useState<LeaderboardEntry[]>([]);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      const data = await loadLeaderboardData();
      setLeaderboardEntries(data);
      setLoading(false);
    }
    fetchData();
  }, []);

  // Extract unique languages for dropdown
  const availableLanguages = Array.from(new Set(leaderboardEntries.map(entry => entry.language))).sort();
  
  // Filter entries by selected language
  const filteredEntries = selectedLanguage === 'all' 
    ? leaderboardEntries 
    : leaderboardEntries.filter(entry => entry.language === selectedLanguage);

  // Update statistics to use filtered data
  const totalModels = filteredEntries.length;
  const totalExercises = filteredEntries.reduce((sum, entry) => sum + entry.totalExercises, 0);
  const averageSuccessRate = filteredEntries.length > 0 
    ? filteredEntries.reduce((sum, entry) => sum + entry.successRate, 0) / filteredEntries.length 
    : 0;

  const handleLanguageChange = (language: string) => {
    setSelectedLanguage(language);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-500 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading benchmark results...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Benchmark Results Leaderboard</h1>
          <p className="mt-2 text-gray-600">
            Track and compare model performance across coding exercises
          </p>
          
          {/* Language Filter Dropdown */}
          {availableLanguages.length > 1 && (
            <div className="mt-4">
              <label htmlFor="language-select" className="block text-sm font-medium text-gray-700 mb-2">
                Filter by Language:
              </label>
              <select
                id="language-select"
                value={selectedLanguage}
                onChange={(e) => handleLanguageChange(e.target.value)}
                className="block w-48 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              >
                <option value="all">All Languages</option>
                {availableLanguages.map((language) => (
                  <option key={language} value={language}>
                    {language.charAt(0).toUpperCase() + language.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-blue-500 rounded-md flex items-center justify-center">
                  <span className="text-white font-bold">M</span>
                </div>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">Total Models</p>
                <p className="text-2xl font-semibold text-gray-900">{totalModels}</p>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-green-500 rounded-md flex items-center justify-center">
                  <span className="text-white font-bold">E</span>
                </div>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">Total Exercises</p>
                <p className="text-2xl font-semibold text-gray-900">{totalExercises}</p>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-yellow-500 rounded-md flex items-center justify-center">
                  <span className="text-white font-bold">%</span>
                </div>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">Average Success Rate</p>
                <p className="text-2xl font-semibold text-gray-900">{averageSuccessRate.toFixed(1)}%</p>
              </div>
            </div>
          </div>
        </div>

        {/* Charts */}
        {filteredEntries.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
            <PerformanceChart entries={filteredEntries} chartType="success-rate" selectedLanguage={selectedLanguage} />
            <PerformanceChart entries={filteredEntries} chartType="cost-vs-performance" selectedLanguage={selectedLanguage} />
          </div>
        )}

        {/* Leaderboard Table */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-xl font-semibold text-gray-900">Leaderboard</h2>
            <p className="mt-1 text-sm text-gray-500">
              Compare model performance across all benchmark runs
            </p>
          </div>
          <div className="p-6">
            {filteredEntries.length > 0 ? (
              <LeaderboardTable entries={filteredEntries} showLanguageColumn={selectedLanguage === 'all'} />
            ) : (
              <div className="text-center py-12">
                <div className="text-gray-400 text-6xl mb-4">📊</div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">No benchmark results found</h3>
                <p className="text-gray-500">
                  Run some benchmarks to see results here. Results should be placed in the 
                  <code className="bg-gray-100 px-2 py-1 rounded text-sm mx-1">benchmarks/results</code> directory.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 text-center text-sm text-gray-500">
          <p>Last updated: {new Date().toLocaleString()}</p>
        </div>
      </div>
    </div>
  );
}