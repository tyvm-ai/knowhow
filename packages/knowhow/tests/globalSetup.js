/**
 * Jest globalSetup — runs in the parent process before workers are spawned,
 * so env set here reaches every git child process the tests launch.
 *
 * (Assigning process.env.X inside a test file does NOT propagate to child
 * processes under Jest 30 — the test sandbox gets its own copy of
 * process.env, while child_process reads the real one. On machines where git
 * can infer an identity — e.g. macOS — that goes unnoticed; on GitHub's
 * ubuntu runners every `git commit` fails with "Author identity unknown".)
 */
module.exports = async () => {
  const set = (k, v) => {
    if (!process.env[k]) process.env[k] = v;
  };
  set("GIT_AUTHOR_NAME", "knowhow-test");
  set("GIT_AUTHOR_EMAIL", "test@knowhow.invalid");
  set("GIT_COMMITTER_NAME", "knowhow-test");
  set("GIT_COMMITTER_EMAIL", "test@knowhow.invalid");

  // Make `git init` default to "main" regardless of the machine's git config.
  if (!process.env.GIT_CONFIG_COUNT) {
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "init.defaultBranch";
    process.env.GIT_CONFIG_VALUE_0 = "main";
  }
};
