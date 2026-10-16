# Click Grid

Complete the click-grid exercise shown in the browser. Use screenshots and the computer-use tools only: visually locate the prominently displayed **Requested number**, then click that numbered circle on the canvas. Do not infer or call the benchmark HTTP APIs. Continue until all 10 rounds are complete; misses do not advance the sequence. The nodes are stationary and the requested node is not visually highlighted.

Before every click, take one tight screenshot around the candidate with `scale=2`, `grid=false`, and `crosshair={x,y}` at the proposed click coordinate. Commit only when (1) the printed number exactly matches the Requested number and (2) the enlarged image shows the blue aiming ring fully contained and concentric inside the node circle, with equal margin above/below and left/right. If any part of the blue ring crosses or approaches the node outline, correct the point and preview once more. Never accept a point merely because the crosshair is somewhere inside or near the circle. Do not commit based only on extrapolated row or column arithmetic. Reuse the stationary board image for search, but always perform this final enlarged aim preview before the irreversible click.

Do not call, inspect, or infer from the benchmark HTTP API (`/api/*`), do not inspect page source, DOM, JavaScript, or developer tools, and do not use scripts or accessibility/coordinate extraction to solve it. Interact visually with screenshots and normal computer mouse clicks only.

When finished, print exactly one `BENCHMARK_RESULT:` line containing a JSON object with the final result visible on screen (including hits, misses, and completion status).
