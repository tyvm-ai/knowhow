module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.ts"],
  testTimeout: 300000,
  // tree-sitter uses native .node bindings that corrupt shared state across
  // test files. We use run-tests.sh to run each file in a separate jest
  // invocation (--runInBand), so no special worker config needed here.
};
