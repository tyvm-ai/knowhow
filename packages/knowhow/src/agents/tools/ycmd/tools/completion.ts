import { ycmdServerManager } from "../serverManager";

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
      line_num: params.line,
      column_num: params.column,
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
