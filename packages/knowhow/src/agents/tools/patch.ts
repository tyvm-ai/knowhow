import * as fs from "fs";
import * as util from "util";
// Assuming 'diff' library provides applyPatch and createTwoFilesPatch (or similar for basic patch creation if needed later)
import { applyPatch, createTwoFilesPatch } from "diff";
import {
  writeFile,
  readFile,
  fileExists,
  mkdir,
  splitByNewLines,
} from "../../utils"; // Assuming these utils exist
import { lintFile } from "./lintFile"; // Assuming this exists

// --- Utility Functions (Keep or Simplify) ---

/**
 * Finds all 1-based line numbers where a line (trimmed) matches the search text.
 */
function findAllLineNumbers(fullText: string, searchText: string): number[] {
  const lines = splitByNewLines(fullText);
  const search =
    searchText.startsWith("+") || searchText.startsWith("-")
      ? searchText.slice(1).trim()
      : searchText.trim();

  if (!search) return []; // Don't match empty lines everywhere

  const lineNumbers: number[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === search) {
      lineNumbers.push(index + 1);
    }
  });
  return lineNumbers;
}

/**
 * Finds the number in a list closest to the goal number.
 */
function findClosestNumber(
  numbers: number[],
  goal: number
): number | undefined {
  if (!numbers || numbers.length === 0) {
    return undefined; // Return undefined if no numbers to choose from
  }
  return numbers.reduce((prev, curr) => {
    return Math.abs(curr - goal) < Math.abs(prev - goal) ? curr : prev;
  });
}

/**
 * Finds the starting index (0-based) of a sequence (needle) within a larger array (haystack),
 * using a while loop.
 * * @param haystack The array to search within.
 * @param needle The sequence of strings to find.
 * @returns The 0-based starting index of the first occurrence of the needle, or -1 if not found.
 */
function findSequenceIndex(haystack: string[], needle: string[]): number {
  // Basic edge cases
  if (!needle || needle.length === 0) {
    // console.warn("findSequenceIndex: Needle is empty."); // Or return 0 depending on desired behavior for empty needle
    return -1; // Cannot find an empty sequence according to original logic
  }
  if (!haystack || needle.length > haystack.length) {
    return -1; // Needle cannot exist if it's longer than haystack
  }

  let haystackIndex = 0; // Current position to start searching for needle[0] in haystack

  // Continue searching as long as there's enough space left in the haystack
  // for the needle to potentially fit.
  while (haystackIndex <= haystack.length - needle.length) {
    // Find the *next* occurrence of the *first* element of the needle
    // starting from the current haystackIndex.
    const potentialStartIndex = haystack.indexOf(needle[0], haystackIndex);

    // If the first element of the needle is not found anymore, the sequence cannot be found.
    if (potentialStartIndex === -1) {
      return -1;
    }

    // Optimization: If the found index doesn't leave enough room for the rest of the needle, stop.
    if (potentialStartIndex > haystack.length - needle.length) {
      return -1;
    }

    // Found the first element, now check if the rest of the sequence matches.
    let sequenceMatches = true;
    for (let needleIndex = 1; needleIndex < needle.length; needleIndex++) {
      // If any element in the sequence doesn't match, break the inner loop.
      if (haystack[potentialStartIndex + needleIndex] !== needle[needleIndex]) {
        sequenceMatches = false;
        break;
      }
    }

    // If the inner loop completed without breaking, the sequence matches.
    if (sequenceMatches) {
      return potentialStartIndex; // Return the index where the sequence starts.
    }

    // If the sequence didn't match starting at potentialStartIndex,
    // continue searching for needle[0] *after* the current potentialStartIndex.
    haystackIndex = potentialStartIndex + 1;
  }

  // If the while loop finishes without returning, the sequence was not found.
  return -1;
} // --- Hunk Parsing and Formatting (Keep as is) ---

