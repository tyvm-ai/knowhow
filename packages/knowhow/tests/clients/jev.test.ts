import { GenericJevClient } from "../../src/clients/jev";
import { AIClient } from "../../src/clients";
import type { GenericClient } from "../../src/clients/types";

describe("GenericJevClient", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as typeof fetch;
  });

  function respond(answers: Record<string, unknown>) {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers,
          usage: { input_tokens: 12, output_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
  }

  function requestBody() {
    return JSON.parse(fetchMock.mock.calls[0][1].body as string);
  }

  test("sends and returns a noul decision", async () => {
    respond({ urgent: { type: "noul", noul: 0.95 } });
    const client = new GenericJevClient("test-key");

    const result = await client.decide({
      state: "Help! My payouts have failed for 3 days.",
      questions: {
        urgent: {
          type: "noul",
          instructions: "Does this convey urgency?",
          criteria: { true: "Time-sensitive", false: "Not urgent" },
        },
      },
    });

    expect(requestBody()).toEqual({
      state: "Help! My payouts have failed for 3 days.",
      model: "jev-latest",
      questions: {
        urgent: {
          type: "noul",
          instructions: "Does this convey urgency?",
          criteria: { true: "Time-sensitive", false: "Not urgent" },
        },
      },
    });
    expect(result.answers.urgent).toEqual({ type: "noul", noul: 0.95 });
    expect(result.usd_cost).toBeCloseTo(0.000000504, 12);
  });

  test("sends and returns a choice decision", async () => {
    respond({
      department: {
        type: "choice",
        choice: "billing",
        probabilities: { billing: 0.88, technical: 0.12 },
        confidence: 0.81,
      },
    });
    const client = new GenericJevClient("test-key");

    const result = await client.decide({
      state: { message: "My payout failed" },
      model: "jev-latest",
      questions: {
        department: {
          type: "choice",
          instructions: "Which team should handle this?",
          criteria: { billing: "Payments", technical: "Bugs" },
        },
      },
    });

    expect(requestBody().questions.department.type).toBe("choice");
    expect(result.answers.department).toMatchObject({
      type: "choice",
      choice: "billing",
    });
  });

  test("sends and returns a score decision", async () => {
    respond({
      frustration: {
        type: "score",
        score: 1.05,
        legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
        probabilities: { "0": 0, "1": 0.95, "2": 0.05 },
        confidence: 0.92,
      },
    });
    const client = new GenericJevClient("test-key");

    const result = await client.decide({
      state: ["Help!", "This has failed for days."],
      questions: {
        frustration: {
          type: "score",
          instructions: "How frustrated is the customer?",
          criteria: ["Calm", "Frustrated", "Very angry"],
        },
      },
    });

    expect(requestBody().questions.frustration.type).toBe("score");
    expect(result.answers.frustration).toMatchObject({ type: "score", score: 1.05 });
  });

  test("prices input tokens and treats output tokens as free", () => {
    const client = new GenericJevClient("test-key");
    expect(
      client.calculateCost("jev-latest", {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      })
    ).toBe(0.042);
  });

  test("uses the standard unsupported-provider behavior when decide is absent", async () => {
    const unsupported = {
      setKey: jest.fn(),
      createChatCompletion: jest.fn(),
      createEmbedding: jest.fn(),
      getModels: jest.fn().mockResolvedValue([]),
    } as unknown as GenericClient;
    const clients = new AIClient();
    clients.registerClient("other", unsupported);
    clients.registerModels("other", ["jev-latest"]);

    await expect(
      clients.decide("other", {
        state: "test",
        questions: { answer: { type: "noul", instructions: "Is this true?" } },
      })
    ).rejects.toThrow("Provider other does not support decisions.");
  });
});
