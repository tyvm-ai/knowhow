# @tyvm/knowhow-module-prolog

Symbolic reasoning tools for Knowhow agents and scripts. The module runs Tau Prolog locally and does not execute shell commands or access the network.

## Tools

- `prologQuery` consults a world model and returns bounded solutions to a query.
- `prologCheckModel` checks named expectations (possible, impossible, or exactly one solution) to catch contradictions and missing facts in an agent's representation.
- `prologFindPlan` searches increasing action counts and returns minimum-length plans within a required bound.
- `prologEvaluatePlan` checks each prefix of an action sequence, then checks whether the final reachable state satisfies a goal.

Tau Prolog's standard `lists` module is loaded automatically, including predicates such as `member/2` and `append/3`.

## Plan model convention

A plan world model defines these predicates:

```prolog
initial_state(State).
apply(Action, Before, After).
goal(State).
```

Example:

```prolog
initial_state(at(left)).
apply(move_right, at(left), at(center)).
apply(move_right, at(center), at(target)).
goal(at(target)).
```

Call `prologEvaluatePlan` with `actions: ["move_right", "move_right"]`. Actions are Prolog terms, not quoted text, so structured actions such as `drag(block_a, target)` work too.

For visual computer control, derive facts and transition rules from the latest perception result, check assumptions with `prologCheckModel`, evaluate candidate action sequences, execute one action through the computer-use tools, then rebuild or update the model from a new observation.

Saved computer-use automations receive registered Knowhow tools in their execution scope. They can call Prolog either by its registered function name or through the SDK:

```ts
const plan = await prologFindPlan({ program: world, maxPlanLength: 12 });
const check = await sdk.callTool("prologEvaluatePlan", {
  program: world,
  actions: ["move_right", "move_right"],
});
```

Tool calls prove results under the supplied model; re-observe the UI after bounded action segments before trusting further transitions.

## Configuration

Add the package to `.knowhow/knowhow.json`:

```json
{ "modules": ["@tyvm/knowhow-module-prolog"] }
```

Limits are per call (`maxAnswers`, `inferenceLimit`, and `timeoutMs`) to keep malformed or cyclic models bounded.
