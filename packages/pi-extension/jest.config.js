/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { useESM: false }],
  },
  // Always test against this checkout's sibling agent-core package. In a git
  // worktree, node_modules is often shared with (or symlinked to) another
  // checkout, so resolving through it can silently load a stale agent-core.
  moduleNameMapper: {
    "^@sunstone-partners/ensemble-agent-core$": "<rootDir>/../agent-core",
  },
  testMatch: ["**/tests/**/*.test.ts"],
};
