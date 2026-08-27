import {
  InitParams,
  KnowhowModule,
  ModuleTool,
} from "@tyvm/knowhow/ts_build/src/services/modules/types";
import {
  prologCheckModel,
  prologEvaluatePlan,
  prologFindPlan,
  prologQuery,
} from "./tools";

const executionLimits = {
  inferenceLimit: {
    type: "number",
    description: "Maximum Tau Prolog inference steps (default 100000, maximum 2000000)",
  },
  timeoutMs: {
    type: "number",
    description: "Wall-clock timeout in milliseconds (default 5000, maximum 30000)",
  },
};

const tools: ModuleTool[] = [
  {
    name: "prologQuery",
    handler: prologQuery,
    definition: {
      type: "function",
      function: {
        name: "prologQuery",
        description:
          "Query an isolated Prolog world model and return bounded solutions. Use this to test facts, rules, reachability, constraints, and assumptions derived from perception.",
        parameters: {
          type: "object",
          positional: true,
          properties: {
            program: { type: "string", description: "Prolog facts and rules describing the world" },
            query: { type: "string", description: "Prolog goal, with or without a trailing period" },
            maxAnswers: { type: "number", description: "Maximum solutions to return (default 20, maximum 100)" },
            ...executionLimits,
          },
          required: ["program", "query"],
        },
      },
    },
  },
  {
    name: "prologFindPlan",
    handler: prologFindPlan,
    definition: {
      type: "function",
      function: {
        name: "prologFindPlan",
        description:
          "Validate an optional candidate plan symbolically, or synthesize minimum-action plans against a Prolog transition model using bounded iterative deepening. Synthesis searches exact lengths through maxPlanLength and returns solutions from the first successful length. The model defines initial_state/1, apply/3, and goal/1 by default.",
        parameters: {
          type: "object",
          positional: true,
          properties: {
            program: {
              type: "string",
              description: "World model containing initial-state, action-transition, and goal rules",
            },
            maxPlanLength: {
              type: "number",
              description: "Maximum action count to search (required, maximum 50)",
            },
            initialPredicate: { type: "string", description: "Initial-state predicate name (default initial_state)" },
            transitionPredicate: { type: "string", description: "Transition predicate name with arity 3 (default apply)" },
            goalPredicate: { type: "string", description: "Goal predicate name (default goal)" },
            maxAnswers: { type: "number", description: "Maximum shortest plans to return (default 10)" },
            ...executionLimits,
            minPlanLength: {
              type: "number",
              description: "Optional trusted lower bound that skips shorter exact-depth searches",
            },
            preferredActions: {
              type: "array",
              items: { type: "string" },
              description: "Optional candidate plan to validate symbolically before synthesis",
            },
          },
          required: ["program", "maxPlanLength"],
        },
      },
    },
  },
  {
    name: "prologCheckModel",
    handler: prologCheckModel,
    definition: {
      type: "function",
      function: {
        name: "prologCheckModel",
        description:
          "Validate a Prolog world representation against named expectations. Check that required situations are possible, forbidden situations are impossible, or a fact has exactly one solution before trusting a plan.",
        parameters: {
          type: "object",
          positional: true,
          properties: {
            program: { type: "string", description: "Prolog facts and rules describing the world" },
            checks: {
              type: "array",
              description: "Named consistency and completeness checks",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Human-readable assumption name" },
                  query: { type: "string", description: "Prolog query to evaluate" },
                  expect: {
                    type: "string",
                    enum: ["possible", "impossible", "unique"],
                    description: "Expected solution cardinality (default possible)",
                  },
                }
              },
            },
            ...executionLimits,
          },
          required: ["program", "checks"],
        },
      },
    },
  },
  {
    name: "prologEvaluatePlan",
    handler: prologEvaluatePlan,
    definition: {
      type: "function",
      function: {
        name: "prologEvaluatePlan",
        description:
          "Symbolically execute an ordered plan against a Prolog transition model. Reports whether each action prefix is reachable, the first failed action, and whether the resulting state satisfies the goal. By default the model defines initial_state/1, apply/3, and goal/1.",
        parameters: {
          type: "object",
          positional: true,
          properties: {
            program: {
              type: "string",
              description: "World model containing initial-state, action-transition, and goal rules",
            },
            actions: {
              type: "array",
              items: { type: "string" },
              description: "Ordered Prolog action terms, e.g. ['click(button)', 'drag(block,target)']",
            },
            initialPredicate: { type: "string", description: "Initial-state predicate name (default initial_state)" },
            transitionPredicate: { type: "string", description: "Transition predicate name with arity 3 (default apply)" },
            goalPredicate: { type: "string", description: "Goal predicate name (default goal)" },
            maxAnswers: { type: "number", description: "Maximum reachable states returned per step (default 10)" },
            ...executionLimits,
          },
          required: ["program", "actions"],
        },
      },
    },
  },
];

const prologModule: KnowhowModule = {
  async init(_params: InitParams) {},
  tools,
  agents: [],
  plugins: [],
  clients: [],
  commands: [],
};

export default prologModule;
export * from "./engine";
export * from "./tools";
