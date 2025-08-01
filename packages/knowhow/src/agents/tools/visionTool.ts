import { services, ToolsService } from "../../services";
import { askGptVision } from "../../ai";
import { Models } from "../../types";

export async function visionTool(
  imageUrl: string,
  question: string,
  provider = "openai",
  model = Models.openai.GPT_4o
) {
  const toolService =
    this instanceof ToolsService ? (this as ToolsService) : services().Tools;

  const { Clients } = toolService.getContext();

  const response = await Clients.createCompletion(provider, {
    model,
    max_tokens: 2500,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: question },
          {
            type: "image_url",
            image_url: {
              url: imageUrl,
            },
          },
        ],
      },
    ],
  });
  return response.choices[0].message.content;
}
