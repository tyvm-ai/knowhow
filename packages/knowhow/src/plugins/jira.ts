import JiraClient from "jira-client";
import { PluginBase, PluginMeta } from "./PluginBase";
import { MinimalEmbedding } from "../types";

export class JiraPlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "jira",
    name: "Jira Plugin",
    requires: ["JIRA_HOST", "JIRA_USER", "JIRA_PASSWORD"]
  };

  jiraClient: JiraClient;

  constructor() {
    super(JiraPlugin.meta);
    
    if (!this.isEnabled()) return;
    this.jiraClient = new JiraClient({
      protocol: "https",
      host: process.env.JIRA_HOST,
      username: process.env.JIRA_USER,
      password: process.env.JIRA_PASSWORD,
      apiVersion: "2",
      strictSSL: true,
    });
  }

  async embed(userPrompt: string): Promise<MinimalEmbedding[]> {
    const urls = this.extractUrls(userPrompt);
    const tasks = await this.getTasksFromUrls(urls);
    const tasksFiltered = tasks.filter((task) => task !== null);

    return tasksFiltered.map((task, index) => {
      return {
        id: urls[index],
        text: JSON.stringify(task),
        metadata: {},
      };
    });
  }

  async getTasksFromUrls(urls: string[]) {
    const tasks = await Promise.all(
      urls.map(async (url) => {
        return this.getTaskFromUrl(url);
      })
    );
    return tasks;
  }

  async getTaskFromUrl(url: string) {
    const issueId = this.extractIdFromUrl(url);
    if (issueId) {
      console.log(`Fetching Jira issue ${issueId}`);
      return await this.getIssueData(issueId);
    }
    return null;
  }

  async getIssueData(issueId: string) {
    try {
      const issue = await this.jiraClient.findIssue(issueId);
      return issue;
    } catch (error) {
      console.error("Error fetching Jira issue:", error);
      return null;
    }
  }

  // https://${process.env.JIRA_HOST}/browse/${issue.key}
  extractUrls(userPrompt: string): string[] {
    const host = process.env.JIRA_HOST;
    const regex = new RegExp(`https://${host}/browse/[A-Z]+-\\d+`, "g");
    const matches = userPrompt.match(regex);
    if (!matches) {
      return [];
    }
    return matches;
  }

  extractIdFromUrl(url: string): string {
    const host = process.env.JIRA_HOST;
    const regex = new RegExp(`https://${host}/browse/([A-Z]+-\\d+)`, "g");
    const matches = regex.exec(url);
    if (matches && matches[1]) {
      return matches[1];
    }
    return null;
  }

  getTaskString(task: any) {
    return `### Issue: ${task.key}\n- Summary: ${task.fields.summary}\n- URL: ${process.env.JIRA_HOST}/browse/${task.key} \n- Description: ${task.fields.description}`;
  }

  async call(userPrompt: string): Promise<string> {
    const urls = this.extractUrls(userPrompt);
    if (!urls) {
      return "JIRA PLUGIN: No issues found";
    }

    const issuesData = await this.getTasksFromUrls(urls);
    const issuesDataFiltered = issuesData.filter((issue) => issue !== null);

    if (issuesDataFiltered.length === 0) {
      return "JIRA PLUGIN: No issues found";
    }

    const markdownIssues = issuesDataFiltered
      .map((issue) => this.getTaskString(issue))
      .join("\n\n");
    return `JIRA PLUGIN: The following issues were loaded:\n\n${markdownIssues}`;
  }
}