export interface Hunk {
  header: string;
  originalStartLine: number; // Parsed from -s,l
  originalLineCount: number; // Parsed from -s,l
  newStartLine: number; // Parsed from +s,l
  newLineCount: number; // Parsed from +s,l
  lines: string[]; // All lines in the hunk body (context, -, +)
  // Derived properties for convenience
  additions: string[];
  subtractions: string[];
  contextLines: string[];
}

export function parseHunks(patch: string): Hunk[] {
  const patchLines = splitByNewLines(patch);
  const hunks: Hunk[] = [];
  let currentHunkLines: string[] = [];
  let currentHeader = "";
  let originalStart = 0,
    originalCount = 0,
    newStart = 0,
    newCount = 0;

  for (const line of patchLines) {
    if (line.startsWith("@@")) {
      // Finalize previous hunk
      if (currentHeader) {
        const additions = currentHunkLines.filter((l) => l.startsWith("+"));
        const subtractions = currentHunkLines.filter((l) => l.startsWith("-"));
        const contextLines = currentHunkLines.filter((l) => l.startsWith(" "));
        hunks.push({
          header: currentHeader,
          originalStartLine: originalStart,
          originalLineCount: originalCount,
          newStartLine: newStart,
          newLineCount: newCount,
          lines: currentHunkLines,
          additions,
          subtractions,
          contextLines,
        });
      }
      // Start new hunk
      currentHeader = line;
      currentHunkLines = [];
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        originalStart = parseInt(match[1], 10);
        originalCount = parseInt(match[2] || "1", 10); // Default length is 1 if omitted
        newStart = parseInt(match[3], 10);
        newCount = parseInt(match[4] || "1", 10); // Default length is 1 if omitted
      } else {
        // Malformed header, use defaults or throw error? Using defaults for robustness.
        originalStart = 0;
        originalCount = 0;
        newStart = 0;
        newCount = 0;
        console.warn("Could not parse hunk header:", line);
      }
    } else if (
      currentHeader &&
      (line.startsWith(" ") ||
        line.startsWith("+") ||
        line.startsWith("-") ||
        line === "\\ No newline at end of file")
    ) {
      currentHunkLines.push(line);
    }
    // Ignore lines before first header or lines not part of hunk content (like index, ---, +++)
  }

  // Finalize the last hunk
  if (currentHeader) {
    const additions = currentHunkLines.filter((l) => l.startsWith("+"));
    const subtractions = currentHunkLines.filter((l) => l.startsWith("-"));
    const contextLines = currentHunkLines.filter((l) => l.startsWith(" "));
    hunks.push({
      header: currentHeader,
      originalStartLine: originalStart,
      originalLineCount: originalCount,
      newStartLine: newStart,
      newLineCount: newCount,
      lines: currentHunkLines,
      additions,
      subtractions,
      contextLines,
    });
  }

  return hunks;
}

export function hunksToPatch(hunks: Hunk[]): string {
  const noNewLineMessage = "\\ No newline at end of file";
  return hunks
    .map((hunk) => {
      // Check if the last line might be the no-newline indicator and handle it
      let lines = [...hunk.lines];
      let endsWithNoNewline = false;
      if (lines[lines.length - 1]?.trim() === noNewLineMessage.trim()) {
        endsWithNoNewline = true;
        lines = lines.slice(0, -1); // Temporarily remove for join
      }

      let hunkContent = lines.join("\n");
      if (endsWithNoNewline) {
        hunkContent += "\n" + noNewLineMessage;
      }

      return [hunk.header, hunkContent].join("\n");
    })
    .join("\n");
}

/**
 * Checks if a hunk results in no effective change.
 */
export function hunkIsEmpty(hunk: Hunk): boolean {
  const noLines = hunk.lines.length === 0;
  const noChanges =
    hunk.additions.length === 0 && hunk.subtractions.length === 0;

  // Check if additions and subtractions exactly cancel each other out
  const additionsText = hunk.additions.map((l) => l.slice(1)).join("\n");
  const subtractionsText = hunk.subtractions.map((l) => l.slice(1)).join("\n");
  const noEffectiveChange = additionsText === subtractionsText;

  return noLines || noChanges || noEffectiveChange;
}

