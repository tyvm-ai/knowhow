import { PluginBase, PluginMeta } from "./PluginBase";
import { Embeddable, MinimalEmbedding } from "../types";
import { PluginContext } from "./types";

export class AsanaPlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "asana",
    name: "Asana Plugin",
    requires: ["ASANA_TOKEN"]
  };

  meta = AsanaPlugin.meta;
  private asanaClient = require("asana").ApiClient.instance;

  constructor(context: PluginContext) {
    super(context);
    
    if (!this.isEnabled()) return;
    
    this.asanaClient.authentications.token = process.env.ASANA_TOKEN;
    this.asanaClient.defaultHeaders = {
      "Asana-Enable": "new_user_task_lists,new_goal_memberships",
    };
  }

  getTaskString(task: any) {
    return `### Task: ${task.name}\n- Description: ${task.notes}\n- URL: ${task.permalink_url}\n Completed: ${task.completed}`;
  }

  async embed(userPrompt: string): Promise<MinimalEmbedding[]> {
    const urls = this.extractTaskUrls(userPrompt);
    const tasksData = await this.getTasksFromUrls(urls);
    const tasksDataFiltered = tasksData.filter((task) => task !== null);

    const tasksEmbeddings = tasksDataFiltered.map((task) => {
      return {
        id: task.permalink_url,
        text: this.getTaskString(task),
        metadata: {
          task: JSON.stringify(task),
        },
      };
    });

    const projectUrls = this.extractProjectUrls(userPrompt);
    const projectTasks = await this.getTasksFromProjectUrls(projectUrls);
    const projectTasksFiltered = projectTasks.filter((t) => t !== null);

    const projectTaskEmbeddings = projectTasksFiltered.map((t) => {
      return {
        id: t.permalink_url,
        text: this.getTaskString(t),
        metadata: {
          task: JSON.stringify(t),
        },
      };
    });

    const allTasks = tasksEmbeddings.concat(projectTaskEmbeddings);
    console.log("Found ", allTasks.length, "tasks");
    return allTasks;
  }

  extractProjectUrls(userPrompt: string): string[] {
    const projectUrlRegex = /https:\/\/app\.asana\.com\/0\/(\d+)\/list/g;
    const matches = userPrompt.match(projectUrlRegex);
    return matches || [];
  }

  extractTaskUrls(userPrompt: string): string[] {
    const taskUrlRegex = /https:\/\/app\.asana\.com\/0\/(\d+)\/(\d+)/g;
    const matches = userPrompt.match(taskUrlRegex);
    return matches || [];
  }

  async getTasksFromUrls(urls: string[]) {
    const tasks = await Promise.all(
      urls.map(async (url) => {
        return this.getTaskFromUrl(url);
      })
    );
    return tasks;
  }

  async getTasksFromProjectUrls(urls: string[]) {
    const tasks = await Promise.all(
      urls.map((url) => this.getTasksFromProjectUrl(url))
    );
    return tasks.flat();
  }

  async getTasksFromProjectUrl(url: string) {
    const urlParts = url.split("/");
    const projectId = urlParts[4];
    console.log({ projectId });
    if (!projectId) {
      return null;
    }
    let tasks = await this.asanaClient.tasks.findAll({
      project: projectId,
      opt_expand: "notes,assignee,permalink_url,custom_fields,tags,completed",
    });
    const allData = [];

    do {
      allData.push(...tasks.data);
      tasks = await tasks.nextPage();
    } while (tasks);

    return allData;
  }

  async getTaskFromUrl(url: string) {
    const taskId = url.split("/").pop();
    if (taskId) {
      console.log(`Fetching Asana task ${taskId}`);
      return await this.getTaskData(taskId);
    }
    return null;
  }

  async getTaskData(taskId: string) {
    try {
      const task = await this.asanaClient.tasks.findById(taskId);
      return task;
    } catch (error) {
      console.error("Error fetching Asana task:", error);
      return null;
    }
  }

  async call(userPrompt: string): Promise<string> {
    const urls = this.extractTaskUrls(userPrompt);
    const tasksData = await this.getTasksFromUrls(urls);
    const tasksDataFiltered = tasksData.filter((task) => task !== null);

    if (tasksDataFiltered.length === 0) {
      return "ASANA PLUGIN: No tasks found";
    }

    const markdownTasks = tasksDataFiltered
      .map((task) => this.getTaskString(task))
      .join("\n\n");
    return `ASANA PLUGIN: The following tasks were loaded:\n\n${markdownTasks}`;
  }
}
