import { Message } from "../../clients/types";
import { AgentContext, BaseAgent } from "../base/base";
import { BASE_PROMPT } from "../base/prompt";
import { Models } from "../../ai";

const example = `
Index: ./src/agents/base/base.ts
===================================================================
--- ./src/agents/base/base.ts
+++ ./src/agents/base/base.ts
@@ -186,9 +186,14 @@
     startIndex: number,
     endIndex: number
   ) {
     const toCompress = messages.slice(startIndex, endIndex);
-    const toCompressPrompt = \`Summarize what this agent was tasked with, what has been tried so far, and what we're about to do next. This summary will become the agent's only memory of the past, all other messages will be dropped: \n\n\${JSON.stringify(
+    const toCompressPrompt = \`Summarize:
+    1. Initial Request - what this agent was tasked with.
+    2. Progress - what has been tried so far,
+    3. Next Steps - what we're about to do next to continue the user's original request.
+
+      This summary will become the agent's only memory of the past, all other messages will be dropped: \n\n\${JSON.stringify(
       toCompress
     )}\`;

     const model = this.getModel();
@@ -202,9 +207,12 @@
         },
       ],
     });

+    const systemMesasges = toCompress.filter((m) => m.role === "system");
+
     const newMessages = [
+      ...systemMesasges,
       ...response.choices.map((c) => c.message),
       ...messages.slice(endIndex),
   ];

`;

const systemReminder = `# Patch Tool Rules:
Here's an example of a correctly formatted patch:
${example}

Be sure to preserve sytanx, delete the correct lines of code, and insert new lines of code in the correct locations.

The user's patch tool needs CORRECT patches that apply cleanly against the current contents of the file!
Think carefully and make sure you include and mark all lines that need to be removed or changed as \`-\` lines.
Make sure you mark all new or modified lines with \`+\`.
Don't leave out any lines or the diff patch won't apply correctly.

Indentation matters in the diffs!

Start a new hunk for each section of the file that needs changes.

Only output hunks that specify changes with \`+\` or \`-\` lines.
Skip any hunks that are entirely unchanging \` \` lines.

Output hunks in whatever order makes the most sense.
Hunks don't need to be in any particular order.

Hunks should have a context of 3 lines before and after the change, which match exactly from the source.

When editing a function, method, loop, etc use a hunk to replace the *entire* code block.
Delete the entire existing version with \`-\` lines and then add a new, updated version with \`+\` lines.
This will help you generate correct code and correct diffs.

To move code within a file, use 2 hunks: 1 to delete it from its current location, 1 to insert it in the new location.

You should attempt to apply one hunk at a time, as an error in one hunk can cause the entire patch to fail to apply.
`;

export class PatchingAgent extends BaseAgent {
  name = "Patcher";
  description = `This agent is prepared to work on the codebase by leveraging patches`;

  constructor(context: AgentContext) {
    super(context);

    this.setModelPreferences([
      { model: Models.anthropic.Sonnet4, provider: "anthropic" },
      {
        model: Models.openai.GPT_41_Mini,
        provider: "openai",
      },
    ]);
  }

  async getInitialMessages(userInput: string) {
    return [
      {
        role: "system",
        content: `${BASE_PROMPT}

        ${systemReminder}

        Specialization: Patcher Agent, ${this.description}

        # Language Server Integration:
        Use ycmd tools (ycmdDiagnostics, ycmdCompletion, ycmdRefactor, ycmdGoTo) to get error diagnostics, code completions, refactor symbols, and navigate definitions before making changes.
        This helps ensure accurate modifications and can suggest fixes for compilation errors.

        IF you fail twice to patch a file, you may switch using writeFileChunk to rewrite the whole file.

        If you need to know about a type, you should use the ycmd completion tool to discovery the properties, and fallback to reading the source files if the ycmd tools are not available.

        # Debugging Workflow
        If a build or test command fails due to compilation errors:

        ALWAYS start by running ycmdDiagnostics on the file with errors to get a structured list of issues.

        Address the errors one at a time, from top to bottom.

        For each error, use ycmdGoTo to find the correct definition or readFile on the relevant source file to understand the correct implementation.

        If an error is related to properties not being named correctly, you can use ycmdCompletion to get suggestions for the correct property or method names.

        Apply a small, targeted patch to fix only that single error.

        After every 2-3 fixes, run ycmdDiagnostics again to confirm progress.

        # Test Writing Workflow
        When writing tests, you proceed incrementally, writing one test, verifying it compiles and works before moving on to the next test.
        You ALWAYS get to a stable state with tests compiling / running before adding the next test.
        When writing tests, you never change the source code to pass the test, you always change the test to match the existing source code.

        `,
      },
      { role: "user", content: userInput },
    ] as Message[];
  }
}
