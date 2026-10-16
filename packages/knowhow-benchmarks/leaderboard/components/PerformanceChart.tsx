'use client';

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ScatterChart, Scatter } from 'recharts';
import { LeaderboardEntry } from '@/types/benchmark';
import { formatCurrency, formatPercentage } from '@/utils/dataProcessor';

interface PerformanceChartProps {
  entries: LeaderboardEntry[];
  selectedLanguage?: string;
  chartType?: 'success-rate' | 'cost-vs-performance';
  onEntrySelect?: (entry: LeaderboardEntry) => void;
}

export default function PerformanceChart({
  entries,
  selectedLanguage = 'all',
  chartType = 'success-rate',
  onEntrySelect,
}: PerformanceChartProps) {
  if (chartType === 'success-rate') {
    const chartData = [...entries]
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, 10) // Show top 10
      .map(entry => ({
        name: selectedLanguage === 'all' ? `${entry.model} (${entry.language})` : entry.model,
        successRate: entry.successRate,
        exercises: entry.totalExercises,
      }));

    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-6 shadow-sm">
        <h3 className="mb-4 text-lg font-semibold text-gray-100">Success Rate Comparison</h3>
        <ResponsiveContainer width="100%" height={400}>
          <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid stroke="#374151" strokeDasharray="3 3" />
            <XAxis 
              dataKey="name" 
              angle={-45}
              textAnchor="end"
              height={100}
              fontSize={12}
              stroke="#9CA3AF"
            />
            <YAxis 
              domain={[0, 100]}
              tickFormatter={(value) => `${value}%`}
              stroke="#9CA3AF"
            />
            <Tooltip 
              contentStyle={{ backgroundColor: '#1F2937', borderColor: '#4B5563', color: '#F3F4F6' }}
              itemStyle={{ color: '#F3F4F6' }}
              labelStyle={{ color: '#F3F4F6' }}
              formatter={(value: number, name: string) => [
                name === 'successRate' ? formatPercentage(value) : value,
                name === 'successRate' ? 'Success Rate' : 'Exercises'
              ]}
            />
            <Legend />
            <Bar dataKey="successRate" fill="#3B82F6" name="Success Rate (%)" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Cost vs Performance scatter plot
  const scatterData = entries.map(entry => ({
    name: selectedLanguage === 'all' ? `${entry.model} (${entry.language})` : entry.model,
    cost: entry.averageCost,
    successRate: entry.successRate,
    exercises: entry.totalExercises,
    entry,
  }));

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900 p-6 shadow-sm">
      <h3 className="mb-4 text-lg font-semibold text-gray-100">Cost vs Performance</h3>
      <ResponsiveContainer width="100%" height={400}>
        <ScatterChart data={scatterData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
          <CartesianGrid stroke="#374151" strokeDasharray="3 3" />
          <XAxis 
            dataKey="cost" 
            type="number"
            tickFormatter={(value) => formatCurrency(value)}
            name="Average Cost"
            stroke="#9CA3AF"
            label={{
              value: 'Average cost per exercise (USD)',
              position: 'insideBottom',
              offset: -12,
              style: { fill: '#D1D5DB', fontSize: 12 },
            }}
          />
          <YAxis 
            dataKey="successRate" 
            type="number"
            domain={[0, 100]}
            tickFormatter={(value) => `${value}%`}
            name="Success Rate"
            stroke="#9CA3AF"
          />
          <Tooltip 
            formatter={(value: number, name: string) => {
              if (name === 'cost') return [formatCurrency(value), 'Average Cost'];
              if (name === 'successRate') return [formatPercentage(value), 'Success Rate'];
              return [value, name];
            }}
            labelFormatter={() => ''}
            content={({ active, payload }) => {
              if (active && payload && payload.length) {
                const data = payload[0].payload;
                return (
                  <div className="rounded border border-gray-600 bg-gray-800 p-3 text-gray-100 shadow-lg">
                    <p className="font-medium text-gray-100">{data.name}</p>
                    <p className="text-gray-300">Harness: {data.entry.harness}</p>
                    <p className="text-blue-400">Success Rate: {formatPercentage(data.successRate)}</p>
                    <p className="text-green-400">Average Cost: {formatCurrency(data.cost)}</p>
                    <p className="text-gray-300">Exercises: {data.exercises}</p>
                  </div>
                );
              }
              return null;
            }}
          />
          <Scatter
            dataKey="successRate"
            fill="#3B82F6"
            className={onEntrySelect ? 'cursor-pointer' : undefined}
            onClick={(point) => {
              if (point?.entry) onEntrySelect?.(point.entry);
            }}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}