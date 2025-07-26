import { SwaggerMcpGenerator } from "../src/generator";
import nock from "nock";
import fs from "fs";
import path from "path";

const SWAGGER_URL = "https://petstore.swagger.io/v2/swagger.json";

describe("Generated Client Code Tests", () => {
  let generator: SwaggerMcpGenerator;
  let mockSwaggerSpec: any;
  let generatedClientCode: string;

  beforeAll(() => {
    mockSwaggerSpec = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "fixtures", "petstore-swagger.json"),
        "utf8"
      )
    );
  });

  beforeEach(async () => {
    nock.cleanAll();

    // Mock the HTTP request for swagger spec
    nock("https://petstore.swagger.io")
      .get("/v2/swagger.json")
      .reply(200, mockSwaggerSpec);

    generator = new SwaggerMcpGenerator(SWAGGER_URL);
    await generator.loadSwaggerSpec();
    generatedClientCode = generator.generateClientFunctions();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe("Client code generation", () => {
    it("should generate SwaggerClient class", () => {
      expect(generatedClientCode).toContain("class SwaggerClient");
      expect(generatedClientCode).toContain(
        "constructor(baseUrl: string, headers?: Record<string, string>)"
      );
    });

    it("should include required imports", () => {
      expect(generatedClientCode).toContain("import axios");
      expect(generatedClientCode).toContain("import { AxiosResponse }");
    });

    it("should generate methods for each API endpoint", () => {
      // Check for key Petstore endpoints
      expect(generatedClientCode).toContain("async getPetById(");
      expect(generatedClientCode).toContain("async addPet(");
      expect(generatedClientCode).toContain("async findPetsByStatus(");
      expect(generatedClientCode).toContain("async updatePet(");
      expect(generatedClientCode).toContain("async deletePet(");
    });

    it("should handle path parameters correctly", () => {
      // getPetById should replace {petId} in path
      expect(generatedClientCode).toContain("getPetById(petId: number");
      expect(generatedClientCode).toContain("`/pet/${petId}`");
    });

    it("should handle query parameters correctly", () => {
      // findPetsByStatus should include status as query parameter
      expect(generatedClientCode).toContain(
        "findPetsByStatus(status: string[]"
      );
      expect(generatedClientCode).toContain("params: { status }");
    });

    it("should handle request body parameters correctly", () => {
      // addPet should accept body parameter
      expect(generatedClientCode).toContain("addPet(body: any");
      expect(generatedClientCode).toContain("data: body");
    });

    it("should include proper TypeScript types", () => {
      expect(generatedClientCode).toContain("Promise<AxiosResponse<any>>");
      expect(generatedClientCode).toContain("Record<string, string>");
    });
  });

  describe("HTTP method handling", () => {
    it("should generate GET requests correctly", () => {
      expect(generatedClientCode).toContain("return this.axiosInstance.get(");
      expect(generatedClientCode).toMatch(
        /this\.axiosInstance\.get\(`.*`[^)]*\)/
      );
    });

    it("should generate POST requests correctly", () => {
      expect(generatedClientCode).toContain("return this.axiosInstance.post(");
      expect(generatedClientCode).toMatch(
        /this\.axiosInstance\.post\(`.*`, body/
      );
    });

    it("should generate PUT requests correctly", () => {
      expect(generatedClientCode).toContain("return this.axiosInstance.put(");
    });

    it("should generate DELETE requests correctly", () => {
      expect(generatedClientCode).toContain(
        "return this.axiosInstance.delete("
      );
    });
  });

  describe("Header handling", () => {
    it("should accept headers in constructor", () => {
      expect(generatedClientCode).toContain("headers?: Record<string, string>");
    });

    it("should merge headers with requests", () => {
      expect(generatedClientCode).toContain("headers: { ...this.headers");
      expect(generatedClientCode).toContain("...headers }");
    });

    it("should create axios instance with base configuration", () => {
      expect(generatedClientCode).toContain(
        "this.axiosInstance = axios.create({"
      );
      expect(generatedClientCode).toContain("baseURL: this.baseUrl");
      expect(generatedClientCode).toContain("headers: this.headers");
    });
  });

  describe("Parameter validation and types", () => {
    it("should generate required parameters correctly", () => {
      // getPetById requires petId parameter
      const getPetByIdMatch = generatedClientCode.match(
        /async getPetById\([^)]+\)/
      );
      expect(getPetByIdMatch).toBeTruthy();
      expect(getPetByIdMatch![0]).toContain("petId: number");
      expect(getPetByIdMatch![0]).not.toContain("petId?:"); // Should not be optional
    });

    it("should generate optional parameters correctly", () => {
      // Look for methods with optional parameters
      expect(generatedClientCode).toMatch(/\w+\?:/); // Should have some optional parameters
    });

    it("should handle array parameters correctly", () => {
      // findPetsByStatus accepts array of strings
      expect(generatedClientCode).toContain("status: string[]");
    });
  });

  describe("URL construction", () => {
    it("should construct URLs with path parameters", () => {
      expect(generatedClientCode).toContain("`/pet/${petId}`");
      expect(generatedClientCode).toMatch(/`\/\w+\/\$\{\w+\}`/);
    });

    it("should handle query parameters in URL construction", () => {
      expect(generatedClientCode).toContain("params: {");
      expect(generatedClientCode).toMatch(/params: \{ \w+ \}/);
    });

    it("should use base URL from constructor", () => {
      expect(generatedClientCode).toContain("baseURL: this.baseUrl");
    });
  });

  describe("Error handling", () => {
    it("should not swallow axios errors", () => {
      // Generated code should let axios handle errors naturally
      expect(generatedClientCode).not.toContain("try {");
      expect(generatedClientCode).not.toContain("catch");
    });

    it("should return axios response directly", () => {
      expect(generatedClientCode).toContain("return this.axiosInstance.");
    });
  });

  describe("Generated client structure validation", () => {
    it("should be valid TypeScript code", () => {
      expect(generatedClientCode).toMatch(/^import/m);
      expect(generatedClientCode).not.toContain("undefined");
      expect(generatedClientCode).not.toContain("syntax error");
    });

    it("should have proper class structure", () => {
      expect(generatedClientCode).toContain("export class SwaggerClient {");
      expect(generatedClientCode).toContain("private baseUrl: string;");
      expect(generatedClientCode).toContain(
        "private headers: Record<string, string>;"
      );
      expect(generatedClientCode).toContain("private axiosInstance");
    });

    it("should have constructor with proper initialization", () => {
      expect(generatedClientCode).toContain(
        "constructor(baseUrl: string, headers?: Record<string, string>) {"
      );
      expect(generatedClientCode).toContain("this.baseUrl = baseUrl;");
      expect(generatedClientCode).toContain("this.headers = headers || {};");
    });
  });

  describe("Method generation for different HTTP verbs", () => {
    beforeEach(async () => {
      // Ensure we have loaded the swagger spec properly
      await generator.loadSwaggerSpec();
      generatedClientCode = generator.generateClientFunctions();
    });

    it("should generate methods for all paths in swagger spec", () => {
      const paths = Object.keys(mockSwaggerSpec.paths || {});

      // Should have methods corresponding to the paths
      expect(paths.length).toBeGreaterThan(0);

      // Check that client code contains methods for main endpoints
      for (const path of paths) {
        const operations = mockSwaggerSpec.paths[path];
        for (const method of Object.keys(operations)) {
          if (["get", "post", "put", "delete", "patch"].includes(method)) {
            const operationId = operations[method].operationId;
            if (operationId) {
              expect(generatedClientCode).toContain(`async ${operationId}(`);
            }
          }
        }
      }
    });

    it("should handle operations without operationId gracefully", () => {
      // Should still generate valid code even if some operations lack operationId
      expect(generatedClientCode).toContain("class SwaggerClient");
      expect(generatedClientCode).not.toContain("undefined");
    });
  });
});
