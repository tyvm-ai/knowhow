import { ToolsService } from "../../src/services/Tools";

describe("ToolsService.setFunction bug with multiple registrations", () => {
  let toolsService: ToolsService;

  beforeEach(() => {
    toolsService = new ToolsService();
  });

  it("should update function when setFunction is called multiple times with different implementations", () => {
    // Simulate first TokenCompressor registering expandTokens
    const storage1 = new Map();
    storage1.set("key1", "data1");
    
    const expandTokens1 = ({ key }: { key: string }) => {
      const data = storage1.get(key);
      if (!data) throw new Error(`No data found for key: ${key}`);
      return data;
    };

    // Register the tool definition
    toolsService.addTools([
      {
        type: "function",
        function: {
          name: "expandTokens",
          description: "Retrieve compressed data",
          parameters: {
            type: "object",
            properties: {
              key: { type: "string", description: "The key" },
            },
            required: ["key"],
          },
        },
      },
    ]);

    // First registration
    toolsService.setFunction("expandTokens", expandTokens1);
    
    // Test first function works
    const func1 = toolsService.getFunction("expandTokens");
    expect(func1({ key: "key1" })).toBe("data1");

    // Simulate second TokenCompressor registering expandTokens with NEW storage
    const storage2 = new Map();
    storage2.set("key2", "data2");
    
    const expandTokens2 = ({ key }: { key: string }) => {
      const data = storage2.get(key);
      if (!data) throw new Error(`No data found for key: ${key}`);
      return data;
    };

    // Second registration (simulating AgentModule creating new TokenCompressor)
    toolsService.setFunction("expandTokens", expandTokens2);
    
    // Test second function
    const func2 = toolsService.getFunction("expandTokens");
    
    // After fix: Should NOT work with old storage anymore
    expect(() => func2({ key: "key1" })).toThrow("No data found for key: key1");
    
    // After fix: Should work with NEW storage
    expect(func2({ key: "key2" })).toBe("data2");
  });
});
