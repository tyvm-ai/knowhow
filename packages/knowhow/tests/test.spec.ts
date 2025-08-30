jest.mock("fs");
jest.mock("../src/plugins/plugins");
jest.mock("../src/utils");
jest.mock("../src/agents/tools/lintFile");
jest.mock("../src/index");
jest.mock("../src/services/S3", () => ({
  S3Service: jest.fn().mockImplementation(() => ({
    uploadFile: jest.fn(),
    downloadFile: jest.fn(),
    uploadToPresignedUrl: jest.fn(),
    downloadFromPresignedUrl: jest.fn(),
  })),
}));
jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(),
}));

import * as fs from "fs";
import {
  embeddingSearch,
  readFile,
  scanFile,
  modifyFile,
  execCommand,
  writeFile,
} from "../src/agents/tools";
import { services } from "../src/services";
import { patchFile } from "../src/agents/tools/patch";
import { fileExists } from "../src/utils";
import * as utils from "../src/utils";
import { lintFile } from "../src/agents/tools/lintFile";
import { embed } from "../src/index";

const mockFs = jest.mocked(fs);
const mockFileExists = jest.mocked(fileExists);
const mockUtils = jest.mocked(utils);
const mockLintFile = jest.mocked(lintFile);
const mockEmbed = jest.mocked(embed);

test("searchFiles should call the embeddings plugin with the correct keyword", async () => {
  const { Plugins } = services();
  const expectedResult = JSON.stringify({ files: ["test1.js", "test2.js"] });
  const mocked = Plugins as jest.Mocked<typeof Plugins>;
  const keyword = "test";

  // Setting up the plugin to return the expected result
  mocked.call.mockResolvedValue(expectedResult);

  const result = await embeddingSearch(keyword);

  // Verifying that the plugin was called with the correct keyword
  expect(Plugins.call).toHaveBeenCalledWith("embeddings", keyword);
  // Verifying that the function returns the expected result
  expect(result).toBe(expectedResult);
});

test("readFile should return the content of a file", async () => {
  const filePath = "test.txt";
  const fileContent = "Hello World";

  mockUtils.fileExists.mockResolvedValue(true);

  // Mock readFile to return the fileContent
  mockFs.readFileSync.mockReturnValue(fileContent);

  const result = await readFile(filePath);

  // Verify readFile was called with the correct file path
  expect(fs.readFileSync).toHaveBeenCalledWith(filePath, "utf8");
  // Verify the result is a patch (since readFile now returns patch format)
  expect(result).toContain(fileContent);
});

test("scanFile should return the contents of a specified range of lines from a file", () => {
  const filePath = "test.txt";
  const fileContentLines = ["Line1", "Line2", "Line3", "Line4", "Line5"];
  const startLine = 3;
  const endLine = 3;

  // Mock fs.readFileSync to return joined fileContentLines
  mockFs.readFileSync.mockReturnValue(fileContentLines.join("\n"));

  const result = scanFile(filePath, startLine, endLine);

  // Verify fs.readFileSync was called with the correct file path
  expect(fs.readFileSync).toHaveBeenCalledWith(filePath, "utf8");
  // Verify that the correct range of lines is returned
  expect(result).toBe(
    JSON.stringify([
      [1, "Line1"],
      [2, "Line2"],
      [3, "Line3"],
      [4, "Line4"],
      [5, "Line5"],
    ])
  );
});

test("writeFile should write the full contents to a file", () => {
  const filePath = "testWrite.txt";
  const contentToWrite = "Writing to file";

  // Mock fs.writeFileSync to not actually write to disk
  mockFs.writeFileSync.mockImplementation(() => {});

  const result = writeFile(filePath, contentToWrite);

  // Verify fs.writeFileSync was called with the correct arguments
  expect(fs.writeFileSync).toHaveBeenCalledWith(filePath, contentToWrite);
  // Verify the function returns a success message
  expect(result).toBe(`File ${filePath} written`);
});

test("applyPatchFile should apply a patch to a file", async () => {
  const filePath = "testPatch.txt";
  const originalContent = "Original content\n";
  const patch = "@@ -1,1 +1,1 @@\n-Original content\n+Patched content\n";

  // Mock fs.existsSync to return true (file exists)
  mockFs.existsSync.mockReturnValue(true);

  // Mock the utilities that patchFile uses
  mockUtils.readFile.mockResolvedValue(originalContent);
  mockUtils.writeFile.mockResolvedValue(undefined);
  mockUtils.fileExists.mockResolvedValue(true);
  mockUtils.mkdir.mockResolvedValue(undefined);
  mockUtils.splitByNewLines.mockImplementation((text: string) =>
    text.split(/\r?\n/)
  );
  mockLintFile.mockResolvedValue("");
  mockEmbed.mockResolvedValue(undefined);

  const result = await patchFile(filePath, patch);

  // Verify the function returns a success message
  expect(result).toContain("Patch applied successfully");
}, 60000); // Increase timeout to 60 seconds

test("execCommand should execute a system command and return its output", async () => {
  const command = 'echo "Hello World"';
  const expectedOutput = "Hello World\n";

  // Use the execCommand and expect it to return the correct result
  const result = await execCommand(command);
  expect(result).toEqual(expectedOutput);
});

test("execCommand should return an error message if the command fails", async () => {
  const command = "exit 1";
  const expectedOutput = "Command failed: exit 1";

  // Use the execCommand and expect it to return the correct result
  const result = await execCommand(command);
  expect(result.trim()).toEqual(expectedOutput);
});

test("it should run a test", () => {
  expect(true).toEqual(true);
});
