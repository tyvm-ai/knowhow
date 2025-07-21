import "source-map-support/register";

import {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat";
import { parsePatch, diffLines, applyPatch } from "diff";
import { PatchingAgent } from "../../agents/patcher/patcher";
import { ask, writeFile, mkdir } from "../../utils";
import {
  fixPatch,
  parseHunks,
  categorizeHunks,
  hunksToPatch,
} from "../../agents/tools/patch";
import { md5Hash } from "../../hashes";
import { services } from "../../services";
const dataset = [];

class PatchTestAgent extends PatchingAgent {
  name = "PatchTestAgent";

  async getInitialMessages(userInput: string) {
    const baseMessages = await super.getInitialMessages(userInput);

    baseMessages.push({
      content:
        "We are testing the patch tool, attempt to use only that tool with the input provided in the user's message.",
      role: "user",
    });

    return baseMessages;
  }

  async processToolMessages(toolCall: ChatCompletionMessageToolCall) {
    const toolMessages = await super.processToolMessages(toolCall);

    toolMessages.push({
      name: "finalAnswer",
      content: "Done",
    });
    return toolMessages;
  }
}

async function testDataset() {
  const patchAgent = new PatchTestAgent(services());

  let successCount = 0;
  let attempts = 0;
  const testHash = "";

  const shuffled = dataset
    .map((value) => ({ value, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ value }) => value);

  for (const patchData of shuffled) {
    const hash = await md5Hash(patchData.patch);

    if (testHash && testHash !== hash) {
      // We are loooking to test one case
      continue;
    }

    const changes = parseHunks(patchData.patch);
    const totalChanges = changes
      .map((hunk) => hunk.additions.length + hunk.subtractions.length)
      .reduce((a, b) => a + b, 0);

    // Only test small changes
    if (totalChanges > 10) {
      continue;
    }

    async function testPatchFile(
      filePath: string,
      patch: string
    ): Promise<string> {
      // console.log("AI Suggested", filePath, { patch, answer: patchData.patch });
      //
      //
      attempts++;

      const originalContent = patchData.before;
      const fixedPatch = fixPatch(patchData.before, patch);
      const { validHunks, invalidHunks } = categorizeHunks(
        originalContent,
        patch
      );
      const validPatch = hunksToPatch(validHunks);

      const updatedContent = applyPatch(originalContent, validPatch);
      const success = !!updatedContent && validHunks.length;
      await saveToolDiagnosticFiles(
        patchData,
        patch,
        fixedPatch,
        validPatch,
        success
      );

      if (success) {
        successCount++;
      }

      if (
        updatedContent === patchData.after ||
        fixedPatch === patchData.patch
      ) {
        console.log("SUCCESS");
        console.log("EXACT MATCH");
      } else {
        console.log("AI SUGGESTED");
        console.log(patch);

        console.log("FIXED PATCH");
        console.log(fixedPatch);

        console.log("ACTUAL");
        console.log(patchData.patch);

        console.log("DID PATCH APPLY?", !!updatedContent);
      }

      if (!success) {
        // await ask("Proceed?");
      }

      const invalidPatch = hunksToPatch(invalidHunks);
      const invalidHunksMessage = invalidHunks.length
        ? `Patch Partially Applied: \n Invalid Hunks: \n${invalidPatch} `
        : "";

      const appliedMessage = validHunks.length
        ? `Valid Hunks Applied: \n${validPatch}`
        : "";

      return `${invalidHunksMessage} \n ${appliedMessage}`;
    }

    patchAgent.tools.setFunction("patchFile", testPatchFile);

    const parsedAnswer = parsePatch(patchData.patch);
    const fileName = parsedAnswer[0].oldFileName;

    await patchAgent.call(`Can you modify this file:
file path: ${fileName}
${patchData.before}

      so that it would look like this:
${patchData.after}?`);

    /*
     *const toolResponses = await patchAgent.processToolMessages({
     *  id: "test",
     *  type: "function",
     *  function: {
     *    name: "patchFile",
     *    arguments: JSON.stringify({
     *      filePath: fileName,
     *      patch: patchData.patch,
     *    }),
     *  },
     *});
     */
    console.log({ successCount, attempts, total: dataset.length });
  }
}

async function saveToolDiagnosticFiles(
  patchData: typeof dataset[0],
  patch: string,
  fixedPatch: string,
  validPatch: string,
  success
) {
  const failureDir = success ? "success" : "fail";
  const patchHash = await md5Hash(patchData.patch);
  const dirName = `./src/dataset/diffs/test_files/${failureDir}/${patchHash}`;
  await mkdir(dirName, { recursive: true });

  await writeFile(`${dirName}/before.ignore.ts`, patchData.before);
  await writeFile(`${dirName}/ai-patch.diff`, patch);
  await writeFile(`${dirName}/actual-patch.diff`, patchData.patch);
  await writeFile(`${dirName}/after.ignore.ts`, patchData.after);
  await writeFile(`${dirName}/ai-fixed-patch.diff`, fixedPatch);
  await writeFile(`${dirName}/ai-valid-patch.diff`, validPatch);
}

if (require.main === module) {
  testDataset();
}
