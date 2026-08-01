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
      name: "getScreenSize",
      description: "Get the size (width/height) of the primary/virtual desktop.",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "getDisplays",
      description: "List all connected displays with bounds and scale factors.",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "screenshot",
      description:
        "Capture the screen and return it as an image for you to look at. Optionally pass a displayId to capture a single display, a region to crop {x,y,width,height}, a scale factor to downscale (e.g. 0.5), grid=true to overlay a labeled coordinate grid to help you aim clicks, a crosshair {x,y} marker, or out to write the image to a file instead of returning it.",
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
              "Overlay a labeled coordinate grid to help you aim clicks (default false).",
          },
          crosshair: {
            type: "object",
            description: "Optional crosshair marker to draw at {x, y}.",
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
      name: "screenshotRegion",
      description:
        "Capture a cropped region of the screen (x, y, width, height in pixels) and return it as an image. Use this to zoom into a specific area (e.g. a timeline column) instead of reasoning over a full 4K frame. Set grid=true to overlay a labeled coordinate grid to help you aim clicks.",
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
            description: "Overlay a labeled coordinate grid (default false).",
          },
        },
        required: ["x", "y", "width", "height"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getPixelColor",
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
      name: "findColorRegions",
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
      name: "clickColorSequence",
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
      name: "getMousePosition",
      description: "Get the current mouse cursor position.",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "listWindows",
      description:
        "List the currently open application windows (title + owning app).",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "getActiveWindow",
      description: "Get the currently focused/active window.",
      parameters: noArgs,
    },
  },
  {
    type: "function",
    function: {
      name: "focusWindow",
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
      name: "moveMouse",
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
      name: "click",
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
      name: "doubleClick",
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
      name: "clickAt",
      description: "Move to (x, y) then click in one step.",
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
        },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dragMouse",
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
      name: "scroll",
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
      name: "smoothScroll",
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
      name: "typeText",
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
      name: "pressKey",
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
      name: "hotkey",
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
      name: "runComputerMacro",
      description:
        "Run a sequence of computer-use steps in ONE call, in order. Much faster and smoother than issuing many separate tool calls. Each step is an object like {action:'move',x,y}, {action:'clickAt',x,y}, {action:'type',text}, {action:'key',key}, {action:'hotkey',keys:[]}, {action:'scroll',dx,dy,repeat,intervalMs}, {action:'focus',match}, {action:'sleep',ms}, {action:'screenshot',out}. Use this to script multi-step interactions (e.g. focus a window, scroll a feed, type a message).",
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
      name: "runComputerMacroFile",
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
];
