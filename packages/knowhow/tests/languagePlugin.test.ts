jest.mock("../src/utils", () => ({
  readFile: jest.fn().mockReturnValue(Buffer.from("test")),
  fileExists: jest.fn().mockReturnValue(true),
  fileStat: jest.fn(),
}));

jest.mock("../src/config", () => ({
  getConfig: jest.fn(),
  getLanguageConfig: jest.fn(),
}));

jest.mock("../src/plugins/plugins", () => ({
  Plugins: {
    call: jest.fn().mockReturnValue("test"),
    listPlugins: jest.fn().mockReturnValue(["github", "asana"]),
  },
}));

import { LanguagePlugin } from "../src/plugins/language";
import { Config } from "../src/types";
import * as utils from "../src/utils";
import { getConfig, getLanguageConfig } from "../src/config";
import { services } from "../src/services";

const mockedConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockedLanguageConfig = getLanguageConfig as jest.MockedFunction<
  typeof getLanguageConfig
>;

describe("LanguagePlugin", () => {
  const userPrompt = "test prompt including terms";

  test("should call the correct plugins based on the user prompt", async () => {
    const { Plugins } = services();

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

    const mockedPlugins = jest.mocked(Plugins);
    const languagePlugin = new LanguagePlugin({ Plugins: mockedPlugins });
    const pluginResponse = await languagePlugin.call(userPrompt);

    expect(utils.fileExists).toHaveBeenCalled();
    expect(utils.readFile).toHaveBeenCalled();
    expect(mockedPlugins.listPlugins).toHaveBeenCalled();
    expect(mockedPlugins.call).toHaveBeenCalledWith(
      "github",
      expect.any(String)
    );
    expect(mockedPlugins.call).toHaveBeenCalledWith(
      "asana",
      expect.any(String)
    );
    expect(pluginResponse).toContain(
      "LANGUAGE PLUGIN: The user mentioned these terms triggering contextual expansions"
    );
  });

  test("should return a message if no matching terms found", async () => {
    const { Plugins } = services();

    mockedConfig.mockResolvedValue({ plugins: ["github"] } as Config);
    mockedLanguageConfig.mockResolvedValue({});

    const languagePlugin = new LanguagePlugin({ Plugins });
    const pluginResponse = await languagePlugin.call(userPrompt);

    expect(pluginResponse).toEqual("LANGUAGE PLUGIN: No matching terms found");
  });
});
