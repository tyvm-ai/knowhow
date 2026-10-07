# UI Basics (Computer Use)

Use the visible browser GUI to complete this exercise. Native accessibility inspection/actions,
mouse, and keyboard are allowed. **Do not use direct HTTP requests, JavaScript execution, DOM
inspection, filesystem APIs, or benchmark API endpoints to complete the task.**

Perform these exact steps in order:

1. Click the top navigation tab labeled **Profile**. Confirm the main heading changes to Profile.
2. Click the top navigation button labeled **Menu ▾**, then click its **Settings** menu item. Confirm the main heading changes to Settings.
3. Click the top navigation tab labeled **Home**. The Registration form should be visible again.
4. Set every Registration form control exactly: Full name `Alex Rivera`; Email address
   `alex.rivera@example.com`; Country `United States`; **Subscribe to weekly updates** checked;
   Preferred contact **Email** selected.
5. Click **Sort descending** once. Verify the visible order is `Peach`, `Cherry`, `Banana`, `Almond`.
6. Drag the center of the blue **Blue card** into the center of **Drop target**. Verify the target text changes to **Blue card received**.
   If native drag events are unavailable, the documented keyboard alternative is to focus **Blue card** and press Enter once.
7. Click **Submit completed task**. Verify the page status reads **Complete — all tasks passed**.

The task list on the left should show every item completed. If you need to reset, refresh the page (or stop and restart the local server). The server stores submissions in memory and exposes `GET /health` and `GET /api/results` for the benchmark runner.
