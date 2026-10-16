import { getConfiguredEmbeddings } from "../../embeddings";
import { execAsync } from "./execCommand";

// Max number of matching lines (with full text) we show per file before we
// summarize the rest as a list of line numbers.
const PER_FILE_LINE_LIMIT = 5;

interface FileMatches {
  file: string;
  // [lineNumber, lineText]
  lines: Array<[number, string]>;
}

/**
 * Parse `ag --group --numbers` style output into per-file match groups.
 * With --group, ag prints the file path on its own line, followed by
 * `<lineNumber>:<text>` lines, then a blank line between files.
 */
function parseAgGroupedOutput(stdout: string): FileMatches[] {
  const results: FileMatches[] = [];
  let current: FileMatches | null = null;

  for (const rawLine of stdout.split("\n")) {
    if (rawLine === "") {
      // Blank line separates file groups
      current = null;
      continue;
    }

    const numberMatch = rawLine.match(/^(\d+):([\s\S]*)$/);
    if (numberMatch && current) {
      current.lines.push([Number(numberMatch[1]), numberMatch[2]]);
    } else {
      // Treat as a file header line
      current = { file: rawLine, lines: [] };
      results.push(current);
    }
  }

  return results;
}

/**
 * Format the parsed matches into a helpful, readable report. Instead of ag's
 * "Too many matches ... Skipping" error, we report the total match count, the
 * line numbers, and cap the displayed lines at PER_FILE_LINE_LIMIT.
 */
function formatMatches(files: FileMatches[]): string {
  if (files.length === 0) return "No matches found.";

  const sections: string[] = [];

  for (const { file, lines } of files) {
    const total = lines.length;
    const shown = lines.slice(0, PER_FILE_LINE_LIMIT);

    const header = `${file} (${total} match${total === 1 ? "" : "es"})`;
    const body = shown
      .map(([num, text]) => `${num}:${text}`)
      .join("\n");

    let section = `${header}\n${body}`;

    if (total > PER_FILE_LINE_LIMIT) {
      const remaining = lines.slice(PER_FILE_LINE_LIMIT);
      const remainingLineNumbers = remaining.map(([num]) => num);
      section +=
        `\n... ${remaining.length} more match${
          remaining.length === 1 ? "" : "es"
        } (showing first ${PER_FILE_LINE_LIMIT} lines). ` +
        `Remaining matches on lines: [${remainingLineNumbers.join(", ")}]`;
    }

    sections.push(section);
  }

  return sections.join("\n\n");
}

export async function textSearch(searchTerm) {
  try {
    // Escape the search term for safe shell usage
    // 1) Normalize whitespace (turn newlines/tabs into spaces)
    const normalized = String(searchTerm)
      .replace(/\r\n?/g, "\n") // normalize CRLF/CR → LF
      .replace(/\n/g, " ") // kill newlines
      .replace(/\t/g, " ") // kill tabs
      .replace(/\s+/g, " ") // collapse
      .trim();

    // 2) Escape single quotes for safe single-quoted shell arg
    const escapedTerm = normalized.replace(/'/g, "'\\''");

    // Use --group + --numbers so we can parse per-file matches ourselves and
    // produce a richer summary (counts + line numbers) instead of ag's
    // unhelpful "Too many matches" error. We intentionally do NOT pass -m here.
    const command = `ag --group --numbers -Q '${escapedTerm}'`;
    const { stdout, stderr } = await execAsync(command);

    const files = parseAgGroupedOutput(stdout || "");
    const formatted = formatMatches(files);

    // Preserve any non-"too many matches" stderr (real warnings/errors), but
    // drop ag's per-file "Too many matches ... Skipping" noise since we now
    // handle match limits ourselves.
    const filteredStderr = (stderr || "")
      .split("\n")
      .filter((line) => !/Too many matches/i.test(line))
      .join("\n")
      .trim();

    return {
      stdout: formatted,
      stderr: filteredStderr,
    };
  } catch (err) {
    console.log(
      "Falling back to embeddings text search since ag was not available"
    );
    const searchTermLower = searchTerm.toLowerCase();
    const embeddings = await getConfiguredEmbeddings();
    const results = embeddings.filter((embedding) =>
      embedding.text.toLowerCase().includes(searchTermLower)
    );
    results.forEach((r) => delete r.vector);
    return results;
  }
}
