import "source-map-support/register";
import { createPatch } from "diff";
import * as fs from "fs";
import { execAsync, readFile, writeFile } from "../../utils";
import { summarizeTexts } from "../../ai";

async function generateDataset() {
  const datasetFile = await readFile(__dirname + "/dataset.json");
  const dataset = JSON.parse(datasetFile.toString());

  // convert to jsonl
  function toMessage(d) {
    const { userMessage, before, patch } = d;
    const fileName = patch.split(" ")[1].split("\n")[0];

    return {
      messages: [
        {
          role: "system",
          content:
            "Codebase Agent. You use the tools to read and write code, to help the developer implement features faster. Call final answer once you have finished implementing what is requested. As an agent you will receive multiple rounds of input until you call final answer. You are not able to request feedback from the user, so proceed with your plans and the developer will contact you afterwards if they need more help. After modifying files, you will read them to ensure they look correct before calling final answer. You always check your modifications for syntax errors or bugs. You always make the smallest modifications required to files, rather than outputting the entire file. You think step by step about the blocks of code you're modiyfing",
        },
        { role: "user", content: userMessage },
        {
          role: "assistant",
          function_call: {
            name: "readFile",
            arguments: JSON.stringify({
              fileName,
            }),
          },
        },
        {
          role: "assistant",
          function_call: {
            name: "applyPatchFile",
            arguments: JSON.stringify({
              fileName,
              patch,
            }),
          },
        },
      ],
    };
  }
  const jsonl = dataset.map((d) => JSON.stringify(toMessage(d))).join("\n");
  await writeFile(__dirname + "/dataset.jsonl", jsonl);
  console.log(dataset);
}

if (require.main === module) {
  generateDataset();
}
