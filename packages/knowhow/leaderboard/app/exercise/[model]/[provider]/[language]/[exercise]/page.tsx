"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { BenchmarkResults, ExerciseResult } from "@/types/benchmark";
import { formatCurrency, formatTime } from "@/utils/dataProcessor";

export default function ExerciseDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [benchmarkData, setBenchmarkData] = useState<BenchmarkResults | null>(
    null
  );
  const [exerciseData, setExerciseData] = useState<ExerciseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const model = decodeURIComponent(params.model as string);
  const provider = decodeURIComponent(params.provider as string);
  const language = decodeURIComponent(params.language as string);
  const exerciseName = decodeURIComponent(params.exercise as string);

  useEffect(() => {
    async function fetchExerciseData() {
      try {
        // First fetch the benchmark data
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
        setBenchmarkData(data.latest);

        // Find the specific exercise
        const exercise = data.latest.exercises.find(
          (ex: ExerciseResult) => ex.exerciseName === exerciseName
        );

        if (!exercise) {
          throw new Error(`Exercise "${exerciseName}" not found`);
        }

        setExerciseData(exercise);
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setLoading(false);
      }
    }

    fetchExerciseData();
  }, [model, provider, language, exerciseName]);

  const getStatusBadge = (passed: boolean) => {
    const baseClasses = "px-2 py-1 text-xs font-medium rounded-full";
    return passed
      ? `${baseClasses} bg-green-100 text-green-800`
      : `${baseClasses} bg-red-100 text-red-800`;
  };

  const getStatusIcon = (passed: boolean) => {
    return passed ? "✅" : "❌";
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-500 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading exercise details...</p>
        </div>
      </div>
    );
  }

  if (error || !exerciseData || !benchmarkData) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-red-500 text-6xl mb-4">⚠️</div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            Error Loading Exercise Details
          </h3>
          <p className="text-gray-500 mb-4">
            {error || "Exercise data not found"}
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
            onClick={() =>
              router.push(
                `/details/${encodeURIComponent(model)}/${encodeURIComponent(
                  provider
                )}/${encodeURIComponent(language)}`
              )
            }
            className="mb-4 text-blue-600 hover:text-blue-800 flex items-center"
          >
            ← Back to Benchmark Details
          </button>
          <h1 className="text-3xl font-bold text-gray-900">
            Exercise: {exerciseName}
          </h1>
          <p className="mt-2 text-gray-600">
            Model: {model} • Provider: {provider} • Language: {language}
          </p>
        </div>

        {/* Exercise Summary */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div
                  className={`w-8 h-8 rounded-md flex items-center justify-center ${
                    exerciseData.testResult?.success
                      ? "bg-green-500"
                      : "bg-red-500"
                  }`}
                >
                  <span className="text-white font-bold">
                    {exerciseData.testResult?.success ? "✓" : "✗"}
                  </span>
                </div>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">
                  Overall Status
                </p>
                <p className="text-2xl font-semibold text-gray-900">
                  {exerciseData.testResult?.success ? "Pass" : "Fail"}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-blue-500 rounded-md flex items-center justify-center">
                  <span className="text-white font-bold">T</span>
                </div>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">
                  Tests Passed
                </p>
                <p className="text-2xl font-semibold text-gray-900">
                  {exerciseData.testResult?.passed || 0} /{" "}
                  {exerciseData.testResult?.total || 0}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-purple-500 rounded-md flex items-center justify-center">
                  <span className="text-white font-bold">$</span>
                </div>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">Cost</p>
                <p className="text-2xl font-semibold text-gray-900">
                  {formatCurrency(exerciseData.cost)}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-orange-500 rounded-md flex items-center justify-center">
                  <span className="text-white font-bold">⏱</span>
                </div>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">Duration</p>
                <p className="text-2xl font-semibold text-gray-900">
                  {formatTime(exerciseData.timeElapsed || 0)}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Test Results Section */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 mb-8">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">
              Test Results
            </h2>
          </div>
          <div className="p-6">
            {exerciseData.testResult ? (
              <div className="space-y-6">
                {/* Test Summary */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                    <div className="text-center">
                      <div className="text-2xl font-bold text-green-600">
                        {exerciseData.testResult.passed || 0}
                      </div>
                      <div className="text-sm text-green-700">Tests Passed</div>
                    </div>
                  </div>
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <div className="text-center">
                      <div className="text-2xl font-bold text-red-600">
                        {exerciseData.testResult.failed || 0}
                      </div>
                      <div className="text-sm text-red-700">Tests Failed</div>
                    </div>
                  </div>
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                    <div className="text-center">
                      <div className="text-2xl font-bold text-yellow-600">
                        {exerciseData.testResult.skipped || 0}
                      </div>
                      <div className="text-sm text-yellow-700">
                        Tests Skipped
                      </div>
                    </div>
                  </div>
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <div className="text-center">
                      <div className="text-2xl font-bold text-blue-600">
                        {exerciseData.testResult.total || 0}
                      </div>
                      <div className="text-sm text-blue-700">Total Tests</div>
                    </div>
                  </div>
                </div>

                {/* Output */}
                {exerciseData.testResult.output && (
                  <div className="border border-gray-200 rounded-lg">
                    <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 rounded-t-lg">
                      <h3 className="text-sm font-medium text-gray-900">
                        Test Output
                      </h3>
                    </div>
                    <div className="p-4">
                      <pre className="text-sm text-gray-800 whitespace-pre-wrap font-mono bg-gray-50 p-4 rounded border overflow-x-auto">
                        {(() => {
                          try {
                            const r = JSON.stringify(
                              typeof exerciseData.testResult.output === "string"
                                ? JSON.parse(exerciseData.testResult.output)
                                : exerciseData.testResult.output,
                              null,
                              2
                            );
                            return r;
                          } catch (e) {
                            return exerciseData.testResult.output;
                          }
                        })()}
                      </pre>
                    </div>
                  </div>
                )}

                {/* Test Status Summary */}
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-medium text-gray-900">
                        Overall Test Result
                      </h3>
                      <p className="text-sm text-gray-600">
                        {exerciseData.testResult.success
                          ? "All tests completed successfully"
                          : "Some tests failed or encountered errors"}
                      </p>
                    </div>
                    <div
                      className={`px-4 py-2 rounded-full text-sm font-medium ${
                        exerciseData.testResult.success
                          ? "bg-green-100 text-green-800"
                          : "bg-red-100 text-red-800"
                      }`}
                    >
                      {exerciseData.testResult.success ? "PASSED" : "FAILED"}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-8">
                <div className="text-gray-400 text-4xl mb-4">📋</div>
                <p className="text-gray-500">
                  No detailed test results available
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Exercise Metadata */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">
              Exercise Information
            </h2>
          </div>
          <div className="p-6">
            <dl className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
              <div>
                <dt className="text-sm font-medium text-gray-500">
                  Exercise Name
                </dt>
                <dd className="mt-1 text-sm text-gray-900">
                  {exerciseData.exerciseName}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">Cost</dt>
                <dd className="mt-1 text-sm text-gray-900">
                  {formatCurrency(exerciseData.cost)}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">Duration</dt>
                <dd className="mt-1 text-sm text-gray-900">
                  {formatTime(exerciseData.timeElapsed || 0)}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">
                  Success Rate
                </dt>
                <dd className="mt-1 text-sm text-gray-900">
                  {exerciseData.testResult && exerciseData.testResult.total > 0
                    ? `${(
                        ((exerciseData.testResult.passed || 0) /
                          exerciseData.testResult.total) *
                        100
                      ).toFixed(1)}%`
                    : exerciseData.testResult?.success
                    ? "100.0%"
                    : exerciseData.testResult?.success === false
                    ? "0.0%"
                    : "N/A"}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
