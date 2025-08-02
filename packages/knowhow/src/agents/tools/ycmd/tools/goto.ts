import { YcmdClient, getFileTypes } from "../client";
import { ycmdServerManager } from "../serverManager";
import { ycmdStart } from "./start";
import { resolveFilePath } from "../utils/pathUtils";
import * as fs from "fs";

export interface YcmdGoToParams {
  filepath: string;
  line: number;
  column: number;
  contents?: string;
  command: "GoTo" | "GoToDeclaration" | "GoToReferences" | "GoToDefinition";
}

export interface GoToLocation {
  filepath: string;
  line: number;
  column: number;
  description?: string;
}

/**
 * Navigate to definitions, declarations, or references
 */
export async function ycmdGoTo(params: YcmdGoToParams): Promise<{
  success: boolean;
  locations?: GoToLocation[];
  message: string;
}> {
  try {
    // Validate parameters
    if (!params.filepath) {
      return {
        success: false,
        message: "filepath is required",
      };
    }

    if (typeof params.line !== "number" || typeof params.column !== "number") {
      return {
        success: false,
        message: "line and column must be numbers",
      };
    }

    // Setup client and notify file using utility method
    const setupResult = await ycmdServerManager.setupClientAndNotifyFile({
      filepath: params.filepath,
      fileContents: params.contents
    });
    
    if (!setupResult.success) {
      return {
        success: false,
        message: setupResult.message
      };
    }

    const { client, resolvedFilePath, contents, filetypes } = setupResult;

    // Execute the appropriate goto command
    let response: any;

    switch (params.command) {
      case "GoToDeclaration":
        response = await client.goToDeclaration(
          resolvedFilePath,
          params.line,
          params.column,
          contents,
          filetypes
        );
        break;

      case "GoToReferences":
        response = await client.goToReferences(
          resolvedFilePath,
          params.line,
          params.column,
          contents,
          filetypes
        );
        break;

      case "GoToDefinition":
      case "GoTo":
      default:
        response = await client.goToDefinition(
          resolvedFilePath,
          params.line,
          params.column,
          contents,
          filetypes
        );
        break;
    }

    // Handle response format (can be single location or array)
    let locations: GoToLocation[];

    if (Array.isArray(response)) {
      locations = response.map((loc) => ({
        filepath: loc.filepath,
        line: loc.line_num,
        column: loc.column_num,
        description: loc.description,
      }));
    } else if (response && response.filepath) {
      locations = [
        {
          filepath: response.filepath,
          line: response.line_num,
          column: response.column_num,
          description: response.description,
        },
      ];
    } else {
      locations = [];
    }

    if (locations.length === 0) {
      return {
        success: true,
        locations: [],
        message: `No locations found for ${params.command}`,
      };
    }

    return {
      success: true,
      locations,
      message: `Found ${locations.length} locations for ${params.command}${
        locations.length === 1 ? "" : "s"
      }`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to get ${params.command}: ${(error as Error).message}`,
    };
  }
}