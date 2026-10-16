const test = require("node:test");
const assert = require("node:assert/strict");
const {
  prologCheckModel,
  prologEvaluatePlan,
  prologFindPlan,
  prologQuery,
} = require("../ts_build");

const world = `
initial_state(at(left)).
apply(move_right, at(left), at(center)).
apply(move_right, at(center), at(target)).
goal(at(target)).
`;

test("prologQuery enumerates solutions", async () => {
  const result = await prologQuery(
    "edge(a,b). edge(b,c). path(X,Y):-edge(X,Y). path(X,Y):-edge(X,Z),path(Z,Y).",
    "path(a, X)",
    10
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.answers, ["X = b", "X = c"]);
  assert.equal(result.exhausted, true);
});

test("prologQuery preloads standard list predicates", async () => {
  const result = await prologQuery("pick(X) :- member(X, [red, blue]).", "pick(X)");
  assert.deepEqual(result.answers, ["X = red", "X = blue"]);
});

test("prologFindPlan returns plans from the minimum successful depth", async () => {
  const result = await prologFindPlan(world, 5);
  assert.equal(result.found, true);
  assert.equal(result.optimalByLength, true);
  assert.equal(result.planLength, 2);
  assert.match(result.plans[0], /Plan = \[move_right,move_right\]/);
  assert.equal(result.searchedThrough, 2);
});

test("prologFindPlan symbolically validates a preferred candidate", async () => {
  const result = await prologFindPlan(
    world, 5, undefined, undefined, undefined, 1, 100000, 5000, 2,
    ["move_right", "move_right"]
  );
  assert.equal(result.found, true);
  assert.equal(result.preferredPlanValidated, true);
  assert.equal(result.planLength, 2);
  assert.match(result.plans[0], /Plan = \[move_right,move_right\]/);
});

test("prologCheckModel validates possible, impossible, and unique assumptions", async () => {
  const result = await prologCheckModel("color(ball, red).", [
    { name: "ball exists", query: "color(ball, _)", expect: "possible" },
    { name: "not blue", query: "color(ball, blue)", expect: "impossible" },
    { name: "one color", query: "color(ball, X)", expect: "unique" },
  ]);
  assert.equal(result.valid, true);
  assert.equal(result.passed, 3);
});

test("prologEvaluatePlan reaches a goal and identifies an impossible action", async () => {
  const valid = await prologEvaluatePlan(world, ["move_right", "move_right"]);
  assert.equal(valid.executable, true);
  assert.equal(valid.goalReached, true);
  assert.equal(valid.firstFailedStep, null);

  const invalid = await prologEvaluatePlan(world, ["move_right", "move_left"]);
  assert.equal(invalid.executable, false);
  assert.equal(invalid.goalReached, false);
  assert.equal(invalid.firstFailedStep, 1);
});

test("syntax errors are returned as rejected tool calls", async () => {
  await assert.rejects(() => prologQuery("broken(.", "broken(X)"), /Invalid Prolog program/);
});
