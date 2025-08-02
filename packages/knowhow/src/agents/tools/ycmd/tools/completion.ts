import { ycmdServerManager } from "../serverManager";
import { resolveStringToLocation } from "./getLocations";

export interface YcmdCompletionParams {
  filepath: string;
  line?: number;
  column?: number;
  searchString?: string;
  contents?: string;
  forceSemantic?: boolean;
  matchType?: "exact" | "prefix" | "contains";
}

export interface CompletionItem {
  text: string;
  displayText?: string;
  detail?: string;
  documentation?: string;
  kind?: string;
}

/**
 * Get code completions at cursor position
 */
export async function ycmdCompletion(params: YcmdCompletionParams): Promise<{
  success: boolean;
  completions?: CompletionItem[];
  completionStartColumn?: number;
  message: string;
}> {
  try {
    let line = params.line;
    let column = params.column;

    // If searchString is provided instead of line/column, resolve it
    if (params.searchString && (!line || !column)) {
      const location = await resolveStringToLocation(
        params.filepath,
        params.searchString,
        params.contents,
        params.matchType || "exact"
      );
      
      if (!location) {
        return {
          success: false,
          message: `Could not find "${params.searchString}" in file ${params.filepath}`,
        };
      }
      
      line = location.line;
      column = location.column + params.searchString.length; // Position after the string for completions
    }

    // Validate that we have line and column
    if (!line || !column) {
      return {
        success: false,
        message: "Either line/column or searchString must be provided",
      };
    }

    // Use the common server setup utility
    const setupResult = await ycmdServerManager.setupClientAndNotifyFile({
      filepath: params.filepath,
      fileContents: params.contents,
    });

    if (!setupResult.success) {
      return {
        success: false,
        message: setupResult.message,
      };
    }

    const { client, resolvedFilePath, contents, filetypes } = setupResult;

    // Get completions
    const response = await client.getCompletions({
      filepath: resolvedFilePath,
      line_num: line,
      column_num: column,
      file_data: {
        [resolvedFilePath]: {
          contents,
          filetypes,
        },
      },
      force_semantic: params.forceSemantic,
    });

    // Transform completions to standard format
    const completions: CompletionItem[] = response.completions.map((comp) => ({
      text: comp.insertion_text,
      displayText: comp.menu_text,
      detail: comp.extra_menu_info,
      documentation: comp.detailed_info,
      kind: comp.kind,
    }));

    return {
      success: true,
      completions,
      completionStartColumn: response.completion_start_column,
      message: `Found ${completions.length} completions`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to get completions: ${(error as Error).message}`,
    };
  }
}