// --- Core Patch Fixing Logic (Rewrite) ---

const CONTEXT_LINES = 3; // Standard number of context lines

/**
 * Attempts to fix a single hunk by anchoring it to the original content
 * and regenerating context and header.
 */
function fixSingleHunk(hunk: Hunk, originalContent: string): Hunk | null {
  const originalLines = splitByNewLines(originalContent);

  const deletionLinesContent = hunk.subtractions.map((l) => l.slice(1));
  const additionLinesContent = hunk.additions.map((l) => l.slice(1));

  let actualOriginalStartLine = -1; // 1-based line number of the first deletion/change

  // 1. Try to anchor using the exact sequence of deleted lines
  if (deletionLinesContent.length > 0) {
    const deletionStartIndex = findSequenceIndex(
      originalLines,
      deletionLinesContent
    );
    if (deletionStartIndex !== -1) {
      actualOriginalStartLine = deletionStartIndex + 1; // Convert 0-based index to 1-based line number
      console.log(
        `Anchor found via deletion sequence at line ${actualOriginalStartLine}`
      );
    }
  }

  // 2. If deletions didn't anchor, try anchoring using context *before* the first change
  //    (This is more complex and heuristic, let's focus on deletion anchor first for simplicity)
  //    ... (Could add logic here using findAllLineNumbers/findClosestNumber for context lines near hunk.originalStartLine if needed as fallback) ...

  // 3. If only additions, try anchoring using context *before* the first addition.
  if (
    actualOriginalStartLine === -1 &&
    deletionLinesContent.length === 0 &&
    additionLinesContent.length > 0
  ) {
    // Find the context line just before the first addition in the *original* patch hunk
    let precedingContextLine = "";
    for (const line of hunk.lines) {
      if (line.startsWith("+")) break; // Stop when we hit the first addition
      if (line.startsWith(" ")) {
        precedingContextLine = line.slice(1); // Keep track of the last context line seen
      }
    }

    if (precedingContextLine) {
      const potentialLines = findAllLineNumbers(
        originalContent,
        precedingContextLine
      );
      const closestLine = findClosestNumber(
        potentialLines,
        hunk.originalStartLine
      ); // Use original header as hint
      if (closestLine !== undefined) {
        // The change happens *after* this context line
        actualOriginalStartLine = closestLine + 1;
        console.log(
          `Anchor found via preceding context '${precedingContextLine}' targeting line ${actualOriginalStartLine}`
        );
      }
    }
  }

  // If we couldn't find a reliable anchor, we can't fix this hunk.
  if (actualOriginalStartLine === -1) {
    console.warn("Could not determine anchor point for hunk:", hunk.header);
    // Try a last resort: Assume the original header's start line was roughly correct
    // Find *any* non-added line from the hunk in the original source near the expected start.
    let fallbackAnchorFound = false;
    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i];
      if (line.startsWith("+")) continue; // Skip additions

      const lineContent = line.slice(1);
      const potentialLines = findAllLineNumbers(originalContent, lineContent);
      if (potentialLines.length > 0) {
        const closestLine = findClosestNumber(
          potentialLines,
          hunk.originalStartLine + i
        ); // Estimate position
        if (closestLine !== undefined) {
          // Calculate the *start* based on this line's position in the hunk
          let offset = 0;
          for (let j = 0; j < i; j++) {
            if (!hunk.lines[j].startsWith("+")) {
              // Count original lines before this one
              offset++;
            }
          }
          actualOriginalStartLine = closestLine - offset;
          console.log(
            `Fallback anchor found via line '${lineContent}' near ${hunk.originalStartLine}, estimated start: ${actualOriginalStartLine}`
          );
          fallbackAnchorFound = true;
          break;
        }
      }
    }
    if (!fallbackAnchorFound) {
      console.error("Failed to find any anchor for hunk:", hunk.header);
      return null;
    }
  }

  // Ensure start line is at least 1
  actualOriginalStartLine = Math.max(1, actualOriginalStartLine);

  // 4. Reconstruct the hunk with correct context
  const contextBeforeStartLine = Math.max(
    0,
    actualOriginalStartLine - CONTEXT_LINES - 1
  ); // 0-based index
  const contextBeforeEndLine = Math.max(0, actualOriginalStartLine - 1); // 0-based index
  const contextBefore = originalLines
    .slice(contextBeforeStartLine, contextBeforeEndLine)
    .map((l) => ` ${l}`);

  // End line of original content affected by deletions (1-based)
  const originalContentEndLine =
    actualOriginalStartLine + deletionLinesContent.length;
  const contextAfterStartLine = originalContentEndLine - 1; // 0-based index
  const contextAfterEndLine = Math.min(
    originalLines.length,
    contextAfterStartLine + CONTEXT_LINES
  ); // 0-based index
  const contextAfter = originalLines
    .slice(contextAfterStartLine, contextAfterEndLine)
    .map((l) => ` ${l}`);

  const newHunkLines = [
    ...contextBefore,
    ...hunk.subtractions, // Use the original subtraction lines from the input hunk
    ...hunk.additions, // Use the original addition lines from the input hunk
    ...contextAfter,
  ];

  // 5. Recalculate the header
  const newOriginalStart =
    contextBefore.length > 0
      ? actualOriginalStartLine - contextBefore.length
      : actualOriginalStartLine;
  const newOriginalCount =
    contextBefore.length + hunk.subtractions.length + contextAfter.length;

  // The new start line depends on how many lines were added/removed *before* this hunk.
  // For an isolated hunk fix, we often just base it on the original start.
  // A more robust diff tool might recalculate this based on cumulative changes.
  // Let's keep it simple and relative to the original start for now.
  const newNewStart = newOriginalStart; // Simplification: Assume start line number matches original unless offset by prior hunks (which we don't know here)
  const newNewCount =
    contextBefore.length + hunk.additions.length + contextAfter.length;

  // Handle edge case where count is 0 (e.g., adding to an empty file) - header format needs >= 1
  const finalOriginalStart = Math.max(1, newOriginalStart);
  const finalOriginalCount = Math.max(1, newOriginalCount); // Should be at least 1 if start is specified, unless file was empty
  const finalNewStart = Math.max(1, newNewStart);
  const finalNewCount = Math.max(1, newNewCount); // Should be at least 1 if start is specified

  // Adjust count for empty file scenario
  const displayOriginalCount =
    originalLines.length === 0 && newOriginalCount === 0
      ? 0
      : finalOriginalCount;
  const displayNewCount =
    originalLines.length === 0 && newNewCount === 0 ? 0 : finalNewCount; // Handle adding to empty file

  const newHeader = `@@ -${finalOriginalStart},${displayOriginalCount} +${finalNewStart},${displayNewCount} @@`;

  const fixedHunk: Hunk = {
    header: newHeader,
    originalStartLine: finalOriginalStart,
    originalLineCount: displayOriginalCount,
    newStartLine: finalNewStart,
    newLineCount: displayNewCount,
    lines: newHunkLines,
    additions: hunk.additions, // Keep original intended changes
    subtractions: hunk.subtractions, // Keep original intended changes
    contextLines: [...contextBefore, ...contextAfter], // Store the newly generated context
  };

  // 6. Filter out empty hunks
  if (hunkIsEmpty(fixedHunk)) {
    console.log("Hunk became empty after fixing:", fixedHunk.header);
    return null;
  }

  return fixedHunk;
}

