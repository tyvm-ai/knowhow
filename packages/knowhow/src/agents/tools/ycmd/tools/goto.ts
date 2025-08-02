import { YcmdClient, getFileTypes } from "../client";
import { ycmdServerManager } from "../serverManager";
import { ycmdStart } from "./start";
import { resolveFilePath } from "../utils/pathUtils";
import { resolveStringToLocation } from "./getLocations";
import * as fs from "fs";

export interface YcmdGoToParams {
  filepath: string;
  line?: number;
  column?: number;
  searchString?: string;
  matchType?: "exact" | "prefix" | "contains";
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
      column = location.column;
    }

    // Validate that we have line and column
    if (!line || !column) {
      return {
        success: false,
        message: "Either line/column or searchString must be provided",
      };
    }

    // Validate parameters
    if (!params.filepath) {
      return {
        success: false,
        message: "filepath is required",
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
          line,
          column,
          contents,
          filetypes
        );
        break;

      case "GoToReferences":
        response = await client.goToReferences(
          resolvedFilePath,
          line,
          column,
          contents,
          filetypes
        );
        break;

      case "GoToDefinition":
      case "GoTo":
      default:
        response = await client.goToDefinition(
          resolvedFilePath,
          line,
          column,
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