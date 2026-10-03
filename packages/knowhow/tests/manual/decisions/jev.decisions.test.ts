/**
 * Paid Jev decision integration tests.
 *
 * Run manually (loads the key added to bashrc):
 *   source ~/.bashrc
 *   npx jest --config jest.manual.config.js tests/manual/decisions/jev.decisions.test.ts --runInBand
 */
import { GenericJevClient } from "../../../src/clients/jev";

const hasApiKey = Boolean(process.env.TYPESAFE_API_KEY);
const paidTest = hasApiKey ? test : test.skip;

describe("Jev paid decision integration", () => {
  const client = new GenericJevClient();

  paidTest("noul returns a probability from the live API", async () => {
    const response = await client.decide({
      state: "Help! My payouts have failed for three days. Fix this now!",
      questions: {
        urgent: {
          type: "noul",
          instructions: "Does this customer message convey urgency?",
          criteria: {
            true: "Explicitly time-sensitive",
            false: "No urgency expressed",
          },
        },
      },
    });

    expect(response.model).toMatch(/^jev-/);
    expect(response.answers.urgent.type).toBe("noul");
    if (response.answers.urgent.type === "noul") {
      expect(response.answers.urgent.noul).toBeGreaterThanOrEqual(0);
      expect(response.answers.urgent.noul).toBeLessThanOrEqual(1);
    }
    expect(response.usage.input_tokens).toBeGreaterThan(0);
  }, 60_000);

  paidTest("choice returns one configured option and probabilities", async () => {
    const criteria = {
      billing: "Payments, invoicing, and refunds",
      technical: "Bugs, outages, and integrations",
      sales: "Pricing, upgrades, and new accounts",
    };
    const response = await client.decide({
      state: "My payout was rejected again.",
      questions: {
        department: {
          type: "choice",
          instructions: "Which team should handle this request?",
          criteria,
        },
      },
    });

    const answer = response.answers.department;
    expect(answer.type).toBe("choice");
    if (answer.type === "choice") {
      expect(Object.keys(criteria)).toContain(answer.choice);
      expect(Object.keys(answer.probabilities).sort()).toEqual(
        Object.keys(criteria).sort()
      );
      expect(answer.confidence).toBeGreaterThanOrEqual(0);
      expect(answer.confidence).toBeLessThanOrEqual(1);
    }
  }, 60_000);

  paidTest("score returns a weighted rubric value", async () => {
    const levels = ["Calm", "Frustrated", "Very angry"];
    const response = await client.decide({
      state: "This is ridiculous. It has broken every day this week!",
      questions: {
        frustration: {
          type: "score",
          instructions: "How frustrated is the customer?",
          criteria: levels,
        },
      },
    });

    const answer = response.answers.frustration;
    expect(answer.type).toBe("score");
    if (answer.type === "score") {
      expect(answer.score).toBeGreaterThanOrEqual(0);
      expect(answer.score).toBeLessThanOrEqual(levels.length - 1);
      expect(Object.values(answer.legend)).toEqual(levels);
      expect(answer.confidence).toBeGreaterThanOrEqual(0);
      expect(answer.confidence).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});
