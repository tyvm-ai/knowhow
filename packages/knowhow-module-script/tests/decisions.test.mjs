import test from "node:test";
import assert from "node:assert/strict";
import { SandboxContext } from "../ts_build/SandboxContext.js";

test("script decision built-ins route noul, choice, and score through decide", async () => {
  const calls = [];
  const clients = {
    async decide(provider, options) {
      calls.push({ provider, options });
      const question = options.questions.answer;
      const answers = {
        noul: { type: "noul", noul: 0.9 },
        choice: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.8, technical: 0.2 },
          confidence: 0.75,
        },
        score: {
          type: "score",
          score: 1.2,
          legend: { "0": "Calm", "1": "Upset", "2": "Angry" },
          probabilities: { "0": 0, "1": 0.8, "2": 0.2 },
          confidence: 0.7,
        },
      };
      return {
        model: "jev-1.13.0",
        answers: { answer: answers[question.type] },
        usage: { input_tokens: 10, output_tokens: 2 },
        usd_cost: 0.001,
      };
    },
  };
  let recordedCost = 0;
  const policy = {
    checkTokenUsage: () => true,
    recordTokenUsage: () => {},
    checkCost: () => true,
    recordCost: (cost) => { recordedCost += cost; },
  };
  let tracedCost = 0;
  const tracer = {
    emitEvent: () => {},
    recordCost: (cost) => { tracedCost += cost; },
  };
  const tools = { getFunctionNames: () => [] };
  const context = new SandboxContext(tools, clients, tracer, policy);

  const yesNo = await context.noul("Fix this now", "Is it urgent?");
  const selected = await context.choice("Charged twice", "Which team?", {
    billing: "Payments",
    technical: "Bugs",
  });
  const scored = await context.score("This keeps breaking", "How upset?", [
    "Calm",
    "Upset",
    "Angry",
  ]);

  assert.deepEqual(yesNo, { type: "noul", noul: 0.9 });
  assert.equal(selected.type, "choice");
  assert.equal(selected.choice, "billing");
  assert.equal(scored.type, "score");
  assert.equal(scored.score, 1.2);

  assert.deepEqual(
    calls.map(({ provider, options }) => ({
      provider,
      model: options.model,
      type: options.questions.answer.type,
    })),
    [
      { provider: "jev", model: "jev-latest", type: "noul" },
      { provider: "jev", model: "jev-latest", type: "choice" },
      { provider: "jev", model: "jev-latest", type: "score" },
    ]
  );
  assert.equal(recordedCost, 0.003);
  assert.equal(tracedCost, 0.003);
});
