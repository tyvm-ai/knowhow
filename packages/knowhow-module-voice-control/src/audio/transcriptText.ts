
export function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

/**
 * Looser filter for command mode — rejects Whisper hallucinations but allows
 * single-word voice commands like "click", "slice", "zoom", etc.
 * In agent mode use the stricter isMeaningfulTranscript instead.
 */
export function isMeaningfulCommandTranscript(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || !/[a-z0-9]/.test(normalized)) return false;
  const marker = normalized.replace(/[^a-z0-9']+/g, " ").trim();
  // Reject empty/noise/silence placeholders.
  if (/^(?:blank audio|blank|no speech|nospeech|no speech detected|inaudible|silence|static|noise|background noise|music|applause|laughter|laughing|cough(?:ing)?|breathing|beep(?:ing)?)$/.test(marker)) return false;
  // Reject pure filler/acknowledgement hallucinations — NOT mechanical sounds
  // (those could be command words in a different context).
  if (/^(?:you|yeah|yes|no|thank you|thanks|you're welcome|okay|ok)$/.test(marker)) return false;
  return true;
}

/** Reject recognizer placeholders and sounds that are not a user command. */
export function isMeaningfulTranscript(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || !/[a-z0-9]/.test(normalized)) return false;
  const marker = normalized.replace(/[^a-z0-9']+/g, " ").trim();
  if (/^(?:blank audio|blank|no speech|nospeech|no speech detected|inaudible|silence|static|noise|background noise|music|applause|laughter|laughing|cough(?:ing)?|breathing|beep(?:ing)?)$/.test(marker)) return false;
  if (/^(?:keyboard(?: clicking| noise)?|typing(?: noise)?|click(?:ing)?|mouse clicking)$/.test(marker)) return false;
  if (/^(?:you|yeah|yes|no|thank you|thanks|you're welcome|okay|ok)$/.test(marker)) return false;
  return true;
}

/** Remove Whisper control/caption markers without rewriting the user's words. */
export function stripRecognizerArtifacts(text: string): string {
  return text
    .replace(
      /[\[(](?:blank[ _-]?audio|no[ _-]?speech|inaudible|silence|static|noise|background[ _-]?noise|music|applause|laughter|laughing|cough(?:ing)?|breathing|beep(?:ing)?|keyboard(?: clicking| noise)?|typing(?: noise)?|mouse clicking)(?:\]|\))/gi,
      " "
    )
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
