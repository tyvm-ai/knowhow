export { LanguagePackConfig } from "./types";
export { javascriptLanguagePack } from "./javascript";
export { typescriptLanguagePack } from "./typescript";
export { pythonLanguagePack } from "./python";
export { javaLanguagePack } from "./java";

import { LanguagePackConfig } from "./types";
import { javascriptLanguagePack } from "./javascript";
import { typescriptLanguagePack } from "./typescript";
import { pythonLanguagePack } from "./python";
import { javaLanguagePack } from "./java";

// Language pack registry
export const languagePacks: Record<string, LanguagePackConfig> = {
  javascript: javascriptLanguagePack,
  typescript: typescriptLanguagePack,
  python: pythonLanguagePack,
  java: javaLanguagePack,
};

export function getLanguagePack(language: string): LanguagePackConfig | undefined {
  return languagePacks[language.toLowerCase()];
}
