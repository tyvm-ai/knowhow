import { ycmdServerManager } from "../serverManager";

export interface YcmdDiagnosticsParams {
  filepath: string;
  fileContents?: string;
  line?: number;
  column?: number;
}

export interface Diagnostic {
  kind: "ERROR" | "WARNING" | "INFO";
  text: string;
  location: {
    line: number;
    column: number;
  };
  location_extent?: {
    start: {
      line: number;
      column: number;
    };
    end: {
      line: number;
      column: number;
    };
  };
  ranges?: {
    start: {
      line: number;
      column: number;
    };
    end: {
      line: number;
      column: number;
    };
  }[];
  fixit_available?: boolean;
}

/**
 * Get error and warning diagnostics for files
 */
export async function ycmdDiagnostics(params: YcmdDiagnosticsParams): Promise<{
  success: boolean;
  diagnostics?: Diagnostic[];
  message: string;
}> {
  try {
    // Use the common server setup utility
    const setupResult = await ycmdServerManager.setupClientAndNotifyFile({
      filepath: params.filepath,
      fileContents: params.fileContents,
    });

    if (!setupResult.success) {
      return {
        success: false,
        message: setupResult.message,
      };
    }

    const { client, resolvedFilePath, contents, filetypes } = setupResult;

    // Get line and column numbers for notification
    const line_num = params.line || 1;
    const column_num = params.column || 1;

    // Get diagnostics
    const response = await client.getDiagnostics(
      resolvedFilePath,
      contents,
      filetypes,
      line_num,
      column_num
    );

    // Parse diagnostics
    const diagnostics: Diagnostic[] = response.map((diag: any) => ({
      kind: diag.kind,
      text: diag.text,
      location: {
        line: diag.location.line_num,
        column: diag.location.column_num,
      },
      location_extent: diag.location_extent
        ? {
            start: {
              line: diag.location_extent.start.line_num,
              column: diag.location_extent.start.column_num,
            },
            end: {
              line: diag.location_extent.end.line_num,
              column: diag.location_extent.end.column_num,
            },
          }
        : undefined,
      ranges: diag.ranges?.map((range: any) => ({
        start: {
          line: range.start.line_num,
          column: range.start.column_num,
        },
        end: {
          line: range.end.line_num,
          column: range.end.column_num,
        },
      })),
      fixit_available: diag.fixit_available,
    }));

    const errorCount = diagnostics.filter((d) => d.kind === "ERROR").length;
    const warningCount = diagnostics.filter((d) => d.kind === "WARNING").length;
    const infoCount = diagnostics.filter((d) => d.kind === "INFO").length;

    let message = "No diagnostics found";
    if (diagnostics.length > 0) {
      const parts: string[] = [];
      if (errorCount > 0)
        parts.push(`${errorCount} error${errorCount === 1 ? "" : "s"}`);
      if (warningCount > 0)
        parts.push(`${warningCount} warning${warningCount === 1 ? "" : "s"}`);
      if (infoCount > 0)
        parts.push(`${infoCount} info message${infoCount === 1 ? "" : "s"}`);
      message = `Found ${parts.join(", ")}`;
    }

    return {
      success: true,
      diagnostics,
      message,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to get diagnostics: ${(error as Error).message}`,
    };
  }
}