/**
 * Takes a potentially corrupted patch and attempts to fix its hunks
 * by aligning them with the original content.
 */
export function fixPatch(originalContent: string, patch: string): string {
  const originalHunks = parseHunks(patch);
  const fixedHunks: Hunk[] = [];

  console.log(`Attempting to fix ${originalHunks.length} hunks...`);

  for (const hunk of originalHunks) {
    console.log(`\nProcessing Hunk: ${hunk.header}`);
    try {
      const fixed = fixSingleHunk(hunk, originalContent);
      if (fixed) {
        console.log(`Successfully fixed. New header: ${fixed.header}`);
        fixedHunks.push(fixed);
      } else {
        console.warn(`Could not fix hunk, discarding: ${hunk.header}`);
      }
    } catch (error) {
      console.error(`Error fixing hunk ${hunk.header}:`, error);
      // Optionally decide whether to keep the original hunk or discard
    }
  }

  // Check if the result ends with a newline like the original content
  const needsNoNewlineSuffix =
    !originalContent.endsWith("\n") && fixedHunks.length > 0;
  let finalPatch = hunksToPatch(fixedHunks);

  // The hunkToPatch function might handle the \ No newline ... line based on content,
  // but we might need to ensure it's added if the *intended* final state doesn't have a newline.
  // This is tricky. Let's rely on applyPatch to handle it correctly if the content matches.
  // Re-apply the check: Does the *last* fixed hunk *imply* no newline?
  if (fixedHunks.length > 0) {
    const lastHunk = fixedHunks[fixedHunks.length - 1];
    const lastLine = lastHunk.lines[lastHunk.lines.length - 1];
    // If the original patch had the indicator, try to preserve it if relevant
    if (
      patch.includes("\\ No newline at end of file") &&
      !lastLine?.endsWith("\n") &&
      !finalPatch.endsWith("\\ No newline at end of file")
    ) {
      // This logic is imperfect. Let's assume for now hunkToPatch handles it ok.
    }
  }

  // Add trailing newline if the original patch had one and the fixed one doesn't
  if (
    patch.endsWith("\n") &&
    !finalPatch.endsWith("\n") &&
    finalPatch.length > 0
  ) {
    finalPatch += "\n";
  }

  return finalPatch;
}

