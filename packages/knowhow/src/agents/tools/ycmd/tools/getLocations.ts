import { ycmdServerManager } from "../serverManager";
import * as fs from "fs";

export interface GetLocationsParams {
  filepath: string;
  searchString: string;
  fileContents?: string;
  matchType?: "exact" | "prefix" | "contains";
  maxResults?: number;
}

export interface StringLocation {
  line: number;
  column: number;
  context: string;
  matchIndex: number;
}

/**
 * Find line and column positions for a given string in a file
 */
export async function getLocations(params: GetLocationsParams): Promise<{
  success: boolean;
  locations?: StringLocation[];
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

    if (!params.searchString) {
      return {
        success: false,
        message: "searchString is required",
      };
    }

    // Read file contents if not provided
    let contents = params.fileContents;
    if (!contents) {
      try {
        contents = await fs.promises.readFile(params.filepath, "utf8");
      } catch (error) {
        return {
          success: false,
          message: `Failed to read file: ${(error as Error).message}`,
        };
      }
    }

    const matchType = params.matchType || "exact";
    const maxResults = params.maxResults || 50;
    const locations: StringLocation[] = [];

    // Split content into lines for line number calculation
    const lines = contents.split('\n');
    
    // Search through each line
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const lineNumber = lineIndex + 1; // 1-based line numbers
      
      let searchIndex = 0;
      while (searchIndex < line.length) {
        let matchIndex = -1;
        
        // Apply different matching strategies
        switch (matchType) {
          case "exact":
            matchIndex = line.indexOf(params.searchString, searchIndex);
            break;
          case "prefix":
            // Find next occurrence where searchString is a prefix
            for (let i = searchIndex; i <= line.length - params.searchString.length; i++) {
              if (line.substring(i, i + params.searchString.length) === params.searchString) {
                // Check if it's at word boundary or start
                if (i === 0 || /\W/.test(line[i - 1])) {
                  matchIndex = i;
                  break;
                }
              }
            }
            break;
          case "contains":
            matchIndex = line.toLowerCase().indexOf(params.searchString.toLowerCase(), searchIndex);
            break;
        }

        if (matchIndex === -1) {
          break; // No more matches in this line
        }

        // Calculate context (show part of the line around the match)
        const contextStart = Math.max(0, matchIndex - 20);
        const contextEnd = Math.min(line.length, matchIndex + params.searchString.length + 20);
        const context = line.substring(contextStart, contextEnd);

        locations.push({
          line: lineNumber,
          column: matchIndex + 1, // 1-based column numbers
          context: context.trim(),
          matchIndex: locations.length
        });

        // Stop if we've reached max results
        if (locations.length >= maxResults) {
          break;
        }

        // Continue searching from after this match
        searchIndex = matchIndex + 1;
      }

      // Stop if we've reached max results
      if (locations.length >= maxResults) {
        break;
      }
    }

    if (locations.length === 0) {
      return {
        success: true,
        locations: [],
        message: `No matches found for "${params.searchString}" in ${params.filepath}`,
      };
    }

    return {
      success: true,
      locations,
      message: `Found ${locations.length} location${locations.length === 1 ? '' : 's'} for "${params.searchString}"`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to get locations: ${(error as Error).message}`,
    };
  }
}

/**
 * Helper function to resolve string to line/column position
 * Returns the first match or null if not found
 */
export async function resolveStringToLocation(
  filepath: string,
  searchString: string,
  fileContents?: string,
  matchType: "exact" | "prefix" | "contains" = "exact"
): Promise<{ line: number; column: number } | null> {
  const result = await getLocations({
    filepath,
    searchString,
    fileContents,
    matchType,
    maxResults: 1
  });

  if (result.success && result.locations && result.locations.length > 0) {
    const location = result.locations[0];
    return {
      line: location.line,
      column: location.column
    };
  }

  return null;
}