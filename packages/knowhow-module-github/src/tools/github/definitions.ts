export const definitions = [
  {
    type: "function",
    function: {
      name: "getPullRequest",
      description:
        "Fetches a pull request from GitHub using the provided URL. Requires a valid GITHUB_TOKEN.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          url: {
            type: "string",
            description: "The URL of the pull request to fetch.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getPullRequestBuildStatuses",
      description:
        "Fetches the build statuses for a pull request using the provided URL. Requires a valid GITHUB_TOKEN.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          url: {
            type: "string",
            description:
              "The URL of the pull request to fetch build statuses for.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getRunLogs",
      description:
        "Retrieves the run logs for a specified GitHub Actions run ID in the specified repository.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          runId: {
            type: "number",
            description:
              "The ID of the GitHub Actions run to retrieve logs for.",
          },
          owner: {
            type: "string",
            description: "The owner of the repository containing the run.",
          },
          repo: {
            type: "string",
            description: "The name of the repository containing the run.",
          },
        },
        required: ["runId", "owner", "repo"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getPullRequestBuildFailureLogs",
      description:
        "Fetches the build failure logs for a pull request using the provided URL. Specifically focuses on failures.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          url: {
            type: "string",
            description:
              "The URL of the pull request to fetch failure logs for.",
          },
        },
        required: ["url"],
      },
    },
  },
];
