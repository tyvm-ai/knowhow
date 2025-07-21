import * as fs from "fs";
import { readFile, writeFile } from "../../../src/utils";
import { agents } from "../../../src/agents";
import { FlagsService } from "../../../src/services/flags";

describe("Developer", () => {
  const { Patcher } = agents();
  beforeAll(() => {
    Patcher.disableTool("searchFiles");
    Patcher.disableTool("execCommand");
    Patcher.enableTool("modifyFile");
    Patcher.enableTool("readFile");
  });

  test("should be able to patch a codebase", async () => {
    const inputPath = "tests/integration/patching/input.txt";
    const originalText = (await readFile(inputPath)).toString();
    await Patcher.call(
      `Update the file in ${inputPath} change the string "finalAnswer" to "FinalAnswer" on line 120. Do not modify anything else. Treat this file as a typescript file.`
    );

    const updatedText = (await readFile(inputPath)).toString();
    await writeFile(inputPath, originalText);

    expect(updatedText).toBe(
      originalText.replace(`"finalAnswer"`, `"FinalAnswer"`)
    );
  });

  test("should be able to update the unseen file", async () => {
    const unseenPath = "tests/integration/patching/unseen.txt";
    const originalText = (await readFile(unseenPath)).toString();
    await Patcher.call(
      `Update the file in ${unseenPath} change the file additions and deletions count from 200 to 300. Do not modify anything else. Treat this file as a typescript file.`
    );

    const updatedText = (await readFile(unseenPath)).toString();
    await writeFile(unseenPath, originalText);

    expect(updatedText).toBe(originalText.replaceAll("200", "300"));
  });

  test.only("should be able to create a simple flag service", async () => {
    const outputPath = "tests/integration/fileblocks/outputs/flags.js";

    const promptText = `
  Create the following class

    - **Class Name**: FlagsService
    - **Internal Variables**:
      - flags: Object
      - log: Boolean
    - **Constructor**:
      - Parameters: flags (Array<string>), log (Boolean)
    - **Methods**:
      - register(flags: Array<string>): Initializes flags with false.
      - flip(flag: string): Toggles and logs the state of a flag.
      - enableLogging(): Enables logging.
      - disableLogging(): Disables logging.
      - enabled(flag: string): Checks if a flag is enabled.
    - **Singleton Variable**: Flags

      Make sure to module.exports the class and Singleton, as we will be importing it in the test via require("./outputs/flags.js").Flags
`;
    await Patcher.call(
      `Modify the file in ${outputPath} for these instructions.: ${promptText}`
    );

    const fileContent = (await readFile(outputPath)).toString();
    console.log(fileContent);
    jest.resetModules();
    const service: FlagsService = require("./outputs/flags.js").Flags;
    try {
      service.register(["test"]);
      expect(service.enabled("test")).toEqual(false);
      service.flip("test");
      expect(service.enabled("test")).toEqual(true);

      await Patcher.call(
        `Modify the file in ${outputPath} and add a method called hasFlag that takes a string and returns a boolean. It should return true if the flag is defined at all, even if it is false. This is a unit test, only modify the file I've specified.`
      );

      jest.resetModules();

      const newService: FlagsService & {
        hasFlag: (flag: string) => boolean;
      } = require("./outputs/flags.js").Flags;

      newService.register(["test"]);
      expect(newService.hasFlag("test")).toEqual(true);
      fs.unlinkSync(outputPath);
    } catch (e) {
      console.log(e);
    }
  });
});
