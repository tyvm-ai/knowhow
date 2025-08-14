import { services } from "../../../services";
function getPluginNames(): string {
  try {
    const { Plugins } = services();
    return Plugins.listPlugins().join(", ");
  } catch {
    return "";
  }
}
export const definitions = [
  {
    type: "function",
    function: {
      name: "addLanguageTerm",
      description:
        "Add a new language term to the language config, which can help load context for given terms in the future.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          term: {
            type: "string",
            description:
              "The trigger word(s) that should load the given context",
          },
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  description: `The type of datasource, options are "file", "url", "text" or the name of a plugin: ${getPluginNames()}
                  For files you must use the full relative path. For plugins you must use the name of the plugin associated with the data.
                  Always use a plugin as the kind, if a plugin name is in the url.
                  `,
                },
                data: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  description:
                    "An array of strings that will be loaded when a language term is used in a user prompt. If the kind was a plugin, then we'll call the plugin with each string as input. Strings of the same kind should be grouped together in one array of data.",
                },
              },
              required: ["kind", "data"],
            },
            description: "The sources to be loaded for the given term",
          },
        },
        required: ["term"],
      },
      returns: {
        type: "string",
        description: "The response from the human.",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getAllLanguageTerms",
      description:
        "Retrieves all language terms from the language configuration.",
      parameters: {
        type: "object",
        positional: true,
        properties: {},
        required: [],
      },
      returns: {
        type: "array",
        items: {
          type: "string",
        },
        description: "An array of all language terms in the configuration.",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookupLanguageTerm",
      description:
        "Looks up a specific language term and calls the language plugin with it.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          term: {
            type: "string",
            description: "The language term to look up",
          },
        },
        required: ["term"],
      },
      returns: {
        type: "any",
        description:
          "The result of calling the language plugin with the specified term.",
      },
    },
  },
];
