jest.mock("../src/utils", () => ({
  readFile: jest.fn().mockReturnValue(Buffer.from("test")),
  fileExists: jest.fn().mockReturnValue(true),
  fileStat: jest.fn(),
}));

jest.mock("../src/config", () => ({
  getConfig: jest.fn(),
  getConfigSync: jest.fn(),
  getLanguageConfig: jest.fn(),
}));

jest.mock("../src/plugins/plugins", () => ({
  PluginService: jest.fn().mockImplementation(() => ({
    listPlugins: jest.fn(),
    call: jest.fn(),
  })),
}));

import { LanguagePlugin } from "../src/plugins/language";
import { Config } from "../src/types";
import * as utils from "../src/utils";
import { getConfig, getLanguageConfig } from "../src/config";
import { PluginService } from "../src/plugins/plugins";

const mockedConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockedLanguageConfig = getLanguageConfig as jest.MockedFunction<
  typeof getLanguageConfig
>;
const MockedPluginService = PluginService as jest.MockedClass<typeof PluginService>;

describe("LanguagePlugin", () => {
  const userPrompt = "test prompt including terms";

  test("should call the correct plugins based on the user prompt", async () => {
    const mockPluginService = new MockedPluginService({} as any);
    const mockListPlugins = jest.fn().mockReturnValue(["github", "asana"]);
    const mockCall = jest.fn().mockResolvedValue(["mocked plugin response"]);
    
    mockPluginService.listPlugins = mockListPlugins;
    mockPluginService.call = mockCall;

    mockedConfig.mockResolvedValue({ plugins: ["github", "asana"] } as Config);
    mockedLanguageConfig.mockResolvedValue({
      test: {
        sources: [
          { kind: "github", data: ["http://github.com/test"] },
          { kind: "asana", data: ["http://asana.com/test"] },
          { kind: "file", data: ["../.knowhow/knowhow.json"] },
        ],
      },
    });

    const languagePlugin = new LanguagePlugin({ Plugins: mockPluginService });
    const pluginResponse = await languagePlugin.call(userPrompt);

    expect(utils.fileExists).toHaveBeenCalled();
    expect(utils.readFile).toHaveBeenCalled();
    expect(mockListPlugins).toHaveBeenCalled();
    expect(mockCall).toHaveBeenCalledWith(
      "github",
      expect.any(String)
    );
    expect(mockCall).toHaveBeenCalledWith(
      "asana",
      expect.any(String)
    );
    expect(pluginResponse).toContain(
      "LANGUAGE PLUGIN: The user mentioned these terms triggering contextual expansions"
    );
  });

  test("should return a message if no matching terms found", async () => {
    const mockPluginService = new MockedPluginService({} as any);
    const mockListPlugins = jest.fn().mockReturnValue(["github"]);
    
    mockPluginService.listPlugins = mockListPlugins;

    mockedConfig.mockResolvedValue({ plugins: ["github"] } as Config);
    mockedLanguageConfig.mockResolvedValue({});

    const languagePlugin = new LanguagePlugin({ Plugins: mockPluginService });
    const pluginResponse = await languagePlugin.call(userPrompt);

    expect(pluginResponse).toEqual("LANGUAGE PLUGIN: No matching terms found");
  });
});