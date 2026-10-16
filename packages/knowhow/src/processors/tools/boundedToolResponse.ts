export const DEFAULT_TOOL_RESPONSE_CHARACTERS = 20_000;
export const MAX_TOOL_RESPONSE_CHARACTERS = 50_000;

export function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  return Math.min(
    max,
    Math.max(min, Number.isFinite(value) ? Math.floor(value as number) : fallback)
  );
}

/** Return a bounded character page with instructions for retrieving the next page. */
export function paginateToolResponse(
  value: string,
  options?: { characterOffset?: number; maxCharacters?: number },
  label = "response"
): string {
  const characterOffset = boundedInteger(
    options?.characterOffset,
    0,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const maxCharacters = boundedInteger(
    options?.maxCharacters,
    DEFAULT_TOOL_RESPONSE_CHARACTERS,
    1_000,
    MAX_TOOL_RESPONSE_CHARACTERS
  );
  const footerReserve = 300;
  const contentLimit = Math.max(1, maxCharacters - footerReserve);
  const page = value.slice(characterOffset, characterOffset + contentLimit);
  const end = characterOffset + page.length;
  if (characterOffset === 0 && end >= value.length) {
    return page;
  }

  const safeLabel = label.slice(0, 200);
  const footer =
    end < value.length
      ? `\n\n[${safeLabel} characters ${characterOffset}-${Math.max(characterOffset, end - 1)} of ${value.length}. Repeat with characterOffset=${end} to continue; maxCharacters=${maxCharacters}.]`
      : `\n\n[End of ${safeLabel}; characters ${characterOffset}-${Math.max(characterOffset, end - 1)} of ${value.length}.]`;

  return (page + footer).slice(0, maxCharacters);
}