// --- Existing Application/Utility Code (Keep as is, ensure imports/exports are correct) ---

export async function savePatchError(
  originalPatch: string,
  fixedPatch: string | null, // Can be null if fixing failed
  fileContent: string,
  errorMsg: string // Add error message for context
) {
  const dirName = ".knowhow/tools/patchFile"; // Use path.join ideally
  const fileName = "errors.json";
  const filePath = `${dirName}/${fileName}`; // Use path.join ideally
  try {
    if (!(await fileExists(filePath))) {
      await mkdir(dirName, { recursive: true });
      await writeFile(filePath, "[]");
    }
    let errors = [];
    try {
      errors = JSON.parse(await readFile(filePath, "utf8"));
      if (!Array.isArray(errors)) errors = []; // Ensure it's an array
    } catch (readError) {
      console.error(
        "Error reading patch error log, starting fresh.",
        readError
      );
      errors = [];
    }
    errors.push({
      timestamp: new Date().toISOString(),
      error: errorMsg,
      originalPatch,
      fixedPatch, // May be null or the attempted fix
      fileContent,
    });
    // Limit log size maybe?
    // errors = errors.slice(-50);
    await writeFile(filePath, JSON.stringify(errors, null, 2));
  } catch (logError) {
    console.error("Failed to save patch error information:", logError);
  }
}

