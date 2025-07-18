import { Tool } from "../../clients/types";
import { globalTokenCompressor } from "../../processors/TokenCompressor";

export const getBigStringTool: Tool = {
  type: "function",
  function: {
    name: "GET_BIG_STRING",
    description: "Retrieve compressed data that was stored during message processing. Use this when you see a compressed data key in messages.",
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "The key of the compressed data to retrieve"
        }
      },
      required: ["key"]
    }
  }
};

export function getBigString(key: string): string {
  const data = globalTokenCompressor.retrieveString(key);
  
  if (!data) {
    return `Error: No data found for key "${key}". Available keys: ${globalTokenCompressor.getStorageKeys().join(", ")}`;
  }
  
  return data;
}