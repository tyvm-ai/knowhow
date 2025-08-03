"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { BenchmarkResults, ExerciseResult } from "@/types/benchmark";
import {
  formatCurrency,
  formatTime,
  formatPercentage,
} from "@/utils/dataProcessor";

export default function ModelDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [benchmarkData, setBenchmarkData] = useState<BenchmarkResults | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const model = decodeURIComponent(params.model as string);
  const provider = decodeURIComponent(params.provider as string);
  const language = decodeURIComponent(params.language as string);

  useEffect(() => {
    async function fetchDetailData() {
      try {
        const response = await fetch(
          `/api/benchmark-detail?model=${encodeURIComponent(
            model
          )}&provider=${encodeURIComponent(
            provider
          )}&language=${encodeURIComponent(language)}`
        );
        if (!response.ok) {
          throw new Error("Failed to fetch benchmark details");
        }
        const data = await response.json();
        setBenchmarkData(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setLoading(false);
      }
    }

    fetchDetailData();
  }, [model, provider, language]);

  const getStatusBadge = (status: string) => {
    const baseClasses = "px-2 py-1 text-xs font-medium rounded-full";
    switch (status) {
      case "success":
        return `${baseClasses} bg-green-100 text-green-800`;
      case "failure":
        return `${baseClasses} bg-red-100 text-red-800`;
      case "timeout":
        return `${baseClasses} bg-yellow-100 text-yellow-800`;
      case "cost_limit":
        return `${baseClasses} bg-orange-100 text-orange-800`;
      case "turn_limit":
        return `${baseClasses} bg-purple-100 text-purple-800`;
      default:
        return `${baseClasses} bg-gray-100 text-gray-800`;
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "success":
        return "✅";
      case "failure":
        return "❌";
      case "timeout":
        return "⏰";
      case "cost_limit":
        return "💰";
      case "turn_limit":
        return "🔄";
      default:
        return "❓";
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-500 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading benchmark details...</p>
        </div>
      </div>
    );
  }

  if (error || !benchmarkData) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-red-500 text-6xl mb-4">⚠️</div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            Error Loading Details
          </h3>
          <p className="text-gray-500 mb-4">
            {error || "Benchmark data not found"}
          </p>
          <button
            onClick={() => router.back()}
            className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <button
            onClick={() => router.back()}
            className="mb-4 text-blue-600 hover:text-blue-800 flex items-center"
          >
            ← Back to Leaderboard
          </button>
          <h1 className="text-3xl font-bold text-gray-900">
            Benchmark Details: {model}
          </h1>
          <p className="mt-2 text-gray-600">
            Provider: {provider} • Language: {language}
          </p>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-green-500 rounded-md flex items-center justify-center">
                  <span className="text-white font-bold">%</span>
                </div>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">
                  Success Rate
                </p>
                <p className="text-2xl font-semibold text-gray-900">
                  {formatPercentage(benchmarkData.summary.successRate * 100)}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-blue-500 rounded-md flex items-center justify-center">
                  <span className="text-white font-bold">E</span>
                </div>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">
                  Total Exercises
                </p>
                <p className="text-2xl font-semibold text-gray-900">
                  {benchmarkData.summary.totalExercises}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-yellow-500 rounded-md flex items-center justify-center">
                  <span className="text-white font-bold">$</span>
                </div>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">Total Cost</p>
                <p className="text-2xl font-semibold text-gray-900">
                  {formatCurrency(benchmarkData.summary.totalCost)}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-purple-500 rounded-md flex items-center justify-center">
                  <span className="text-white font-bold">T</span>
                </div>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">Total Time</p>
                <p className="text-2xl font-semibold text-gray-900">
                  {formatTime(benchmarkData.summary.totalTime)}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Exercise Results Table */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-xl font-semibold text-gray-900">
              Exercise Results
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Detailed breakdown of each exercise performance
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Exercise
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Pass / Total
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Time
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Cost
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Turns
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Output
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {benchmarkData.exercises.map((exercise, index) => (
                  <tr key={exercise.exerciseName} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {exercise.exerciseName}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <span className="mr-2">
                          {getStatusIcon(
                            exercise.testResult?.success ? "success" : "failure"
                          )}
                        </span>
                        <span
                          className={getStatusBadge(
                            exercise.testResult?.success
                          )}
                        >
                          {exercise.testResult?.success ? "Pass" : "Fail"}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {exercise.testResult?.passed} /{" "}
                      {exercise.testResult?.total}{" "}
                      <div>
                        {exercise.testResult?.skipped
                          ? `(${exercise.testResult?.skipped} skipped)`
                          : ""}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatTime(exercise.timeElapsed)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatCurrency(exercise.cost)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {exercise.turns}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500 max-w-xs truncate">
                      {exercise.finalOutput?.slice(0, 100) || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Run Information */}
        <div className="mt-8 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Run Information
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h4 className="text-sm font-medium text-gray-500 mb-2">
                Configuration
              </h4>
              <dl className="space-y-1">
                <div className="flex">
                  <dt className="text-sm text-gray-500 w-24">Model:</dt>
                  <dd className="text-sm text-gray-900">
                    {benchmarkData.config.model}
                  </dd>
                </div>
                <div className="flex">
                  <dt className="text-sm text-gray-500 w-24">Provider:</dt>
                  <dd className="text-sm text-gray-900">
                    {benchmarkData.config.provider}
                  </dd>
                </div>
                <div className="flex">
                  <dt className="text-sm text-gray-500 w-24">Language:</dt>
                  <dd className="text-sm text-gray-900">
                    {benchmarkData.config.language}
                  </dd>
                </div>
                {benchmarkData.config.agent && (
                  <div className="flex">
                    <dt className="text-sm text-gray-500 w-24">Agent:</dt>
                    <dd className="text-sm text-gray-900">
                      {benchmarkData.config.agent}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
            <div>
              <h4 className="text-sm font-medium text-gray-500 mb-2">Limits</h4>
              <dl className="space-y-1">
                <div className="flex">
                  <dt className="text-sm text-gray-500 w-24">Max Turns:</dt>
                  <dd className="text-sm text-gray-900">
                    {benchmarkData.config.limits.maxTurns}
                  </dd>
                </div>
                <div className="flex">
                  <dt className="text-sm text-gray-500 w-24">Max Time:</dt>
                  <dd className="text-sm text-gray-900">
                    {formatTime(benchmarkData.config.limits.maxTime)}
                  </dd>
                </div>
                <div className="flex">
                  <dt className="text-sm text-gray-500 w-24">Max Cost:</dt>
                  <dd className="text-sm text-gray-900">
                    {formatCurrency(benchmarkData.config.limits.maxCost)}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-gray-200">
            <div className="flex justify-between text-sm text-gray-500">
              <span>
                Started: {new Date(benchmarkData.startTime).toLocaleString()}
              </span>
              <span>
                Completed: {new Date(benchmarkData.endTime).toLocaleString()}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
