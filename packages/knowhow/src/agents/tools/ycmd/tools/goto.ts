import { YcmdClient, getFileTypes } from '../client';
import { ycmdServerManager } from '../serverManager';
import { ycmdStart } from './start';
import { resolveFilePath } from '../utils/pathUtils';
import * as fs from 'fs';

export interface YcmdGoToParams {
  filepath: string;
  line: number;
  column: number;
  contents?: string;
  command: 'GoTo' | 'GoToDeclaration' | 'GoToReferences';
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
    // Resolve file path
    const resolvedFilePath = resolveFilePath(params.filepath);
    
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

    if (!['GoTo', 'GoToDeclaration', 'GoToReferences'].includes(params.command)) {
      return {
        success: false,
        message: 'command must be one of: GoTo, GoToDeclaration, GoToReferences'
      };
    }

    // Get file contents
    let contents = params.contents;
    if (!contents) {
      try {
        contents = await fs.promises.readFile(resolvedFilePath, 'utf8');
      } catch (error) {
        return {
          success: false,
          message: `Failed to read file: ${(error as Error).message}`
        };
      }
    }

    // Get file types
    const filetypes = getFileTypes(resolvedFilePath);

    // Check if ycmd server is running, start if not
    if (!(await ycmdServerManager.isRunning())) {
      console.log('ycmd server not running, starting automatically...');
      const startResult = await ycmdStart({});
      if (!startResult.success) {
        return {
          success: false,
          message: `Failed to auto-start ycmd server: ${startResult.message}`
        };
      }
      console.log('ycmd server started successfully');
    }

    const serverInfo = ycmdServerManager.getServerInfo();
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
      await client.notifyFileEvent('FileReadyToParse', resolvedFilePath, contents, filetypes);
    } catch (error) {
      console.warn('Failed to notify file event:', error);
    }

    // Execute the appropriate goto command
    let response: any;
    
    switch (params.command) {
      case 'GoTo':
        response = await client.goToDefinition(
          resolvedFilePath,
          params.line,
          params.column,
          contents,
          filetypes
        );
        break;
        
      case 'GoToDeclaration':
        response = await client.goToDeclaration(
          resolvedFilePath,
          params.line,
          params.column,
          contents,
          filetypes
        );
        break;
        
      case 'GoToReferences':
        response = await client.goToReferences(
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

    const commandText = params.command === 'GoToReferences' ? 'references' : (params.command === 'GoTo' ? 'definition' : 'declaration');
    
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