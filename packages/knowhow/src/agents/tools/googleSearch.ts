import axios from "axios";
import { Tool } from "../../clients/types";

interface GoogleSearchParams {
  q: string;
  cx?: string;
  dateRestrict?: string;
  siteSearch?: string;
  siteSearchFilter?: "e" | "i";
  sort?: string;
  start?: number;
  lr?: string;
  num?: number;
  [key: string]: any;
}

// Google Search API Response Types
interface GoogleSearchUrlTemplate {
  type: string;
  template: string;
}

interface GoogleSearchQuery {
  title: string;
  totalResults: string;
  searchTerms: string;
  count: number;
  startIndex: number;
  startPage: number;
  language: string;
  inputEncoding: string;
  outputEncoding: string;
  safe: string;
  cx: string;
  sort: string;
  filter: string;
  gl: string;
  cr: string;
  googleHost: string;
  disableCnTwTranslation: string;
  hq: string;
  hl: string;
  siteSearch: string;
  siteSearchFilter: string;
  exactTerms: string;
  excludeTerms: string;
  linkSite: string;
  orTerms: string;
  relatedSite: string;
  dateRestrict: string;
  lowRange: string;
  highRange: string;
  fileType: string;
  rights: string;
  searchType: string;
  imgSize: string;
  imgType: string;
  imgColorType: string;
  imgDominantColor: string;
}

interface GoogleSearchQueries {
  previousPage: GoogleSearchQuery[];
  request: GoogleSearchQuery[];
  nextPage: GoogleSearchQuery[];
}

interface GoogleSearchInformation {
  searchTime: number;
  formattedSearchTime: string;
  totalResults: string;
  formattedTotalResults: string;
}

interface GoogleSearchSpelling {
  correctedQuery: string;
  htmlCorrectedQuery: string;
}

export interface GoogleSearchResponse {
  kind: string;
  url: GoogleSearchUrlTemplate;
  queries: GoogleSearchQueries;
  promotions?: any[];
  context?: any;
  searchInformation: GoogleSearchInformation;
  spelling?: GoogleSearchSpelling;
  items?: any[];
}

interface LlmRelevantSearchResult {
  title: string;
  link: string;
  snippet: string;
  source?: string;
}

interface TransformedLlmResponse {
  searchQuery: string;
  totalResults?: string;
  results: LlmRelevantSearchResult[];
}

/**
 * Transforms the Google Custom Search API response to a more LLM-relevant format.
 * It prioritizes plain text fields and extracts essential information.
 *
 * @param apiResponse The original API response from Google Custom Search.
 * @returns An object containing the search query and a list of processed search results.
 */
function transformGoogleSearchResponseForLLM(
  apiResponse: GoogleSearchResponse
) {
  const searchQuery =
    apiResponse.queries?.request?.[0]?.searchTerms || "Unknown query";
  const totalResults = apiResponse.searchInformation?.totalResults;

  const relevantItems: LlmRelevantSearchResult[] = (
    apiResponse.items || []
  ).map((item) => {
    let bestSnippet = item.snippet || ""; // Default to the item's snippet

    const metaTags = item.pagemap?.metatags?.[0];
    if (metaTags) {
      const ogDescription = metaTags["og:description"];
      const twitterDescription = metaTags["twitter:description"];
      const genericDescription = metaTags?.description;

      // Prefer meta descriptions if they are longer or provide more context
      if (ogDescription && ogDescription.length > bestSnippet.length) {
        bestSnippet = ogDescription;
      } else if (
        twitterDescription &&
        twitterDescription.length > bestSnippet.length
      ) {
        bestSnippet = twitterDescription;
      } else if (
        genericDescription &&
        genericDescription.length > bestSnippet.length
      ) {
        bestSnippet = genericDescription;
      }
    }

    return {
      title: item.title,
      link: item.link,
      snippet: bestSnippet,
      source: item.displayLink,
    };
  });

  return {
    searchQuery,
    totalResults,
    results: relevantItems,
    usd_cost: 0.005,
  };
}

export async function googleSearch(params: GoogleSearchParams) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;
  if (!apiKey) {
    throw new Error("GOOGLE_SEARCH_API_KEY environment variable is not set");
  }
  if (!cx) {
    throw new Error("GOOGLE_SEARCH_CX environment variable is not set");
  }

  const baseUrl = "https://www.googleapis.com/customsearch/v1";
  const url = new URL(baseUrl);
  url.searchParams.append("key", apiKey);
  url.searchParams.append("cx", cx);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.append(key, value.toString());
    }
  }

  try {
    const response = await axios.get<GoogleSearchResponse>(url.toString());
    return transformGoogleSearchResponseForLLM(response.data);
  } catch (error) {
    console.error("Error performing Google search:", error);
    throw error;
  }
}

export const googleSearchDefinition: Tool = {
  type: "function",
  function: {
    name: "googleSearch",
    description: "Perform a Google search using the Custom Search API",
    parameters: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "The search query",
        },
        num: {
          type: "number",
          description:
            "The number of search results to return (optional, default is 10, max is 10)",
        },
        start: {
          type: "number",
          description:
            "The index of the first result to return (optional, default is 1)",
        },
        dateRestrict: {
          type: "string",
          description:
            "Restricts results to URLs based on date. Format: [d|w|m|y]NUMBER. Example: 'd10' for past 10 days",
        },
        siteSearch: {
          type: "string",
          description: "Specifies a site to search within",
        },
        siteSearchFilter: {
          type: "string",
          description:
            "Controls whether to include or exclude results from the site specified in siteSearch. 'e' to exclude, 'i' to include",
        },
        sort: {
          type: "string",
          description:
            "The sort expression to apply to the results, e.g., 'date'",
        },
        lr: {
          type: "string",
          description:
            "Restricts the search to documents written in a particular language (e.g., lr=lang_ja)",
        },
      },
      required: ["q"],
    },
  },
};

export default googleSearch;
