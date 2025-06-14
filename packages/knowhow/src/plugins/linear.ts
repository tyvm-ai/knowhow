import { LinearClient } from "@linear/sdk";
import { PluginBase, PluginMeta } from "./PluginBase";
import { MinimalEmbedding } from "../types";

export class LinearPlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "linear",
    name: "Linear Plugin",
    requires: ["LINEAR_API_KEY"],
  };

  linearClient: LinearClient;

  constructor() {
    super(LinearPlugin.meta);

    if (!this.isEnabled()) return;
    this.linearClient = new LinearClient({
      apiKey: process.env.LINEAR_API_KEY,
    });
  }

  async embed(userPrompt: string): Promise<MinimalEmbedding[]> {
    const urls = this.extractTaskUrls(userPrompt);
    const tasksData = await this.getTasksFromUrls(urls);
    const tasksDataFiltered = tasksData.filter((task) => task !== null);

    const tasksEmbeddings = tasksDataFiltered.map((task) => {
      return {
        id: task.url,
        text: this.getTaskString(task),
        metadata: {
          task: JSON.stringify(task),
        },
      };
    });

    const projectUrls = this.extractProjectUrls(userPrompt);
    const projectTasks = await this.getTasksFromProjectUrls(projectUrls);
    const projectTasksFiltered = projectTasks.filter((t) => t !== null);

    const projectTaskEmbeddings = projectTasksFiltered
      .map((t) => {
        return {
          id: t.url,
          text: this.getTaskString(t),
          metadata: {
            task: JSON.stringify(t),
          },
        };
      })
      .flat();

    const teamUrls = this.extractTeamUrls(userPrompt);
    const teamTasks = await this.getTasksFromTeamUrls(teamUrls);
    const teamTasksFiltered = teamTasks.filter((t) => t !== null);

    const teamTaskEmbeddings = teamTasksFiltered
      .map((t) => {
        return {
          id: t.url,
          text: this.getTaskString(t),
          metadata: {
            task: JSON.stringify(t),
          },
        };
      })
      .flat();

    return tasksEmbeddings
      .concat(projectTaskEmbeddings)
      .concat(teamTaskEmbeddings);
  }

  async getIssueData(issueId: string) {
    try {
      const issue = await this.linearClient.issue(issueId);
      return issue;
    } catch (error) {
      console.error("Error fetching Linear issue:", error);
      return null;
    }
  }

  async getTaskFromUrl(url: string) {
    const issueId = this.getIdFromUrl(url);
    if (issueId) {
      console.log(`Fetching Linear issue ${issueId}`);
      return await this.getIssueData(issueId);
    }
    return null;
  }

  async getTasksFromUrls(urls: string[]) {
    const tasks = await Promise.all(
      urls.map(async (url) => {
        return this.getTaskFromUrl(url);
      })
    );
    return tasks;
  }

  extractTeamUrls(userPrompt: string): string[] {
    const urlRegex = /https:\/\/linear\.app\/[^\/]+\/team\/[^\/]+\/[^\/]+/g;
    const matches = userPrompt.match(urlRegex);
    return matches || [];
  }

  getTeamIdFromUrl(url: string): string {
    const urlRegex = /https:\/\/linear\.app\/[^\/]+\/team\/([^\/]+)\/[^\/]+/g;
    const match = urlRegex.exec(url);
    if (match && match[1]) {
      return match[1];
    }
    return null;
  }

  extractProjectUrls(userPrompt: string): string[] {
    const urlRegex = /https:\/\/linear\.app\/[^\/]+\/project\/[^\/]+\/[^\/]+/g;
    const matches = userPrompt.match(urlRegex);
    return matches || [];
  }

  getProjectIdFromUrl(url: string): string {
    const urlRegex =
      /https:\/\/linear\.app\/[^\/]+\/project\/([^\/]+)\/[^\/]+/g;
    const match = urlRegex.exec(url);
    if (match && match[1]) {
      const parts = match[1].split("-");
      return parts[parts.length - 1];
    }
    return null;
  }

  async getTasksForProject(projectId: string) {
    console.log({ projectId });
    let tasks = await this.linearClient.issues({
      filter: {
        project: { slugId: { eq: projectId } },
      },
    });
    let allTasks = tasks.nodes;

    while (tasks.pageInfo.hasNextPage) {
      tasks = await tasks.fetchNext();
      allTasks = allTasks.concat(tasks.nodes);
    }

    return allTasks;
  }

  async getTasksFromProjectUrls(urls: string[]) {
    const tasks = await Promise.all(
      urls.map(async (url) => {
        return this.getTasksForProject(this.getProjectIdFromUrl(url));
      })
    );
    return tasks.flat();
  }

  async getTasksForTeam(teamId: string) {
    console.log({ teamId });
    let tasks = await this.linearClient.issues({
      filter: {
        team: { key: { eq: teamId } },
      },
    });

    let allTasks = tasks.nodes;

    while (tasks.pageInfo.hasNextPage) {
      tasks = await tasks.fetchNext();
      allTasks = allTasks.concat(tasks.nodes);
    }

    return allTasks;
  }

  async getTasksFromTeamUrls(urls: string[]) {
    const tasks = await Promise.all(
      urls.map(async (url) => {
        return this.getTasksForTeam(this.getTeamIdFromUrl(url));
      })
    );
    return tasks.flat();
  }

  extractTaskUrls(userPrompt: string): string[] {
    const urlRegex = /https:\/\/linear\.app\/[^\/]+\/issue\/[^\/]+\/[^\/]+/g;
    const matches = userPrompt.match(urlRegex);
    if (!matches) {
      return [];
    }
    return matches;
  }

  getIdFromUrl(url: string): string {
    const urlRegex = /https:\/\/linear\.app\/[^\/]+\/issue\/([^\/]+)\/[^\/]+/g;
    const match = urlRegex.exec(url);
    if (match && match[1]) {
      return match[1];
    }
    return null;
  }

  getTaskString(task: any): string {
    return `Issue: ${task.identifier}\nTitle: ${task.title}\nURL: ${task.url} \nDescription: ${task.description}`;
  }

  async call(userPrompt: string): Promise<string> {
    const urls = this.extractTaskUrls(userPrompt);
    if (!urls) {
      return "LINEAR PLUGIN: No issues found";
    }

    const issuesData = await this.getTasksFromUrls(urls);
    const issuesDataFiltered = issuesData.filter((issue) => issue !== null);

    if (issuesDataFiltered.length === 0) {
      return "LINEAR PLUGIN: No issues found";
    }

    const markdownIssues = issuesDataFiltered
      .map((issue) => this.getTaskString(issue))
      .join("\n\n");
    return `LINEAR PLUGIN: The following issues were loaded:\n\n${markdownIssues}`;
  }
}
