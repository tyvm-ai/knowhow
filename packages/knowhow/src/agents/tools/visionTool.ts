import { askGptVision } from "../../ai";

export async function visionTool(imageUrl: string, question: string) {
  const response = await askGptVision(imageUrl, question);
  return response.choices[0].message.content;
}
