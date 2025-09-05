export { LanguagePack } from "./types";
export { javascriptLanguagePack } from "./javascript";
export { pythonLanguagePack } from "./python";
export { javaLanguagePack } from "./java";

import { LanguagePack } from "./types";
import { javascriptLanguagePack } from "./javascript";
import { pythonLanguagePack } from "./python";
import { javaLanguagePack } from "./java";

// Language pack registry
export const languagePacks: Record<string, LanguagePack> = {
  javascript: javascriptLanguagePack,
  typescript: javascriptLanguagePack, // TypeScript uses the same pack as JavaScript
  python: pythonLanguagePack,
  java: javaLanguagePack,
};

export function getLanguagePack(language: string): LanguagePack | undefined {
  return languagePacks[language.toLowerCase()];
}