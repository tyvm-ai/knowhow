import { YcmdClient, getFileTypes } from '../client';
import { YcmdServer } from '../server';
import * as fs from 'fs';

export interface YcmdGoToParams {
  filepath: string;
  line: number;
  column: number;
  contents?: string;
  command: 'definition' | 'declaration' | 'references';
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
        message: 'filepath is required'
      };
    }

    if (typeof params.line !== 'number' || typeof params.column !== 'number') {
      return {
        success: false,
        message: 'line and column must be numbers'
      };
    }

    if (!['definition', 'declaration', 'references'].includes(params.command)) {
      return {
        success: false,
        message: 'command must be one of: definition, declaration, references'
      };
    }

    // Get file contents
    let contents = params.contents;
    if (!contents) {
      try {
        contents = await fs.promises.readFile(params.filepath, 'utf8');
      } catch (error) {
        return {
          success: false,
          message: `Failed to read file: ${(error as Error).message}`
        };
      }
    }

    // Get file types
    const filetypes = getFileTypes(params.filepath);

    // Check if ycmd server is running
    const server = new YcmdServer();
    if (!server.isRunning()) {
      return {
        success: false,
        message: 'ycmd server is not running. Please start it first.'
      };
    }

    const serverInfo = server.getServerInfo();
    if (!serverInfo) {
      return {
        success: false,
        message: 'Failed to get server information'
      };
    }

    // Create client
    const client = new YcmdClient(serverInfo);

    // Notify server about file if needed
    try {
      await client.notifyFileEvent('FileReadyToParse', params.filepath, contents, filetypes);
    } catch (error) {
      console.warn('Failed to notify file event:', error);
    }

    // Execute the appropriate goto command
    let response: any;
    
    switch (params.command) {
      case 'definition':
        response = await client.goToDefinition(
          params.filepath,
          params.line,
          params.column,
          contents,
          filetypes
        );
        break;
        
      case 'declaration':
        response = await client.goToDeclaration(
          params.filepath,
          params.line,
          params.column,
          contents,
          filetypes
        );
        break;
        
      case 'references':
        response = await client.goToReferences(
          params.filepath,
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
      locations = response.map(loc => ({
        filepath: loc.filepath,
        line: loc.line_num,
        column: loc.column_num,
        description: loc.description
      }));
    } else if (response && response.filepath) {
      locations = [{
        filepath: response.filepath,
        line: response.line_num,
        column: response.column_num,
        description: response.description
      }];
    } else {
      locations = [];
    }

    const commandText = params.command === 'references' ? 'references' : params.command;
    
    if (locations.length === 0) {
      return {
        success: true,
        locations: [],
        message: `No ${commandText} found`
      };
    }

    return {
      success: true,
      locations,
      message: `Found ${locations.length} ${commandText}${locations.length === 1 ? '' : 's'}`
    };

  } catch (error) {
    return {
      success: false,
      message: `Failed to get ${params.command}: ${(error as Error).message}`
    };
  }
}