// Tool to apply a patch file to a file
export async function patchFile(
  filePath: string,
  patch: string
): Promise<string> {
  let originalContent = "";
  try {
    if (!fs.existsSync(filePath)) {
      // If file doesn't exist, the patch should ideally be creating it.
      // The patch should start with --- /dev/null
      console.log(
        `File ${filePath} does not exist. Attempting to apply patch as creation.`
      );
      originalContent = "";
      // Ensure fs operations use async/await if utils are async
      // fs.writeFileSync(filePath, ""); // Don't create it yet, let applyPatch handle it from /dev/null
    } else {
      originalContent = await readFile(filePath, "utf8"); // Use async read
    }

    let updatedContent = applyPatch(originalContent, patch);
    let appliedPatch = patch; // Keep track of which patch succeeded

    // If the patch doesn't apply, try to fix it
    if (updatedContent === false) {
      // diff library often returns false on failure
      console.warn("Initial patch apply failed. Attempting to fix patch...");
      let fixedPatch: string | null = null; // Initialize as null
      try {
        fixedPatch = fixPatch(originalContent, patch);
        console.log("--- Attempted Fixed Patch ---");
        console.log(fixedPatch || "<Fixing resulted in empty patch>");
        console.log("---------------------------");
      } catch (fixError: any) {
        console.error("Error during fixPatch execution:", fixError);
        await savePatchError(
          patch,
          null,
          originalContent,
          `fixPatch function errored: ${fixError.message}`
        );
        return `An error occured while trying to fix the patch: ${fixError.message}`;
      }

      if (!fixedPatch || fixedPatch.trim() === "") {
        // If fixing resulted in an empty patch, it means no valid changes could be salvaged.
        console.error(
          "Patch could not be fixed or resulted in an empty patch."
        );
        await savePatchError(
          patch,
          fixedPatch,
          originalContent,
          "Patch fix resulted in empty or null patch."
        );
        // It might be valid that the patch had no real changes, but applyPatch failed anyway?
        // Let's return an error indicating failure.
        return `Patch failed to apply and could not be fixed or resulted in no changes. Make sure you are making small patches`;
      }

      updatedContent = applyPatch(originalContent, fixedPatch);
      appliedPatch = fixedPatch; // Use the fixed patch now

      // Sometimes patches need a trailing newline
      if (updatedContent === false && !fixedPatch.endsWith("\n")) {
        console.log(
          "Applying fixed patch failed, trying with added newline..."
        );
        fixedPatch += "\n";
        updatedContent = applyPatch(originalContent, fixedPatch);
        appliedPatch = fixedPatch;
      }

      if (updatedContent === false) {
        console.error("Applying the *fixed* patch also failed.");
        await savePatchError(
          patch,
          fixedPatch,
          originalContent,
          "Fixed patch also failed to apply."
        );
        // Try to provide more specific feedback from applyPatch if possible (library might not offer it)
        return "Patch failed to apply even after attempting to fix it. Make sure you are making small patches.";
      } else {
        console.log("Successfully applied the *fixed* patch.");
      }
    } else {
      console.log("Successfully applied the original patch.");
    }

    // Write the updated content
    await writeFile(filePath, updatedContent as string); // Type assertion needed as applyPatch might return boolean

    // Optional: Lint the result
    let lintResult = "";
    try {
      lintResult = await lintFile(filePath);
    } catch (lintError: any) {
      console.warn("Linting failed after patching:", lintError);
      lintResult = `Linting after patch failed: ${lintError.message}`;
    }

    return `Patch applied successfully.${
      filePath ? ` Use readFile on ${filePath} to verify changes.` : ""
    }
${lintResult ? "\nLinting Result:\n" + lintResult : ""}`.trim();
  } catch (e: any) {
    console.error(`Error in patchFile function for ${filePath}:`, e);
    // Save error only if it's not a controlled failure path that already saved
    if (!String(e.message).includes("Patch failed to apply")) {
      // Avoid double logging known failures
      await savePatchError(
        patch,
        null,
        originalContent,
        `Unexpected error in patchFile: ${e.message}`
      );
    }
    return `An error occured while applying the patch: ${e.message}`;
  }
}

export function categorizeHunks(originalContent: string, patch: string) {
  const hunks = parseHunks(patch);

  const validHunks = hunks.filter((hunk) =>
    applyPatch(originalContent, hunksToPatch([hunk]))
  );

  const invalidHunks = hunks.filter(
    (hunk) => !applyPatch(originalContent, hunksToPatch([hunk]))
  );

  return { validHunks, invalidHunks };
}
