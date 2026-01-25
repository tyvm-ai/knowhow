import { DockerService } from "../../src/services/DockerService";

describe("DockerService", () => {
  let dockerService: DockerService;

  beforeEach(() => {
    dockerService = new DockerService();
  });

  describe("checkDockerAvailable", () => {
    it("should check if Docker is available", async () => {
      const result = await dockerService.checkDockerAvailable();
      // Result will be true or false depending on whether Docker is installed
      expect(typeof result).toBe("boolean");
    });
  });

  describe("imageExists", () => {
    it("should check if the worker image exists", async () => {
      const result = await dockerService.imageExists();
      expect(typeof result).toBe("boolean");
    });
  });
});
