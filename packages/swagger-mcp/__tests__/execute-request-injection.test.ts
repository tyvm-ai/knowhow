import { DynamicSwaggerClient, SwaggerRequest, SwaggerSpec } from "../src/core/core";

const spec: SwaggerSpec = {
  openapi: "3.0.0",
  info: { title: "Injected transport", version: "1" },
  paths: {
    "/items/{id}": {
      get: { operationId: "getItem", parameters: [], responses: {} },
    },
    "/items": {
      post: {
        operationId: "createItem",
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: {},
      },
    },
  },
};

describe("DynamicSwaggerClient request injection", () => {
  it("uses the injected request for path and query parameters", async () => {
    const request: jest.MockedFunction<SwaggerRequest> = jest.fn().mockResolvedValue({
      status: 200,
      data: { source: "injected" },
    });
    const client = new DynamicSwaggerClient("https://api.example.test", spec, {}, request);

    await expect(client.callOperation("getItem", { id: "abc", page: 2 })).resolves.toEqual({ source: "injected" });
    expect(request).toHaveBeenCalledWith(
      "https://api.example.test/items/abc",
      expect.objectContaining({ method: "get", params: { page: 2 }, maxRedirects: 0 })
    );
  });

  it("uses the injected request for request bodies", async () => {
    const request: jest.MockedFunction<SwaggerRequest> = jest.fn().mockResolvedValue({ status: 201, data: { id: 1 } });
    const client = new DynamicSwaggerClient("https://api.example.test", spec, {}, request);

    await expect(client.callOperation("createItem", { name: "new" })).resolves.toEqual({ id: 1 });
    expect(request).toHaveBeenCalledWith(
      "https://api.example.test/items",
      expect.objectContaining({ method: "post", data: { name: "new" }, maxRedirects: 0 })
    );
  });
});
