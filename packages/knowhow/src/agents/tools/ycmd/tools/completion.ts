import { YcmdClient, getFileTypes } from '../client';
import { ycmdServerManager } from '../serverManager';
import { ycmdStart } from './start';
import * as fs from 'fs';
import { resolveFilePath } from '../utils/pathUtils';

export interface YcmdCompletionParams {
  filepath: string;
  line: number;
  column: number;
  contents?: string;
  forceSemantic?: boolean;
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
    // Validate parameters
    if (!params.filepath || params.filepath.trim() === '') {
      return {
        success: false,
        message: 'filepath is required'
      };
    }

    // Resolve filepath to absolute path
    const absoluteFilepath = resolveFilePath(params.filepath);
    
    if (!absoluteFilepath) {
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

    // Get file contents
    let contents = params.contents;
    if (!contents) {
      try {
        contents = await fs.promises.readFile(absoluteFilepath, 'utf8');
      } catch (error) {
        return {
          success: false,
          message: `Failed to read file: ${(error as Error).message}`
        };
      }
    }

    // Get file types
    const filetypes = getFileTypes(absoluteFilepath);

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

    // Create client and get completions
    const client = new YcmdClient(serverInfo);

    // Notify server about file if needed
    try {
      await client.notifyFileEvent('FileReadyToParse', absoluteFilepath, contents, filetypes);
    } catch (error) {
      console.warn('Failed to notify file event:', error);
    }

    // Get completions
    const response = await client.getCompletions({
      filepath: absoluteFilepath,
      line_num: params.line,
      column_num: params.column,
      file_data: {
        [absoluteFilepath]: {
          contents,
          filetypes
        }
      },
      force_semantic: params.forceSemantic
    });

    // Transform completions to standard format
    const completions: CompletionItem[] = response.completions.map(comp => ({
      text: comp.insertion_text,
      displayText: comp.menu_text,
      detail: comp.extra_menu_info,
      documentation: comp.detailed_info,
      kind: comp.kind
    }));

    return {
      success: true,
      completions,
      completionStartColumn: response.completion_start_column,
      message: `Found ${completions.length} completions`
    };

  } catch (error) {
    return {
      success: false,
      message: `Failed to get completions: ${(error as Error).message}`
    };
  }
}