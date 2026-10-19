import { Tool } from "@tyvm/knowhow";

const noArgs = {
  type: "object",
  positional: true,
  properties: {},
  required: [] as string[],
};

export const computerToolDefinitions: Tool[] = [
  {
    type: "function",
    function: {
      name: "computerUseGetScreenSize",
      description: "Get the size (width/height) of the primary/virtual desktop.",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseListAutomationExtensions",
      description:
        "List all registered automation SDK extensions — the sdk.ext.* APIs that automations can use. " +
        "Returns name, description, and optional TypeScript typings for each extension. " +
        "Call this before writing an automation that uses sdk.ext to discover what extensions are available (e.g. sdk.ext.gaze, sdk.ext.voice). " +
        "Extensions are contributed by loaded modules (e.g. knowhow-module-voice-control registers sdk.ext.gaze and sdk.ext.voice).",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseScreenshotWindow",
      description: "Focus and capture one exact stable OS window at 1:1 pixels. Returns verified window and coordinate metadata and rejects stale IDs, clipping, or geometry mismatches.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          windowId: { type: "number", description: "Stable ID from computerUseListWindows." },
          grid: { type: "boolean", description: "Overlay absolute desktop coordinate labels." },
        },
        required: ["windowId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseScreenshotWindowTiles",
      description: "Focus and capture an exact window as non-overlapping native-resolution tiles for high-resolution visual inspection. Rejects stale, clipped, or cross-display windows.",
      parameters: {
        type: "object", positional: true,
        properties: {
          windowId: { type: "number", description: "Stable ID from computerUseListWindows." },
          columns: { type: "number", description: "Tile columns (default 2, maximum 8)." },
          rows: { type: "number", description: "Tile rows (default 2, maximum 8)." },
        },
        required: ["windowId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseGetDisplays",
      description: "List all connected displays with bounds and scale factors.",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseScreenshot",
      description:
        "Capture the screen and return it as an image for you to look at, PLUS a JSON coordinateMapping text block describing the image->desktop scale (scaleX/scaleY, imageWidth/Height, desktopWidth/Height, regionX/Y). The returned image is often downscaled (the configured screenshotScale, e.g. 0.5 on a 4K display, applies even if you pass no scale), so a pixel you read off the raw image is NOT the desktop coordinate — divide by scaleX/scaleY (and add regionX/Y) first, or just use grid=true. Optionally pass a displayId to capture a single display, a region to crop {x,y,width,height}, a scale factor to downscale (e.g. 0.5), grid=true to overlay a labeled coordinate grid to help you aim clicks, a crosshair {x,y} marker, or out to write the image to a file instead of returning it. IMPORTANT: grid labels and the crosshair are in ABSOLUTE DESKTOP coordinates — they already account for scale and region offset, so you can read a value straight off the grid and pass it directly to computerUseClickAt with NO 1/scale or offset math.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          displayId: {
            type: "number",
            description: "Optional display id to capture (from getDisplays).",
          },
          region: {
            type: "object",
            description:
              "Optional crop region in pixels: {x, y, width, height}.",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
          },
          scale: {
            type: "number",
            description: "Optional downscale factor (e.g. 0.5 for 4K displays).",
          },
          grid: {
            type: "boolean",
            description:
              "Overlay a labeled coordinate grid to help you aim clicks (default false). Grid labels are absolute desktop coordinates — read them off directly and pass to computerUseClickAt, no scale/offset math needed.",
          },
          crosshair: {
            type: "object",
            description:
              "Optional crosshair marker drawn at absolute desktop {x, y}. Use it to visually confirm a coordinate before clicking.",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
            },
          },
          out: {
            type: "string",
            description:
              "Optional output file path (png/jpeg). If set, writes to disk and returns a status string instead of the image.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseFocusWindowById",
      description: "Focus one exact OS window by the stable ID returned by listWindows, then verify it is active.",
      parameters: {
        type: "object",
        positional: true,
        properties: { windowId: { type: "number", description: "Stable OS window ID." } },
        required: ["windowId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseGetActiveBrowserTab",
      description: "Read the front Chrome tab title, URL, and stable window ID without inspecting page DOM.",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseNavigateActiveBrowser",
      description: "Navigate only the verified front Chrome tab directly to an http(s) URL.",
      parameters: {
        type: "object", positional: true,
        properties: {
          url: { type: "string" },
          expectedWindowId: { type: "number", description: "Refuse unless this exact window is active." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseSelectAccessibilityOption",
      description:
        "Select an exact option in a native or web select control. Prefer this over opening the popup and navigating with separate clicks/keys.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          id: { type: "string", description: "Fresh accessibility element ID." },
          option: { type: "string", description: "Exact visible option text." },
        },
        required: ["id", "option"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseActivateAccessibilityElement",
      description:
        "Activate a fresh accessibility element reliably. Uses AXPress/AXConfirm/AXPick when exposed, otherwise clicks the element's bounds center. Prefer this for ordinary buttons, links, checkboxes, tabs, and menu items.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          id: {
            type: "string",
            description: "Fresh ID from computerUseAccessibilityElements.",
          },
          expectedText: {
            type: "string",
            description: "Visible title, description, or value expected on that fresh ID; activation is refused on mismatch.",
          },
        },
        required: ["id", "expectedText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseScreenshotRegion",
      description:
        "Capture a cropped region of the screen (x, y, width, height in pixels) and return it as an image. Use this to zoom into a specific area (e.g. a timeline column) instead of reasoning over a full 4K frame. Set grid=true to overlay a labeled coordinate grid to help you aim clicks. Grid labels are ABSOLUTE DESKTOP coordinates (they include this region's x/y offset), so read a value off the grid and pass it directly to computerUseClickAt — no offset math required.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          x: { type: "number", description: "Region left" },
          y: { type: "number", description: "Region top" },
          width: { type: "number", description: "Region width" },
          height: { type: "number", description: "Region height" },
          displayId: { type: "number", description: "Optional display id" },
          grid: {
            type: "boolean",
            description:
              "Overlay a labeled coordinate grid (default false). Labels are absolute desktop coordinates including this region's offset — pass them straight to computerUseClickAt.",
          },
        },
        required: ["x", "y", "width", "height"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseGetPixelColor",
      description: "Get the #RRGGBB color of the pixel at (x, y).",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          x: { type: "number", description: "X coordinate" },
          y: { type: "number", description: "Y coordinate" },
        },
        required: ["x", "y", "expectedWindowId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseReadText",
      description: "Read visible text with OCR. Returns text, confidence, and absolute desktop bounds/centers for precise follow-up actions.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          region: { type: "object", description: "Optional desktop region {x,y,width,height} or named region." },
          displayId: { type: "number", description: "Optional display id." },
          activeWindow: { type: "boolean", description: "Restrict recognition to the focused window." },
          minConfidence: { type: "number", description: "Minimum OCR confidence from 0 to 1 (default 0.3)." },
          recognitionLevel: { type: "string", enum: ["fast", "accurate"], description: "Vision recognition level (default accurate)." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseGetPixelColors",
      description: "Sample multiple desktop points from one screenshot frame and return colors in the same order.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          points: { type: "array", items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } }, description: "Desktop points to sample." },
        },
        required: ["points"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseFindColorRegions",
      description:
        "Find solid-color regions in a screenshot and return exact desktop-coordinate centers and bounds. This is faster and more precise than visually estimating coordinates for flat-color UI targets.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          colors: {
            type: "array",
            items: { type: "string" },
            description: "Target colors as #RRGGBB values.",
          },
          tolerance: { type: "number", description: "Per-channel color tolerance (default 12)." },
          minPixels: { type: "number", description: "Minimum sampled matching pixels (default 20)." },
          minSize: { type: "number", description: "Minimum region width/height in desktop pixels." },
          maxSize: { type: "number", description: "Maximum region width/height in desktop pixels." },
          displayId: { type: "number", description: "Optional display id." },
        },
        required: ["colors"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseClickColorSequence",
      description:
        "Detect and click a sequence of changing solid-color targets in one fast local loop. Use for reaction/precision tasks instead of taking a screenshot and making an LLM tool call for every target. Returns exact clicked regions and timing.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          colors: {
            type: "array",
            items: { type: "string" },
            description: "Target colors as #RRGGBB values.",
          },
          maxClicks: { type: "number", description: "Stop after this many clicks (default 20)." },
          timeoutMs: { type: "number", description: "Overall timeout in milliseconds (default 30000)." },
          tolerance: { type: "number", description: "Per-channel color tolerance (default 12)." },
          minPixels: { type: "number", description: "Minimum sampled matching pixels (default 20)." },
          minSize: { type: "number", description: "Minimum target size in desktop pixels." },
          maxSize: { type: "number", description: "Maximum target size in desktop pixels; use this to reject matching page chrome." },
          pollIntervalMs: { type: "number", description: "Delay when waiting for a new target (default 10)." },
        },
        required: ["colors"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseGetMousePosition",
      description: "Get the current mouse cursor position.",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseListWindows",
      description:
        "List the currently open application windows (title + owning app).",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseGetActiveWindow",
      description: "Get the currently focused/active window.",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseAccessibilityElements",
      description:
        "Inspect controls in the focused macOS window using native Accessibility APIs. Returns short-lived element IDs, roles, values, bounds, and supported actions.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          maxDepth: { type: "number", description: "Maximum tree depth (default 12)." },
          maxElements: { type: "number", description: "Maximum returned controls (default 500)." },
          interactiveOnly: { type: "boolean", description: "Only return interactive controls (default true)." },
          expectedWindowId: { type: "number", description: "Refuse traversal unless this exact window is active." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseSetAccessibilityValue",
      description:
        "Set the value of a focused-window accessibility element. Use a fresh ID from computerUseAccessibilityElements.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          id: { type: "string", description: "Short-lived accessibility element ID." },
          value: { type: "string", description: "Value to set." },
        },
        required: ["id", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUsePerformAccessibilityAction",
      description:
        "Perform an allowlisted native accessibility action on a focused-window element, such as AXPress or AXShowMenu.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          id: { type: "string", description: "Short-lived accessibility element ID." },
          action: {
            type: "string",
            enum: ["AXPress", "AXConfirm", "AXCancel", "AXShowMenu", "AXIncrement", "AXDecrement", "AXPick"],
          },
        },
        required: ["id", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseFocusWindow",
      description:
        "Focus/activate a window or application by name (e.g. 'Google Chrome').",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          match: {
            type: "string",
            description: "App or window name to focus/activate.",
          },
        },
        required: ["match"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseMoveMouse",
      description: "Move the mouse cursor to absolute (x, y).",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          x: { type: "number", description: "X coordinate" },
          y: { type: "number", description: "Y coordinate" },
        },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseClick",
      description: "Click the mouse at its current position.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          button: {
            type: "string",
            enum: ["left", "right", "middle"],
            description: "Mouse button (default left).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseDoubleClick",
      description: "Double-click the mouse at its current position.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          button: {
            type: "string",
            enum: ["left", "right", "middle"],
            description: "Mouse button (default left).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseClickAt",
      description:
        "Move to (x, y), capture a tight pre-click crop, click, then return a larger post-click context crop in the same response. Image metadata includes absolute desktop bounds. Use the attached post-click image instead of taking a separate screenshot. Pass feedback.enabled=false only when images are unnecessary.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          x: { type: "number", description: "X coordinate" },
          y: { type: "number", description: "Y coordinate" },
          button: {
            type: "string",
            enum: ["left", "right", "middle"],
            description: "Mouse button (default left).",
          },
          feedback: {
            type: "object",
            description:
              "Optional bounded visual-feedback settings. Feedback is enabled by default.",
            properties: {
              enabled: {
                type: "boolean",
                description: "Set false for the legacy text-only response.",
              },
              before: {
                type: "object",
                description: "Tight pre-click crop settings.",
                properties: {
                  width: { type: "number", description: "Crop width (default 240)." },
                  height: { type: "number", description: "Crop height (default 240)." },
                  scale: { type: "number", description: "Image scale (default 1)." },
                },
              },
              after: {
                type: "object",
                description:
                  "Post-click crop settings. Defaults to the active window at scale 0.25 to reduce vision latency.",
                properties: {
                  width: {
                    type: "number",
                    description: "Centered crop width; omit to use active-window bounds.",
                  },
                  height: {
                    type: "number",
                    description: "Centered crop height; omit to use active-window bounds.",
                  },
                  scale: { type: "number", description: "Image scale (default 0.25)." },
                  region: {
                    type: "object",
                    description:
                      "Explicit absolute desktop crop; overrides width/height and active-window detection.",
                    properties: {
                      x: { type: "number" },
                      y: { type: "number" },
                      width: { type: "number" },
                      height: { type: "number" },
                    },
                  },
                },
              },
              delayMs: {
                type: "number",
                description: "Wait before post-click capture (default 100ms, max 5000ms).",
              },
              omitUnchanged: {
                type: "boolean",
                description:
                  "Compare the same context before/after and omit an unchanged after image.",
              },
            },
          },
          expectedWindow: {
            type: "string",
            description: "Refuse the click unless the active app/title contains this text before and after.",
          },
          expectedWindowId: {
            type: "number",
            description: "Optional exact stable window ID. If given it is focused before the click and must still be active after.",
          },
          app: {
            type: "string",
            description: "Name of the application this input is meant for, exactly as computerUseListWindows reports it (e.g. \"Obsidian\", \"Google Chrome\", \"Ghostty\"). It is activated (brought to the front) before clicking, and the call is refused if it can't be made frontmost, so input never lands in the wrong app.",
          },
        },
        required: ["x", "y", "app"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseDragMouse",
      description: "Press at (fromX, fromY), move to (toX, toY), and release.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          fromX: { type: "number" },
          fromY: { type: "number" },
          toX: { type: "number" },
          toY: { type: "number" },
        },
        required: ["fromX", "fromY", "toX", "toY"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseScroll",
      description:
        "Scroll by (dx, dy) wheel deltas. Negative dy scrolls down (toward later content), positive dy scrolls up — native macOS wheel convention, verified live.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          dx: { type: "number", description: "Horizontal scroll delta" },
          dy: { type: "number", description: "Vertical scroll delta" },
        },
        required: ["dx", "dy"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseSmoothScroll",
      description:
        "Scroll smoothly by repeating a small (dx, dy) delta N times with a pause between each step. Best for scrolling a feed a controlled amount (e.g. dy=-3, repeat=10). Negative dy scrolls down (toward later content), positive dy scrolls up — native macOS wheel convention, verified live.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          dx: { type: "number", description: "Horizontal delta per step" },
          dy: { type: "number", description: "Vertical delta per step" },
          repeat: { type: "number", description: "Number of steps (default 1)" },
          intervalMs: {
            type: "number",
            description: "Delay between steps in ms (default 0)",
          },
        },
        required: ["dx", "dy"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseTypeText",
      description: "Activate `app`, then type a string of text at its current focus. Click into the target field first if needed. Newlines (\\n) press Return and tabs (\\t) press Tab, so multi-line lists type as separate lines/list items.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          text: { type: "string", description: "Text to type" },
          expectedWindow: {
            type: "string",
            description: "Refuse to type unless the active app/title contains this text.",
          },
          requireEditableFocus: {
            type: "boolean",
            description: "Refuse to type unless accessibility reports a focused editable control.",
          },
          expectedWindowId: {
            type: "number",
            description: "Optional exact stable window ID; if given that window is focused before typing.",
          },
          app: {
            type: "string",
            description: "Name of the application this input is meant for, exactly as computerUseListWindows reports it (e.g. \"Obsidian\", \"Google Chrome\", \"Ghostty\"). It is activated (brought to the front) before typing, and the call is refused if it can't be made frontmost, so input never lands in the wrong app.",
          },
        },
        required: ["text", "app"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUsePressKey",
      description:
        "Press a single named key, e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown'.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          key: { type: "string", description: "Key name" },
          app: {
            type: "string",
            description: "Name of the application this input is meant for, exactly as computerUseListWindows reports it (e.g. \"Obsidian\", \"Google Chrome\", \"Ghostty\"). It is activated (brought to the front) before the key press, and the call is refused if it can't be made frontmost, so input never lands in the wrong app.",
          },
          expectedWindowId: {
            type: "number",
            description: "Optional exact stable window ID to focus before the key press.",
          },
        },
        required: ["key", "app"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseHotkey",
      description:
        "Press a key chord, e.g. ['control','c'] or ['command','l']. Modifiers first.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          keys: {
            type: "array",
            items: { type: "string" },
            description: "Keys to press together (modifiers first).",
          },
          app: {
            type: "string",
            description: "Name of the application this input is meant for, exactly as computerUseListWindows reports it (e.g. \"Obsidian\", \"Google Chrome\", \"Ghostty\"). It is activated (brought to the front) before the chord, and the call is refused if it can't be made frontmost, so input never lands in the wrong app.",
          },
          expectedWindowId: {
            type: "number",
            description: "Optional exact stable window ID to focus before the chord.",
          },
        },
        required: ["keys", "app"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseRunComputerMacro",
      description:
        "Run a sequence of computer-use steps in ONE call, in order. Much faster and smoother than issuing many separate tool calls. Steps include {action:'move',x,y}, {action:'clickAt',x,y}, {action:'type',text}, {action:'key',key}, {action:'hotkey',keys:[]}, {action:'scroll',dx,dy,repeat,intervalMs}, {action:'focus',match}, {action:'sleep',ms}, and {action:'screenshot',out}. Native-control steps include {action:'accessibilityTrusted'}, {action:'accessibilityElements'}, {action:'setAccessibilityValue',target:{role,titleIncludes},value}, and {action:'performAccessibilityAction',target:{role,titleIncludes},accessibilityAction:'AXPress'}; selector targets refresh the accessibility tree immediately before acting. Use this to script multi-step interactions in one process.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          steps: {
            type: "array",
            items: { type: "object" },
            description:
              "Ordered list of step objects. Each has an 'action' and its params.",
          },
          continueOnError: {
            type: "boolean",
            description: "Keep running past failed steps (default false).",
          },
          expectedWindowId: {
            type: "number",
            description: "Optional exact stable window ID to focus before the macro (and verify after, unless the macro has a focus step).",
          },
          app: {
            type: "string",
            description: "Name of the application this input is meant for, exactly as computerUseListWindows reports it (e.g. \"Obsidian\", \"Google Chrome\", \"Ghostty\"). It is activated (brought to the front) before the macro runs, and the call is refused if it can't be made frontmost, so input never lands in the wrong app.",
          },
        },
        required: ["steps", "app"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseRunComputerMacroFile",
      description:
        "Run a saved computer-use macro/script file (JSON or YAML list of steps) in ONE call. Use this to execute a re-usable automation script from disk (the same format the `knowhow computer run <file>` CLI uses).",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          file: {
            type: "string",
            description: "Path to the macro file (.json/.yaml/.yml).",
          },
          continueOnError: {
            type: "boolean",
            description: "Keep running past failed steps (default false).",
          },
        },
        required: ["file"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseFindBoxes",
      description:
        "Detect axis-aligned rectangular boxes (buttons, cards, panels, modals) on screen and return them as a CONTAINMENT HIERARCHY in absolute desktop coordinates. Each box has bounds, center, area, edgeScore, depth, and nested children. Use this to locate UI structurally — e.g. find the small rectangle (button) nested inside a large square (modal) — instead of eyeballing pixels. Pass a region (name or {x,y,width,height}) to limit the search. Prefers the native Rust detector.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          region: {
            description:
              "Optional search area: a named region string or {x,y,width,height} in desktop coords.",
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
          },
          minSize: { type: "number", description: "Minimum box width/height in desktop px (default 12)." },
          maxSize: { type: "number", description: "Maximum box width/height in desktop px." },
          minEdgeScore: { type: "number", description: "Required border edge coverage 0..1 (default 0.6)." },
          edgeThreshold: { type: "number", description: "Gradient threshold for the edge map (default 40)." },
          maxBoxes: { type: "number", description: "Cap on returned boxes (default 200)." },
          displayId: { type: "number", description: "Optional display id." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseFindRegions",
      description:
        "Detect discrete UI ELEMENTS (buttons, cards, text blocks, icons) by COLOR SEGMENTATION and return them as a nested containment hierarchy in absolute desktop coordinates. Unlike computerUseFindBoxes (which needs full-width/height edges and only finds big panels), this finds small localized elements on an otherwise-empty background — e.g. a centered 'Start Game' button or an 'API Endpoints' card. mode 'colors' (default) labels contiguous same-color areas and nests them (card -> button inside -> text inside); mode 'foreground' finds everything that differs from the dominant background color; mode 'panels' models the UI the way a person eyes it — it finds large flat BACKGROUND surfaces (menu bar, toolbar, card fill) and groups the FOREGROUND content on each into element boxes, so a readout like SCORE/ROUND/HITS/MISSES or a row of buttons is captured (grouped by shared background + proximity) and nested inside its surface (tune clusterGap to merge/split nearby content). Great for mapping out a UI you can't otherwise select structurally.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          region: {
            description:
              "Optional search area: a named region string or {x,y,width,height} in desktop coords.",
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
          },
          mode: {
            type: "string",
            enum: ["colors", "foreground", "panels"],
            description:
              "'colors' (default): segment & nest by same-color areas. 'foreground': everything differing from the background color. 'panels': background surfaces + grouped foreground content (score readouts, toolbars, button rows).",
          },
          minSize: { type: "number", description: "Minimum element width/height in desktop px (default 16)." },
          colorBits: { type: "number", description: "Color granularity for 'colors'/'panels' mode, 1-8 (default 3)." },
          clusterGap: { type: "number", description: "'panels' mode: px to merge nearby foreground content into one group (default 3; larger=coarser)." },
          minPixels: { type: "number", description: "Minimum element area in desktop pixels (default 40)." },
          maxBoxes: { type: "number", description: "Cap on returned elements (default 300)." },
          displayId: { type: "number", description: "Optional display id." },
          scale: { type: "number", description: "Native perception capture scale in (0, 1]; e.g. 0.25 for faster detection. Results and thresholds remain in desktop coordinates." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseFindShape",
      description:
        "Find geometric shapes on screen by kind — 'line-h', 'line-v', 'rect', 'square', 'circle', or 'blob' — optionally constrained to a color, and return their centers/bounds in absolute desktop coordinates (ready for computerUseClickAt). More expressive than color-only matching: e.g. a horizontal line of a given length/color, a square button, or a circular target.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          kind: {
            type: "string",
            enum: ["line-h", "line-v", "rect", "square", "circle", "blob"],
            description: "Shape kind to match.",
          },
          color: { type: "string", description: "Optional #RRGGBB color mask; omit to match by edges." },
          region: {
            description: "Optional named region or {x,y,width,height} to limit the search.",
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
          },
          tolerance: { type: "number", description: "Per-channel color tolerance (default 16)." },
          minSize: { type: "number", description: "Minimum shape size in desktop px." },
          maxSize: { type: "number", description: "Maximum shape size in desktop px." },
          length: { type: "number", description: "For lines: minimum length in px." },
          thickness: { type: "number", description: "For lines: maximum thickness in px." },
          displayId: { type: "number", description: "Optional display id." },
        },
        required: ["kind"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseDefineRegion",
      description:
        "Save a named region so detectors/observers can reference it by name. By default coordinates are absolute desktop coordinates. Set anchorToActiveWindow to persist normalized offsets within the active app window, making the region follow window moves and resizes; resolution fails closed if the app/title does not match. Persists to .knowhow/automations/regions.json.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          name: { type: "string", description: "Region name, e.g. 'gameBoard'." },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          anchorToActiveWindow: {
            type: "boolean",
            description: "Convert the supplied absolute desktop rectangle to normalized coordinates within the active window.",
          },
          titleIncludes: {
            type: "string",
            description: "Optional title substring required when resolving an active-window anchored region. The active app is always recorded when available.",
          },
        },
        required: ["name", "x", "y", "width", "height"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseDefineRegionShape",
      description:
        "Save a named NON-RECTANGULAR region so you can describe 'everywhere EXCEPT the toolbar', a circle in the center, a maze/L shape, or an arbitrary SVG-path area. The shape is a RegionShape object (in absolute desktop coords): {type:'rect'|'circle'|'ellipse'|'polygon'|'svgpath'|'union'|'subtract', ...}. Examples: circle {type:'circle',cx,cy,r}; board-minus-toolbar {type:'subtract',base:{type:'rect',...},holes:[{type:'rect',...}]}; maze {type:'union',shapes:[...]}; anything {type:'svgpath',d:'M .. L .. Z'}. Use computerUseRegionContains to test whether a detected click target actually falls inside (rejecting hits in subtracted holes). Persists to .knowhow/automations/regions.json; render it with the CLI 'knowhow computer render-regions <name>'.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          name: { type: "string", description: "Region name, e.g. 'boardMinusChrome'." },
          shape: {
            type: "object",
            description:
              "A RegionShape object (or JSON string). type is one of rect/circle/ellipse/polygon/svgpath/union/subtract with the matching fields.",
          },
        },
        required: ["name", "shape"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseRegionContains",
      description:
        "Shape-aware hit test: is a desktop point (x,y) inside a named region? For flexible regions (circle/subtract/union/svgpath) this respects the true geometry — e.g. returns false for a point that landed on the browser toolbar of a 'board MINUS chrome' region even though it's within the bounding box. Use before clicking a detected target to make sure it's in the intended playable area.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          name: { type: "string", description: "Region name to test against." },
          x: { type: "number" },
          y: { type: "number" },
        },
        required: ["name", "x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseListRegions",
      description: "List all named regions in the registry.",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseClearRegion",
      description: "Remove a named region from the registry.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          name: { type: "string", description: "Region name to remove." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseWriteAutomation",
      description:
        "Author + persist an AUTOMATION as a readable .ts file. ALWAYS begin the file with a JSDoc header block documenting when to use it — order the tags @description, @window, @useWhen, @startState, @endState (put @window right after @description since the required window is the key safety detail). This header is the automation's discoverable 'skill card' that lets a future agent pick it without reading the code. Import `{ sdk }` from `@tyvm/knowhow-module-computer-use` for autocomplete; the runner strips that editor-only import and injects the live SDK. Registered Knowhow tools are also injected by name (for example `await prologQuery({ program, query })`) and through `await sdk.callTool(toolName, args)`, matching the scripting module. You may reuse helpers from sibling automations with a named import: `import { myHelper, otherFn as alias } from './sibling-name'` (`@automation/sibling-name` is also accepted). The runner inlines exported functions/consts at run time and supports aliases, nested imports, and cycle/missing-export detection. Only `export function`, `export async function`, `export const`, and `export { name }` forms are extractable. All other imports and require/process/fetch/eval remain forbidden. Automations can inspect native controls with `sdk.accessibilityElements()` and use fresh element IDs with `sdk.setAccessibilityValue()` or `sdk.performAccessibilityAction()`; these mutations obey dry-run and focus-gate safety. For reviewable visual evidence, get a frame from `const watcher = await sdk.watchScreen(...)`, perform/log an action, then call `await watcher.logAction('label', { frame })`; this persists that exact streamed frame and returns its path, also included in run artifacts (writes are focus-gated and dry-runs suppress them unless captureInDryRun:true). If setup must activate an app, call `await sdk.focus(match)` before installing `requiredWindow` (it is suppressed in dry-run and while paused). Use `await sdk.runEvery(callback, intervalMs, { requiredWindow })` (intervalMs is a delay in milliseconds, like setInterval; 0 = as fast as possible) to scope repeated work AND gate it on a focused window in one call — this is REQUIRED so focus loss (clicking away) auto-pauses the automation and a human can reclaim the mouse. Note every live run is hard-capped at 5 minutes until the global kill switch (Ctrl+Alt+Esc, provided by the computer host) is armed; then the cap is lifted. The SDK also has click/keyDown/keyUp/withKeysHeld/keyState/clipboard/copySelection/random/window.isActive/store/ui/hotkeys and keepAlive/exit/onExit lifetime control.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          name: { type: "string", description: "Automation name, e.g. 'mousePrecision'." },
          script: {
            type: "string",
            description:
              "Async .ts body saved verbatim. START with a JSDoc header (with @window right after @description), THEN the code. Example (header + code): `/**\\n * @description Auto-clicks the moving colored target in the game board.\\n * @window Chrome\\n * @useWhen playing the reflex/whack-a-target game and you want it beaten automatically.\\n * @startState game is visible and running in Chrome; a target square is on screen.\\n * @endState the game has been auto-clicked until stopped/timed out.\\n */\\nimport { sdk } from '@tyvm/knowhow-module-computer-use'; async function clickShapes(){ const t=(await sdk.findColor(['ff4444']))[0]; if(t) await sdk.clickAt(t.center.x,t.center.y); } await sdk.runEvery(clickShapes, 120, { requiredWindow: { titleIncludes: 'Chrome' } });`",
          },
        },
        required: ["name", "script"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseListAutomations",
      description:
        "List saved automations with their FULL filepath, running state, size, and their parsed skill header (doc: @description/@useWhen/@startState/@endState/@window). ALWAYS check this before solving a repetitive or real-time task or creating an automation. Enable readFile and inspect the full source of every plausible match, including documented entries; metadata is only for discovery. Reuse or incrementally update a match rather than creating a duplicate. `documented:false` means the source has no usable discovery header.",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseRunAutomation",
      description:
        "Run a saved automation LIVE (it moves the real mouse/keyboard). It runs in-process to completion (or until maxDurationMs, or until it loses window focus and you call stop). EVERY run is HARD-CAPPED at 5 minutes (unless the global kill switch is armed) so a human can always reclaim the mouse — re-launch it if you need more time. The automation should configure a required window (via sdk.requiredWindow or the { requiredWindow } option on sdk.runEvery) so clicking away auto-pauses it; a run that moved the mouse without a window gate returns a ranWithoutWindowGate warning. Returns a summary: how it stopped, elapsed/paused ms, number of clicks, average click interval, persisted ScreenWatcher.logAction artifact paths, and the tail of the telemetry log. Use readFile on an artifact path to inspect action-aligned screenshots after the run. TIP: dry-run first with computerUseTestAutomation to verify targeting before letting it act.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          name: { type: "string", description: "Automation name to run." },
          maxDurationMs: {
            type: "number",
            description: "Requested run time in ms (default 30000). HARD-CAPPED at 300000 unless the global kill switch is armed (then unlimited by default).",
          },
          params: {
            type: "object",
            description: "JSON values exposed to the automation as immutable sdk.params.",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseTestAutomation",
      description:
        "DRY-RUN a saved automation against LIVE perception WITHOUT moving the real mouse. Perception reads real pixels, but every clickAt/moveMouse/type is RECORDED instead of performed. Use this on the game to confirm the automation is locking onto the right targets (and how fast) BEFORE switching to computerUseRunAutomation. Returns the same summary with dryRun:true and the would-be actions.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          name: { type: "string", description: "Automation name to dry-run." },
          maxDurationMs: {
            type: "number",
            description: "How long to observe (default 8000).",
          },
          params: {
            type: "object",
            description: "JSON values exposed to the automation as immutable sdk.params.",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseStopAutomation",
      description:
        "Stop a running automation by name, or all=true to stop every one. Routes through the computer host for host-managed automations (those run by `knowhow computer run-automation`), and also stops in-process runs.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          name: { type: "string", description: "Automation name to stop (omit when all=true)." },
          all: { type: "boolean", description: "Stop every running automation." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseListRunningAutomations",
      description:
        "List automations running under the computer host (id, name, status running/paused, pid, hotkeyCount, trayStatus) plus in-process runs.",
      parameters: { type: "object", positional: true, properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUsePauseAutomation",
      description: "Pause a host-managed automation (its global hotkeys are suspended too).",
      parameters: {
        type: "object",
        positional: true,
        properties: { name: { type: "string", description: "Automation name." } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseResumeAutomation",
      description: "Resume a paused host-managed automation.",
      parameters: {
        type: "object",
        positional: true,
        properties: { name: { type: "string", description: "Automation name." } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseRestartAutomation",
      description: "Restart a host-managed automation with its original arguments.",
      parameters: {
        type: "object",
        positional: true,
        properties: { name: { type: "string", description: "Automation name." } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseDeleteAutomation",
      description: "Delete a saved automation (stops it first if running).",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          name: { type: "string", description: "Automation name to delete." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseReadClipboard",
      description:
        "Read the current plain-text clipboard contents (native, with pbpaste / PowerShell / wl-paste / xclip fallback).",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseWriteClipboard",
      description:
        "Replace the plain-text clipboard contents. This overwrites whatever the user had copied.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          text: { type: "string", description: "Text to place on the clipboard." },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseKeyState",
      description:
        "Report whether a key is currently held down. physical=true queries the hardware state (ignores keys injected by this process). Returns {supported:false} when the native core can't report key state yet. 'mod' means command on macOS and control elsewhere.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          key: { type: "string", description: "Key name, e.g. 'alt', 'shift', 'f6', 'mod'." },
          physical: {
            type: "boolean",
            description: "Query physical hardware state instead of the logical (injected-aware) state. Default false.",
          },
        },
        required: ["key"],
      },
    },
  },
];
