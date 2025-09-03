import "source-map-support/register";
import { globSync } from "glob";
import { createPatch } from "diff";
import * as fs from "fs";
import { execAsync } from "../../utils";
import { summarizeTexts } from "../../ai";

async function generateDataset() {
  // Define the path pattern for files to include in the embeddings
  const files = globSync("./**/*.ts", {
    ignore: ["./node_modules/**", "./dist/**", "./.git/**"],
  });

  const dataset = [];

  for (const filePath of files) {
    // Get the most recent commit hash for the file
    const commandOutput = await execAsync(
      `git log --pretty=oneline -- ${filePath}`
    );
    const commitHashes = commandOutput.stdout.split("\n");
    for (const commitHash of commitHashes) {
      const firstSpaceIndex = commitHash.indexOf(" ");
      const hash = commitHash.slice(0, firstSpaceIndex);
      if (hash === "") {
        continue;
      }
      // Get the diff between the current file and its state at the commit
      const { stdout: previousFileContent } = await execAsync(
        `git show ${hash}:${filePath}`
      );
      const currentFileContent = fs.readFileSync(filePath, "utf-8");

      // Create a patch/diff of the before and after
      const patch = createPatch(
        filePath,
        previousFileContent,
        currentFileContent
      );

      if (patch.split("\n").length < 10) {
        console.log(`Skipping ${filePath} as the diff is too small`);
        continue;
      }

      console.log(filePath);
      console.log(patch);

      dataset.push({
        before: previousFileContent,
        after: currentFileContent,
        patch,
      });

      fs.writeFileSync(
        "./src/dataset/diffs/dataset.json",
        JSON.stringify(dataset, null, 2)
      );

      if (dataset.length > 200) {
        break;
      }
    }
  }

  console.log(`Dataset of ${dataset.length} examples generated`);
}

if (require.main === module) {
  generateDataset();
}
