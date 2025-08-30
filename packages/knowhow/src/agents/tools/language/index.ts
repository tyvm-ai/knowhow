import { services } from "../../../services";
import { getLanguageConfig, updateLanguageConfig } from "../../../config";
import { IDatasource } from "../../../types";

export async function addLanguageTerm(term: string, sources: IDatasource[]) {
  const language = await getLanguageConfig();
  language[term] = { sources };
  await updateLanguageConfig(language);
}

export async function getAllLanguageTerms() {
  const language = await getLanguageConfig();
  return Object.keys(language);
}

export async function lookupLanguageTerm(term: string) {
  const { Plugins } = services();
  const language = await getLanguageConfig();
  return Plugins.call("language", term);
}
