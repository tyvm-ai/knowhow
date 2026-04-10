export interface LoadWebpageOptions {
  url: string;
  mode?: "text" | "screenshot";
  waitForSelector?: string;
  timeout?: number;
}

export async function loadWebpage(
  url: string,
  mode: "text" | "screenshot" = "text",
  waitForSelector?: string,
  timeout: number = 30000
): Promise<string> {
  throw new Error(
    "loadWebpage requires @tyvm/knowhow-module-load-webpage to be installed and configured in knowhow.json modules."
  );
}

export default loadWebpage;
