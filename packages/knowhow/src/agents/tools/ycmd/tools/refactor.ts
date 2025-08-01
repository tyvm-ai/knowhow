import { YcmdClient, getFileTypes } from '../client';
import { ycmdServerManager } from '../serverManager';
import { resolveFilePath } from '../utils/pathUtils';
import * as fs from 'fs';

export interface YcmdRefactorParams {
  filepath: string;
  line: number;
  column: number;
  contents?: string;
  command: 'rename' | 'extract_method' | 'organize_imports' | 'fix_it';
  newName?: string; // For rename operations
  fixitIndex?: number; // For fix_it operations - which fix to apply
}

export interface RefactorEdit {
  filepath: string;
  range: {
    start: {
      line: number;
      column: number;
    };
    end: {
      line: number;
      column: number;
    };
  };
  newText: string;
}

export interface RefactorResult {
  edits: RefactorEdit[];
  description?: string;
}

/**
 * Execute refactoring operations
 */
export async function ycmdRefactor(params: YcmdRefactorParams): Promise<{
  success: boolean;
  result?: RefactorResult;
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

    if (!['rename', 'extract_method', 'organize_imports', 'fix_it'].includes(params.command)) {
      return {
        success: false,
        message: 'command must be one of: rename, extract_method, organize_imports, fix_it'
      };
    }

    if (params.command === 'rename' && !params.newName) {
      return {
        success: false,
        message: 'newName is required for rename operations'
      };
    }

    if (params.command === 'fix_it' && typeof params.fixitIndex !== 'number') {
      return {
        success: false,
        message: 'fixitIndex is required for fix_it operations'
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

    // Check if ycmd server is running using server manager
    if (!(await ycmdServerManager.isRunning())) {
      console.log('ycmd server not running, attempting to start...');
      try {
        await ycmdServerManager.start();
        console.log('ycmd server started successfully for refactor operation');
      } catch (error) {
        return {
          success: false,
          message: `Failed to start ycmd server: ${(error as Error).message}`
        };
      }
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

    // Notify server about file
    try {
      await client.notifyFileEvent('FileReadyToParse', resolvedFilePath, contents, filetypes);
    } catch (error) {
      console.warn('Failed to notify file event:', error);
    }

    let response: any;

    // Execute the appropriate refactor command
    switch (params.command) {
      case 'rename':
        response = await client.refactorRename(
          resolvedFilePath,
          params.line,
          params.column,
          contents,
          filetypes,
          params.newName!
        );
        break;

      case 'extract_method':
        response = await client.refactorExtractMethod(
          resolvedFilePath,
          params.line,
          params.column,
          contents,
          filetypes
        );
        break;

      case 'organize_imports':
        response = await client.refactorOrganizeImports(
          resolvedFilePath,
          params.line,
          params.column,
          contents,
          filetypes
        );
        break;

      case 'fix_it':
        response = await client.refactorFixIt(
          resolvedFilePath,
          params.line,
          params.column,
          contents,
          filetypes,
          params.fixitIndex!
        );
        break;
    }

    // Parse response into standard format
    let result: RefactorResult;

    if (response && response.fixits && response.fixits.length > 0) {
      // Handle fixit response format
      const fixit = response.fixits[0];
      result = {
        edits: fixit.chunks.map((chunk: any) => ({
          filepath: resolvedFilePath,
          range: {
            start: {
              line: chunk.range.start.line_num,
              column: chunk.range.start.column_num
            },
            end: {
              line: chunk.range.end.line_num,
              column: chunk.range.end.column_num
            }
          },
          newText: chunk.replacement_text
        })),
        description: fixit.text
      };
    } else if (response && response.chunks) {
      // Handle direct chunks response format
      result = {
        edits: response.chunks.map((chunk: any) => ({
          filepath: resolvedFilePath,
          range: {
            start: {
              line: chunk.range.start.line_num,
              column: chunk.range.start.column_num
            },
            end: {
              line: chunk.range.end.line_num,
              column: chunk.range.end.column_num
            }
          },
          newText: chunk.replacement_text
        })),
        description: response.description
      };
    } else {
      return {
        success: false,
        message: `No refactoring available for ${params.command} at this location`
      };
    }

    return {
      success: true,
      result,
      message: `Successfully generated ${params.command} refactoring with ${result.edits.length} edit${result.edits.length === 1 ? '' : 's'}`
    };

  } catch (error) {
    return {
      success: false,
      message: `Failed to execute ${params.command}: ${(error as Error).message}`
    };
  }
}