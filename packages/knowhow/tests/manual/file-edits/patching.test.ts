import { readFile, writeFile } from "../../../src/utils";
import { createPatch, applyPatch } from "diff";
import { scanFile } from "../../../src/agents/tools";
import { patchFile } from "../../../src/agents/tools/patch";
import { agents } from "../../../src/agents";
import { services } from "../../../src/services";
import { includedTools } from "../../../src/agents/tools/list";
import * as allTools from "../../../src/agents/tools";

const inputPath = "tests/integration/patching/input.txt";
const outputPath = "tests/integration/patching/output.txt";
const patchPath = "tests/integration/patching/patch.txt";

const brokenPatch = `Index: tests/integration/patching/input.txt
===================================================================
--- tests/integration/patching/input.txt
+++ tests/integration/patching/input.txt
@@ -116,9 +116,9 @@
         // Add the tool responses to the thread
         messages.push(
           ...(toolMessages as Array<ChatCompletionToolMessageParam>)
         );
-        const finalMessage = toolMessages.find((m) => m.name === "finalAnswer");
+        const finalMessage = toolMessages.find((m) => m.name === "FinalAnswer");
         if (finalMessage) {
           return finalMessage.content;
         }
       }\n`;

describe("Patcher", () => {
  let Agents: any, Tools: any;
  
  beforeAll(async () => {
    const { Patcher } = agents();
    ({ Agents, Tools } = services());
    Agents.registerAgent(Patcher);
    Tools.addTools(includedTools);
    const toolFunctions = Object.entries(allTools)
      .filter(([_, value]) => typeof value === "function")
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});
    Tools.addFunctions(toolFunctions);
  });

  test("should be able to apply actual patch", async () => {
    const oldString = (await readFile(inputPath)).toString();
    const newString = (await readFile(outputPath)).toString();
    const workingPatch = (await readFile(patchPath)).toString();

    const applied = await applyPatch(oldString, patchPath);

    // Expect this not to work
    expect(applied).toBe(oldString);

    // Expect this to work
    const workingApply = applyPatch(oldString, workingPatch);
    expect(workingApply).toBe(newString);

    console.log({
      brokenPatch: Buffer.from(brokenPatch),
      workingPatch: Buffer.from(workingPatch),
    });

    const buffer1 = Buffer.from(brokenPatch);
    const buffer2 = Buffer.from(workingPatch);

    console.log("bufferLength", buffer1.length, buffer2.length);
    const length = Math.max(buffer1.length, buffer2.length);
    for (let i = 0; i < length; i++) {
      if (buffer1[i] !== buffer2[i]) {
        console.log("not equal", i, buffer1[i], buffer2[i]);
      }
    }

    expect(brokenPatch).toBe(workingPatch);
  });

  test("should generate the diff", async () => {
    const oldString = (await readFile(inputPath)).toString();
    const newString = (await readFile(outputPath)).toString();

    const patch = createPatch(inputPath, oldString, newString);
    await writeFile(patchPath, patch);

    // const actualPatch = (await readFile(patchPath)).toString();

    console.log(patch);

    const scanned = await scanFile(inputPath, 120, 120);
    console.log(JSON.parse(scanned));

    expect(patch).toBe(brokenPatch);
  });

  test("should be able to patch a codebase", async () => {
    const originalText = (await readFile(inputPath)).toString();
    console.log(
      await Agents.callAgent(
        "Patcher",
        `Update the file in ${inputPath} change the string "finalAnswer" to "FinalAnswer", as we are changing the tool name to be FinalAnswer instead of finalAnswer. This should be around line 120. Do not modify anything else. Treat this file as a typescript file. Only try one patch. If it fails stop`
      )
    );

    const updatedText = (await readFile(inputPath)).toString();
    await writeFile(inputPath, originalText);

    expect(updatedText).toBe(
      originalText.replace(`"finalAnswer"`, `"FinalAnswer"`)
    );
  });

  it("should be able to patch when given the answer", async () => {
    const originalText = (await readFile(inputPath)).toString();
    await Agents.callAgent(
      "Patcher",
      `Update the file in ${inputPath} change the string "finalAnswer" to "FinalAnswer" on line 120. Do not modify anything else. Heres the answer: ${brokenPatch}.`
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
    await Agents.callAgent(
      "Patcher",
      `Update the file in ${unseenPath} change the file additions and deletions count from 200 to 300. Do not modify anything else. Treat this file as a typescript file.`
    );

    const updatedText = (await readFile(unseenPath)).toString();
    await writeFile(unseenPath, originalText);

    expect(updatedText).toBe(originalText.replaceAll("200", "300"));
  });
});
