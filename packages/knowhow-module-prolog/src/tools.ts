import { QueryOptions, runPrologQuery, validateActionTerm } from "./engine";

export interface ModelCheck {
  name: string;
  query: string;
  expect?: "possible" | "impossible" | "unique";
}

function queryOptions(maxAnswers?: number, inferenceLimit?: number, timeoutMs?: number): QueryOptions {
  return { maxAnswers, inferenceLimit, timeoutMs };
}

export async function prologQuery(
  program: string,
  query: string,
  maxAnswers?: number,
  inferenceLimit?: number,
  timeoutMs?: number
) {
  return runPrologQuery(program, query, queryOptions(maxAnswers, inferenceLimit, timeoutMs));
}

export async function prologCheckModel(
  program: string,
  checks: ModelCheck[],
  inferenceLimit?: number,
  timeoutMs?: number
) {
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new Error("At least one model check is required");
  }
  if (checks.length > 50) throw new Error("A maximum of 50 model checks is allowed per call");

  const results: Array<{
    name: string;
    expect: "possible" | "impossible" | "unique";
    passed: boolean;
    answers: string[];
    explanation: string;
  }> = [];
  for (const check of checks) {
    if (!check?.name?.trim() || !check?.query?.trim()) {
      throw new Error("Every model check requires a name and query");
    }
    const expect = check.expect ?? "possible";
    const result = await runPrologQuery(
      program,
      check.query,
      queryOptions(expect === "unique" ? 2 : 1, inferenceLimit, timeoutMs)
    );
    const passed = expect === "possible"
      ? result.success
      : expect === "impossible"
        ? !result.success
        : result.answerCount === 1 && result.exhausted;
    results.push({
      name: check.name,
      expect,
      passed,
      answers: result.answers,
      explanation: passed
        ? `Expectation '${expect}' was satisfied`
        : `Expectation '${expect}' was not satisfied`,
    });
  }

  const failed = results.filter((result) => !result.passed).map((result) => result.name);
  return { valid: failed.length === 0, passed: results.length - failed.length, failed, checks: results };
}

