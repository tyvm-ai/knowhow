const workspace = process.env.ASANA_WORKSPACE;
class AsanaTools {
  private client = require("asana").ApiClient.instance;

  constructor(private accessToken: string) {
    this.client.authentications.token = process.env.ASANA_TOKEN;
    this.client.defaultHeaders = {
      "Asana-Enable": "new_user_task_lists,new_goal_memberships",
    };
  }

  async createTask(projectId: string, taskName: string, taskNotes: string) {
    if (!workspace) {
      throw new Error("Need to set ENV Variable ASANA Workspace");
    }

    const task = await this.client.tasks.create({
      workspace,
      projects: [projectId],
      name: taskName,
      notes: taskNotes,
    });
    console.log(`Task created: ${task.permalink_url}`);
    return task;
  }

  async updateTask(taskId: string, updates: object) {
    const task = await this.client.tasks.updateTask(taskId, updates);
    console.log(`Task updated: ${task.permalink_url}`);
    return task;
  }

  async searchTasks(searchTerm: string) {
    if (!workspace) {
      throw new Error("Need to set ENV Variable ASANA Workspace");
    }
    searchTerm = searchTerm.toLowerCase();
    const allTasks = await this.client.tasks.findAll({
      opt_expand: "notes",
      workspace,
    });
    const found = allTasks.data.filter(
      (t) =>
        t.notes.toLowerCase().includes(searchTerm) ||
        t.name.toLowerCase().includes(searchTerm)
    );

    console.log("Found", found.length, "tasks");
    return found;
  }

  async findTask(taskId: string) {
    const task = await this.client.tasks.findById(taskId);
    console.log(`Task found: ${task.permalink_url}`);
    return task;
  }

  async getSubtasks(taskId: string) {
    const tasks = await this.client.tasks.subtasks(taskId);
    return tasks.data;
  }

  async createSubtask(taskId: string, taskName: string, taskNotes = "") {
    const task = await this.client.tasks.addSubtask(taskId, {
      name: taskName,
      notes: taskNotes,
    });
    return task;
  }

  async myTasks(project?: string) {
    const me = await this.client.users.me();
    const tasks = await this.client.tasks.findAll({
      assignee: Number(me.gid),
      project,
      workspace,
      opt_expand: "completed",
    });
    return tasks.data.filter((t) => !t.completed);
  }

  async listProjects() {
    if (!workspace) {
      throw new Error("Need to set ENV Variable ASANA Workspace");
    }
    const allData = [];
    let projects = await this.client.projects.findAll({
      workspace,
      archived: false,
    });
    do {
      allData.push(...projects.data);
      projects = await projects.nextPage();
    } while (projects && projects?.data?.length);

    return allData;
  }
}

const asana = new AsanaTools(process.env.ASANA_TOKEN);
export const createTask = asana.createTask.bind(asana);
export const updateTask = asana.updateTask.bind(asana);
export const searchTasks = asana.searchTasks.bind(asana);
export const findTask = asana.findTask.bind(asana);
export const getSubtasks = asana.getSubtasks.bind(asana);
export const createSubtask = asana.createSubtask.bind(asana);
export const myTasks = asana.myTasks.bind(asana);
export const listProjects = asana.listProjects.bind(asana);
