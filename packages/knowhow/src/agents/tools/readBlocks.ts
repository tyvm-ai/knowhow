import * as fs from "fs";
import { services, ToolsService } from "../../services";
import { FileBlock } from "./types/fileblock";

const BLOCK_SIZE = 500;
export async function readBlocks(
  filePath: string,
  blockNumbers: number[] = []
) {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const context = toolService.getContext();

  // Emit pre-read blocking event
  if (context.Events) {
    try {
      await context.Events.emitBlocking('file:pre-read', {
        filePath,
        blockNumbers
      });
    } catch (error) {
      throw new Error(`File read blocked by pre-read event handler: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const text = fs.readFileSync(filePath, "utf8");

  const lines = text.split("");
  const blocks = [] as FileBlock[];

  let index = 0;
  let lineCount = 0;
  while (lines.length > 0) {
    const block = lines.splice(0, BLOCK_SIZE).join("");
    blocks.push({
      blockNumber: index,
      content: block,
      startLine: lineCount + 1,
    });
    index++;
    lineCount += block.split("\n").length;

    if (blocks.length > 20 && lines.length > 160000) {
      blocks.push({
        blockNumber: index,
        content: "File trimmed. Too large to display",
        startLine: lineCount + 1,
      });
      break;
    }
  }

  if (blockNumbers.length === 0) {
    // Emit post-read non-blocking event
    if (context.Events) {
      try {
        await context.Events.emitNonBlocking('file:post-read', {
          filePath,
          blockNumbers,
          content: blocks.map(block => block.content).join('')
        });
      } catch (error) {
        // Non-blocking events log errors but continue
        console.warn(`Post-read event handler error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    return blocks;
  }

  const filtered = blocks.filter((block) =>
    blockNumbers.includes(block.blockNumber)
  );

  if (filtered.length === 0) {
    return blocks;
  }

  // Emit post-read non-blocking event
  if (context.Events) {
    try {
      await context.Events.emitNonBlocking('file:post-read', {
        filePath,
        blockNumbers,
        content: filtered.map(block => block.content).join('')
      });
    } catch (error) {
      // Non-blocking events log errors but continue
      console.warn(`Post-read event handler error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return filtered;
}
