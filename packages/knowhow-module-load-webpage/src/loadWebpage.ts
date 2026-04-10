import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";

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
  let browser;
  let page;

  try {
    console.log(`Loading webpage: ${url} in ${mode} mode`);

    chromium.use(stealth());

    // Launch browser with stealth settings
    browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        process.env.DISABLE_CHROME_SANDBOX === "true" ? "--no-sandbox" : "",
      ],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    page = await context.newPage();

    // Capture console logs for text mode
    const consoleLogs: string[] = [];
    if (mode === "text") {
      page.on("console", (msg) => {
        consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
      });
    }

    // Navigate to the URL
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout,
    });

    // Wait for specific selector if provided
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout });
    }

    let result: string;

    if (mode === "screenshot") {
      // Take screenshot and return base64 encoded image
      const screenshot = await page.screenshot({
        fullPage: true,
        type: "png",
      });

      const base64Screenshot = screenshot.toString("base64");
      result = `data:image/png;base64,${base64Screenshot}`;
    } else {
      // Extract text content
      const textContent = await page.evaluate(() => {
        // Remove script and style elements
        const scripts = document.querySelectorAll("script, style");
        scripts.forEach((el) => el.remove());

        // Get the text content
        return document.body?.innerText || document.body?.textContent || "";
      });

      // Get page title
      const title = await page.title();

      // Format the result
      result = `# ${title}\n\n## Page Content:\n${textContent}`;

      if (consoleLogs.length > 0) {
        result += `\n\n## Console Logs:\n${consoleLogs.join("\n")}`;
      }
    }

    return result;
  } catch (error) {
    console.error("Error loading webpage:", error);
    return `Error loading webpage: ${
      error instanceof Error ? error.message : String(error)
    }`;
  } finally {
    // Always close the browser
    if (page) {
      try {
        await page.close();
      } catch (e) {
        console.warn("Error closing page:", e);
      }
    }

    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.warn("Error closing browser:", e);
      }
    }
  }
}

export default loadWebpage;
