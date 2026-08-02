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
        required: ["x", "y"],
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
        },
        required: ["x", "y"],
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
        "Scroll by (dx, dy) wheel deltas. Positive dy scrolls down, negative up.",
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
        "Scroll smoothly by repeating a small (dx, dy) delta N times with a pause between each step. Best for scrolling a feed a controlled amount (e.g. dy=-3, repeat=10). Positive dy scrolls down, negative up.",
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
      description: "Type a string of text at the current focus.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          text: { type: "string", description: "Text to type" },
        },
        required: ["text"],
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
        },
        required: ["key"],
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
        },
        required: ["keys"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseRunComputerMacro",
      description:
        "Run a sequence of computer-use steps in ONE call, in order. Much faster and smoother than issuing many separate tool calls. Each step is an object like {action:'move',x,y}, {action:'computerUseClickAt',x,y}, {action:'type',text}, {action:'key',key}, {action:'hotkey',keys:[]}, {action:'scroll',dx,dy,repeat,intervalMs}, {action:'focus',match}, {action:'sleep',ms}, {action:'screenshot',out}. Use this to script multi-step interactions (e.g. focus a window, scroll a feed, type a message).",
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
        },
        required: ["steps"],
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
          minPixels: { type: "number", description: "Minimum pixel count per element (default 40)." },
          maxBoxes: { type: "number", description: "Cap on returned elements (default 300)." },
          displayId: { type: "number", description: "Optional display id." },
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
        "Author + persist an AUTOMATION as a readable .ts file. ALWAYS begin the file with a JSDoc header block documenting when to use it — order the tags @description, @window, @useWhen, @startState, @endState (put @window right after @description since the required window is the key safety detail). This header is the automation's discoverable 'skill card' that lets a future agent pick it without reading the code. Import `{ sdk }` from `@tyvm/knowhow-module-computer-use` for autocomplete; the runner strips that editor-only import and injects the live SDK. Other imports and require/process/fetch/eval remain forbidden. If setup must activate an app, call `await sdk.focus(match)` before installing `requiredWindow` (it is suppressed in dry-run and while paused). Use `await sdk.runEvery(callback, intervalMs, { requiredWindow })` (intervalMs is a delay in milliseconds, like setInterval; 0 = as fast as possible) to scope repeated work AND gate it on a focused window in one call — this is REQUIRED so focus loss (clicking away) auto-pauses the automation and a human can reclaim the mouse. Note every live run is hard-capped at 10 seconds.",
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
        "List saved automations with their FULL filepath, running state, size, and their parsed skill header (doc: @description/@useWhen/@startState/@endState/@window). ALWAYS check this before deciding whether to solve a task manually — an existing automation may already do the job. Read the `doc.useWhen` to know when each applies and `doc.startState` to know what the screen must look like first. `documented:false` means the automation lacks a header; read its file before trusting it.",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "computerUseRunAutomation",
      description:
        "Run a saved automation LIVE (it moves the real mouse/keyboard). It runs in-process to completion (or until maxDurationMs, or until it loses window focus and you call stop). EVERY run is HARD-CAPPED at 10 seconds so a human can always reclaim the mouse — re-launch it if you need more time. The automation should configure a required window (via sdk.requiredWindow or the { requiredWindow } option on sdk.runEvery) so clicking away auto-pauses it; a run that moved the mouse without a window gate returns a ranWithoutWindowGate warning. Returns a summary: how it stopped, elapsed/paused ms, number of clicks, average click interval, and the tail of the telemetry log. TIP: dry-run first with computerUseTestAutomation to verify targeting before letting it act.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          name: { type: "string", description: "Automation name to run." },
          maxDurationMs: {
            type: "number",
            description: "Requested run time in ms (default 10000). HARD-CAPPED at 10000 regardless of value.",
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
        "Request a running automation to stop (sets sdk.ctl.stopped). The loop exits on its next check.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          name: { type: "string", description: "Automation name to stop." },
        },
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
];