function predicateName(value: string | undefined, fallback: string): string {
  const name = value?.trim() || fallback;
  if (!/^[a-z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid predicate name '${name}'`);
  }
  return name;
}

/** Find minimum-length plans by querying exact depths in increasing order. */
export async function prologFindPlan(
  program: string,
  maxPlanLength: number,
  initialPredicate?: string,
  transitionPredicate?: string,
  goalPredicate?: string,
  maxAnswers?: number,
  inferenceLimit?: number,
  timeoutMs?: number,
  minPlanLength?: number,
  preferredActions?: string[]
) {
  if (!Number.isFinite(maxPlanLength) || maxPlanLength < 0) {
    throw new Error("maxPlanLength must be a non-negative integer");
  }
  const maximum = Math.min(50, Math.floor(maxPlanLength));
  const minimum = Math.min(maximum, Math.max(0, Math.floor(minPlanLength ?? 0)));
  const initial = predicateName(initialPredicate, "initial_state");
  const transition = predicateName(transitionPredicate, "apply");
  const goal = predicateName(goalPredicate, "goal");
  const helper = `
knowhow_plan_exact(Depth, State, Plan, Final) :-
  knowhow_plan_exact_seen(Depth, State, [State], Plan, Final).
knowhow_plan_exact_seen(0, State, _, [], State).
knowhow_plan_exact_seen(Depth, Before, Seen, [Action|Rest], Final) :-
  Depth > 0,
  ${transition}(Action, Before, After),
  \\+ member(After, Seen),
  NextDepth is Depth - 1,
  knowhow_plan_exact_seen(NextDepth, After, [After|Seen], Rest, Final).
knowhow_validate_candidate([], State, State).
knowhow_validate_candidate([Action|Rest], Before, Final) :-
  ${transition}(Action, Before, After), knowhow_validate_candidate(Rest, After, Final).
`;
  const model = `${program.trim()}\n${helper}`;
  const started = Date.now();
  const totalTimeout = Math.max(50, Math.min(30_000, timeoutMs ?? 5_000));

  // A caller that already has a candidate from a fast domain heuristic can
  // ask Prolog to validate it before the more expensive synthesis search.
  if (Array.isArray(preferredActions)) {
    const terms = preferredActions.map(validateActionTerm);
    if (terms.length >= minimum && terms.length <= maximum) {
      const preferred = `[${terms.join(",")}]`;
      const result = await runPrologQuery(
        model,
        `${initial}(InitialState), knowhow_validate_candidate(${preferred}, InitialState, FinalState), ${goal}(FinalState)`,
        queryOptions(1, inferenceLimit, totalTimeout)
      );
      if (result.success) return {
        found: true, optimalByLength: false, preferredPlanValidated: true,
        planLength: terms.length, plans: [`Plan = ${preferred}`],
        truncated: false, searchedThrough: terms.length,
      };
    }
  }

  for (let depth = minimum; depth <= maximum; depth += 1) {
    const remainingMs = totalTimeout - (Date.now() - started);
    if (remainingMs <= 0) {
      throw new Error(`Prolog plan search timed out: ${totalTimeout}ms limit exceeded`);
    }
    const result = await runPrologQuery(
      model,
      `${initial}(InitialState), knowhow_plan_exact(${depth}, InitialState, Plan, FinalState), ${goal}(FinalState)`,
      queryOptions(maxAnswers ?? 10, inferenceLimit, remainingMs)
    );
    if (result.success) {
      return {
        found: true,
        optimalByLength: minimum === 0,
        planLength: depth,
        plans: result.answers,
        truncated: result.truncated,
        searchedThrough: depth,
      };
    }
  }
  return {
    found: false,
    optimalByLength: false,
    planLength: null,
    plans: [],
    truncated: false,
    searchedThrough: maximum,
  };
}

export async function prologEvaluatePlan(
  program: string,
  actions: string[],
  initialPredicate?: string,
  transitionPredicate?: string,
  goalPredicate?: string,
  maxAnswers?: number,
  inferenceLimit?: number,
  timeoutMs?: number
) {
  if (!Array.isArray(actions)) throw new Error("actions must be an array of Prolog terms");
  if (actions.length > 100) throw new Error("A maximum of 100 plan actions is allowed");

  const initial = predicateName(initialPredicate, "initial_state");
  const transition = predicateName(transitionPredicate, "apply");
  const goal = predicateName(goalPredicate, "goal");
  const terms = actions.map(validateActionTerm);
  const helper = `
knowhow_execute_plan([], State, State).
knowhow_execute_plan([Action|Rest], Before, Final) :-
  ${transition}(Action, Before, After),
  knowhow_execute_plan(Rest, After, Final).
`;
  const model = `${program.trim()}\n${helper}`;
  const options = queryOptions(maxAnswers ?? 10, inferenceLimit, timeoutMs);
  const steps: Array<{
    index: number;
    action: string;
    reachable: boolean;
    states: string[];
  }> = [];
  let firstFailedStep: number | null = null;
  let initialStateFound = false;

  for (let index = 0; index <= terms.length; index += 1) {
    const prefix = `[${terms.slice(0, index).join(", ")}]`;
    const result = await runPrologQuery(
      model,
      `${initial}(InitialState), knowhow_execute_plan(${prefix}, InitialState, State)`,
      options
    );
    if (index === 0) initialStateFound = result.success;
    if (index > 0) {
      const reachable = result.success;
      steps.push({ index: index - 1, action: terms[index - 1], reachable, states: result.answers });
      if (!reachable && firstFailedStep === null) firstFailedStep = index - 1;
    }
    if (!result.success) break;
  }

  const fullPlan = `[${terms.join(", ")}]`;
  const goalResult = initialStateFound && firstFailedStep === null
    ? await runPrologQuery(
        model,
        `${initial}(InitialState), knowhow_execute_plan(${fullPlan}, InitialState, FinalState), ${goal}(FinalState)`,
        options
      )
    : null;

  return {
    valid: goalResult?.success ?? false,
    modelInitialized: initialStateFound,
    executable: initialStateFound && firstFailedStep === null,
    goalReached: goalResult?.success ?? false,
    firstFailedStep,
    actions: terms,
    steps,
    finalAnswers: goalResult?.answers ?? [],
    convention: {
      initial: `${initial}(State)`,
      transition: `${transition}(Action, Before, After)`,
      goal: `${goal}(State)`,
    },
  };
}
