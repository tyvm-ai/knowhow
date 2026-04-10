export const definitions = [
  {
    type: "function",
    function: {
      name: "createTask",
      description: "Create a new task in Asana",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          projectId: {
            type: "string",
            description: "The ID of the project where the task will be created",
          },
          taskName: {
            type: "string",
            description: "The name of the task to be created",
          },
          taskNotes: {
            type: "string",
            description: "The notes or description of the task",
          },
        },
        required: ["projectId", "taskName", "taskNotes"],
      },
      returns: {
        type: "object",
        description: "The created task object",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "updateTask",
      description: "Update an existing task in Asana",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          taskId: {
            type: "string",
            description: "The ID of the task to be updated",
          },
          updates: {
            type: "object",
            description:
              "An object containing the updates to be applied to the task",
          },
        },
        required: ["taskId", "updates"],
      },
      returns: {
        type: "object",
        description: "The updated task object",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "searchTasks",
      description: "Search for tasks in Asana based on a search term",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          searchTerm: {
            type: "string",
            description: "The term to search for in task names and notes",
          },
        },
        required: ["searchTerm"],
      },
      returns: {
        type: "array",
        description: "An array of tasks that match the search term",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listProjects",
      description: "List all projects in Asana",
      parameters: {
        type: "object",
        positional: true,
        properties: {},
        required: [],
      },
      returns: {
        type: "array",
        description: "An array of project objects",
      },
    },
  },

  {
    type: "function",
    function: {
      name: "findTask",
      description: "Find a specific task in Asana by its ID",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          taskId: {
            type: "string",
            description: "The ID of the task to be found",
          },
        },
        required: ["taskId"],
      },
      returns: {
        type: "object",
        description: "The task object that matches the given ID",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "myTasks",
      description:
        "Retrieve tasks assigned to the current user in Asana, only shows the uncompleted ones",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          project: {
            type: "string",
            description: "The ID of the project to filter tasks by (optional)",
          },
        },
        required: [],
      },
      returns: {
        type: "array",
        description: "An array of tasks assigned to the current user",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getSubtasks",
      description: "Retrieve all subtasks for a given Asana task.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          taskId: {
            type: "string",
            description:
              "The ID of the parent task for which to retrieve subtasks.",
          },
        },
        required: ["taskId"],
      },
      returns: {
        type: "array",
        description:
          "An array of subtasks associated with the specified parent task.",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "createSubtask",
      description: "Create a new subtask under a given Asana task.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          taskId: {
            type: "string",
            description:
              "The ID of the parent task under which the subtask will be created.",
          },
          taskName: {
            type: "string",
            description: "The name of the subtask to be created.",
          },
          taskNotes: {
            type: "string",
            description: "The optional notes or description of the subtask.",
          },
        },
        required: ["taskId", "taskName"],
      },
      returns: {
        type: "object",
        description: "The created subtask object.",
      },
    },
  },
];
