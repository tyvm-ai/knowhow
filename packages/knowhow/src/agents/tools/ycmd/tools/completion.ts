import { YcmdClient, getFileTypes } from '../client';
import { ycmdServerManager } from '../serverManager';
import * as fs from 'fs';

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

    // Check if ycmd server is running using the global manager
    if (!ycmdServerManager.isRunning()) {
      return {
        success: false,
        message: 'ycmd server is not running. Please start it first.'
      };
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
      await client.notifyFileEvent('FileReadyToParse', params.filepath, contents, filetypes);
    } catch (error) {
      console.warn('Failed to notify file event:', error);
    }

    // Get completions
    const response = await client.getCompletions({
      filepath: params.filepath,
      line_num: params.line,
      column_num: params.column,
      file_data: {
        [params.filepath]: {
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