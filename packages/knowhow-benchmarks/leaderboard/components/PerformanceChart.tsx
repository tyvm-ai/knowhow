'use client';

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ScatterChart, Scatter } from 'recharts';
import { LeaderboardEntry } from '@/types/benchmark';
import { formatCurrency, formatPercentage } from '@/utils/dataProcessor';

interface PerformanceChartProps {
  entries: LeaderboardEntry[];
  selectedLanguage?: string;
  chartType?: 'success-rate' | 'cost-vs-performance';
}

export default function PerformanceChart({ entries, selectedLanguage = 'all', chartType = 'success-rate' }: PerformanceChartProps) {
  if (chartType === 'success-rate') {
    const chartData = entries
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, 10) // Show top 10
      .map(entry => ({
        name: selectedLanguage === 'all' ? `${entry.model} (${entry.language})` : entry.model,
        successRate: entry.successRate,
        exercises: entry.totalExercises,
      }));

    return (
      <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Success Rate Comparison</h3>
        <ResponsiveContainer width="100%" height={400}>
          <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis 
              dataKey="name" 
              angle={-45}
              textAnchor="end"
              height={100}
              fontSize={12}
            />
            <YAxis 
              domain={[0, 100]}
              tickFormatter={(value) => `${value}%`}
            />
            <Tooltip 
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
  }));

  return (
    <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Cost vs Performance</h3>
      <ResponsiveContainer width="100%" height={400}>
        <ScatterChart data={scatterData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis 
            dataKey="cost" 
            type="number"
            tickFormatter={(value) => formatCurrency(value)}
            name="Average Cost"
          />
          <YAxis 
            dataKey="successRate" 
            type="number"
            domain={[0, 100]}
            tickFormatter={(value) => `${value}%`}
            name="Success Rate"
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
                  <div className="bg-white p-3 border border-gray-200 rounded shadow-lg">
                    <p className="font-medium">{data.name}</p>
                    <p className="text-blue-600">Success Rate: {formatPercentage(data.successRate)}</p>
                    <p className="text-green-600">Average Cost: {formatCurrency(data.cost)}</p>
                    <p className="text-gray-600">Exercises: {data.exercises}</p>
                  </div>
                );
              }
              return null;
            }}
          />
          <Scatter dataKey="successRate" fill="#3B82F6" />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}