import { Trace, TraceAll } from "../../../src/util/Trace";
import {
  SpanHandle,
  TracerImpl,
  TracingService,
} from "../../../src/services/TracingService";
import { ToolsService } from "../../../src/services/Tools";

class TestSpan implements SpanHandle {
  ended = false;
  error?: unknown;

  setAttribute() {}

  recordError(error: unknown) {
    this.error = error;
  }

  end() {
    this.ended = true;
  }
}

class TestTracer implements TracerImpl {
  spans: Array<{
    name: string;
    attributes?: Record<string, string | number | boolean>;
    span: TestSpan;
  }> = [];

  startSpan(
    name: string,
    attributes?: Record<string, string | number | boolean>
  ): SpanHandle {
    const span = new TestSpan();
    this.spans.push({ name, attributes, span });
    return span;
  }

  withSpan<T>(_span: SpanHandle, fn: () => T): T {
    return fn();
  }
}

describe("tracing decorators", () => {
  const tracer = new TestTracer();

  beforeEach(() => {
    tracer.spans = [];
    TracingService.register(tracer);
  });

  afterAll(() => TracingService.reset());

  it("traces and closes synchronous and asynchronous methods", async () => {
    @TraceAll()
    class Subject {
      sync() {
        return "sync";
      }

      async asyncMethod() {
        return "async";
      }
    }

    const subject = new Subject();
    expect(subject.sync()).toBe("sync");
    expect(await subject.asyncMethod()).toBe("async");

    expect(tracer.spans.map(({ name }) => name)).toEqual([
      "Subject.sync",
      "Subject.asyncMethod",
    ]);
    expect(tracer.spans.every(({ span }) => span.ended)).toBe(true);
  });

  it("records rejected method errors before rethrowing them", async () => {
    const failure = new Error("failed");

    class Subject {
      @Trace()
      async fail() {
        throw failure;
      }
    }

    await expect(new Subject().fail()).rejects.toBe(failure);
    expect(tracer.spans[0].span.error).toBe(failure);
    expect(tracer.spans[0].span.ended).toBe(true);
  });

  it("traces the concrete ToolsService.callTool path", async () => {
    const tools = new ToolsService();
    tools.addTool({
      type: "function",
      function: {
        name: "echo",
        description: "Echo a value",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    });
    tools.setFunction("echo", ({ value }: { value: string }) => value);

    const result = await tools.callTool({
      id: "trace-test",
      type: "function",
      function: { name: "echo", arguments: JSON.stringify({ value: "ok" }) },
    });

    expect(result.functionResp).toBe("ok");
    expect(tracer.spans.some(({ name }) => name === "ToolsService.callTool"))
      .toBe(true);
  });
});
