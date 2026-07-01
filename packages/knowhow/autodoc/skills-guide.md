# Skills Guide (Knowhow CLI)

## 1) What skills are

**Skills** are reusable instruction bundles stored in files named **`SKILL.md`**.  
When a user asks for something that matches a skill’s **name**, Knowhow automatically loads that skill’s full markdown content and provides it as context to the agent.

A skill file is ordinary markdown, but it includes **frontmatter metadata** at the top:

- `name` — the skill trigger name (must match what users say)
- `description` — a short summary shown during “skill discovery”
- **Body** — the complete instructions the agent should follow

**File naming rule:** the plugin scans for files literally named **`SKILL.md`** (case-sensitive on most systems).

---

## 2) How skills work

### What the SkillsPlugin does
Knowhow’s **Skills Plugin** (`src/plugins/SkillsPlugin.ts`) performs three steps:

1. **Load config**
   - Reads `.knowhow/knowhow.json` via `getConfig()`
   - Looks for a `skills` array:
     ```json
     {
       "skills": ["some/directory", "..."]
     }
     ```

2. **Scan skill directories**
   - For each directory in `skills`, it:
     - Expands `~` to `process.env.HOME`
     - Recursively searches all subdirectories
     - Finds files named `SKILL.md`
     - Reads each file and extracts frontmatter `name` + `description`
   - Each skill is indexed as:
     - `name`
     - `description`
     - `filePath`

3. **Match user input to skills**
   - If the user prompt contains a skill name **as a substring** (case-insensitive), e.g.:
     - user: “Please do a **database migration**”
     - skill name: “database migration”
   - Then the plugin loads the **entire SKILL.md content** for every matched skill.

### What gets injected into the agent
For each matched skill, the plugin returns a block like:

```md
## Skill: <skill.name>
File: <skill.filePath>

<full SKILL.md content>
```

If multiple skills match, the plugin provides multiple blocks.

### Skill discovery behavior (no matches)
If **no** skill name is found in the user prompt, the plugin returns a **summary**:

- “Available skills:”
- Each skill listed as:
  - `- <name> (<filePath>): <description>`
- Plus a reminder:
  - “To use a skill, reference its name in your request and I will load the full instructions.”

So users can learn what skills exist by asking something that doesn’t match any skill name.

---

## 3) `SKILL.md` format

A skill file must follow this structure:

```md
---
name: <skill name>
description: <short description>
---

<instructions and examples here>
```

### Frontmatter rules (important)
From the plugin’s `parseFrontmatter()` implementation:

- It expects frontmatter to begin at the **start** of the file with:
  - `---` then newline
- It captures content until the next `---`
- Each frontmatter line is parsed as:
  - `key: <value>`
- If a value contains `:` characters, they are preserved because the parser:
  - splits on the first `:`
  - rejoins the rest

### Body content
Everything after the closing `---` is treated as the **full skill instructions** and gets injected into the agent context.

---

## 4) Configuring skills

Add a `skills` array in your `knowhow.json`:

### Example: local project config
`.knowhow/knowhow.json`
```json
{
  "skills": [
    ".knowhow/skills",
    "skills"
  ]
}
```

**Notes**
- Directories are scanned **recursively**
- Every `SKILL.md` found contributes a skill
- Unreadable/missing directories are ignored

### Path shorthand
The plugin supports `~`:
- `~/some/path` → resolved using `process.env.HOME`

---

## 5) Skill discovery

If a user’s request does **not** include any configured skill names (as substring matches), the agent will receive the plugin’s “Available skills” summary.

To get a skill loaded, the user must:
- mention the skill name **in the request text**
- in any casing (the match is case-insensitive)

**Tip:** choose `name` strings that users will naturally include verbatim (e.g., “code review”, “deploy”, “database migration”).

---

## 6) Writing effective skills (best practices)

### A) Use a clear, human-friendly `name`
- Pick wording users are likely to type.
- Keep it consistent and not overly broad.
- Avoid punctuation-heavy names; they are harder to match reliably.

### B) Put the most important instructions early
Agents work better when:
- prerequisites and scope are near the top
- steps are structured and scannable

### C) Use step-by-step structure
Prefer numbered lists, short sections, and checklists.

### D) Include code examples and templates
If the skill involves commands, configs, queries, or scripts:
- provide copy/paste examples
- show placeholders clearly (e.g., `<SERVICE>`, `<ENV>`)

### E) Handle edge cases explicitly
Include a section like:
- “Edge cases / when to stop”
- “Common pitfalls”
- “If you lack access/inputs, ask these questions”

### F) Match the plugin’s matching behavior
Because the plugin triggers when:
- `userPrompt.toLowerCase().includes(skill.name.toLowerCase())`

…avoid names that require exact formatting users won’t reproduce.

**Example:** If you name a skill `DB migrate`, users may type `database migration` instead and won’t match. Prefer a common phrase.

---

## 7) Example skills (complete `SKILL.md` files)

Below are **complete** examples you can place in directories scanned by your `skills` config.

### Example A: `deploy` skill

**File:** `.knowhow/skills/deploy/SKILL.md` (path arbitrary; filename must be `SKILL.md`)
```md
---
name: deploy
description: Deploy an application safely using a repeatable, checklist-driven process (plan, validate, release, verify, rollback).
---

# Deploy Skill

Use this skill to guide a safe deployment for a typical web/service app. Adapt steps to your stack (Kubernetes, systemd, Heroku, Docker Compose, etc.).

## Inputs to request (if missing)
If the user did not provide these, ask:
1. Deployment target (e.g., `staging`, `production`, a specific environment name)
2. Release artifact (e.g., docker image tag, build number, commit SHA)
3. Deployment method/tooling (e.g., Helm, kubectl, Terraform, SSH scripts, GitHub Actions)
4. Any required approvals or maintenance windows
5. Current rollback strategy

## Step-by-step deployment process

### 1) Plan & confirm scope
- Identify what will change:
  - code changes
  - config changes
  - infrastructure changes
- Confirm:
  - target environment
  - expected downtime (if any)
  - dependencies (databases, queues, caches)

### 2) Pre-deploy validation
- Verify health of the current environment:
  - uptime/error rates
  - logs for obvious incidents
- Confirm required secrets/configs exist for the target environment.
- If migrations are involved, identify:
  - migration ordering and whether they are backward-compatible

### 3) Choose a release strategy
Pick one:
- **Blue/Green** (preferred for minimal disruption)
- **Rolling** (common for Kubernetes/stateful services)
- **Canary** (gradual traffic shift)
- **Restart-based** (simpler but higher risk)

State which one you will use and why.

### 4) Execute deployment
Provide the exact commands/steps for the user’s stack.

#### Kubernetes/Helm template
```bash
# Example variables:
# RELEASE=<release-name>
# NAMESPACE=<namespace>
# CHART=<chart-dir-or-name>
# IMAGE_TAG=<tag>

helm upgrade --install "$RELEASE" "$CHART" \
  --namespace "$NAMESPACE" \
  --set image.tag="$IMAGE_TAG"
```

#### Docker Compose template
```bash
# Example:
# IMAGE_TAG=<tag>
export IMAGE_TAG="$IMAGE_TAG"

docker compose pull
docker compose up -d --no-deps
```

### 5) Post-deploy verification (must-do)
After the deploy completes:
- Check application health endpoints
- Confirm critical workflows:
  - login/session
  - primary read/write operations
  - queue consumers / background jobs (if applicable)
- Monitor logs for errors for at least **10–15 minutes** (or the team’s standard)

### 6) Communicate & close out
Report:
- what changed
- verification results
- link(s) to release notes/build artifacts
- next steps (if any)

## Rollback plan (include before executing)
Before the deployment, define rollback triggers:
- error budget exceeded
- health checks failing
- latency spike
- incident detected

Provide concrete rollback actions, e.g.:
- Helm rollback to previous revision:
  ```bash
  helm rollback "$RELEASE" <revision-number> --namespace "$NAMESPACE"
  ```
- Or redeploy prior image tag.

## Edge cases / stop conditions
- Stop and ask questions if:
  - you don’t know the release artifact
  - there are pending schema changes without a migration plan
  - rollback strategy is unclear
- If migrations exist, consider ordering:
  1) deploy backward-compatible code
  2) apply migrations
  3) deploy forward code

## Output format (what to respond with)
When executing, respond with:
1. Deployment plan summary
2. Exact steps/commands
3. Verification checklist
4. Rollback instructions and triggers
```

---

### Example B: `code review` skill

**File:** `.knowhow/skills/code-review/SKILL.md`
```md
---
name: code review
description: Perform a structured code review with a checklist, risk assessment, and actionable feedback.
---

# Code Review Skill

Use this skill to review a code change (PR/diff). Provide feedback that is:
- specific
- actionable
- prioritized by risk/impact

## Inputs to request (if missing)
Ask for:
1. Language/framework
2. Repo context (where relevant)
3. The diff/patch (or key files)
4. Purpose of change (bug fix? feature?)
5. Constraints (performance/security/compliance)

## Review workflow

### 1) High-level summary
- What does the change aim to do?
- What files/components are most impacted?

### 2) Checklist review (use this order)

#### Correctness
- Does the code match the intended behavior?
- Are there off-by-one / null / boundary cases?
- Are errors handled and surfaced appropriately?

#### Security
- Input validation and sanitization
- Authz/authn checks
- Secrets handling (no secrets in logs)
- Injection risks (SQL/command/template)
- CSRF/XSS risks (web)

#### Performance
- Hot paths and unnecessary allocations
- N+1 queries / repeated work
- Unbounded loops or expensive operations

#### Maintainability
- Naming clarity
- DRY vs duplication
- Testability (pure functions, seams for mocks)
- Code structure and separation of concerns

#### Observability
- Useful logs (without leaking sensitive data)
- Metrics/events where appropriate
- Error logs include sufficient context

#### Testing
- Unit tests for logic
- Integration tests for boundaries
- Regression tests for bug fixes
- Edge cases covered

### 3) Risk assessment (must include)
Create a short risk table:

| Area | Risk level (Low/Med/High) | Why | Suggestion |
|------|------------------------------|-----|------------|

### 4) Actionable feedback
For each issue:
- Explain why it’s a problem
- Provide a suggested change (or example)
- Label severity: **Must-fix / Should-fix / Nice-to-have**

### 5) Questions for the author (if needed)
Ask clarifying questions only when assumptions would otherwise be unsafe.

## Example response structure
Return your output using:

1. Summary
2. Review (grouped by Correctness/Security/Performance/etc.)
3. Risk table
4. Must-fix / Should-fix items (with suggestions)
5. Tests recommendations
6. Questions (if any)

## Edge cases / constraints
- If the diff is incomplete, ask for the missing portions instead of guessing.
- If you cannot assess security due to missing auth context, explicitly state that limitation and request needed info.
```

---

### Example C: `database migration` skill

**File:** `.knowhow/skills/database-migration/SKILL.md`
```md
---
name: database migration
description: Plan and execute database migrations with safety (backward compatibility, ordering, verification, rollback).
---

# Database Migration Skill

Use this skill to guide migrations for relational databases (Postgres/MySQL/etc.) with production-safety principles.

## Inputs to request (if missing)
Ask:
1. Database type/version (e.g., Postgres 14)
2. Migration type:
   - schema change
   - data backfill
   - index changes
   - constraints
3. Migration tool (e.g., Flyway, Liquibase, Alembic, Prisma Migrate, custom scripts)
4. Environment (staging vs production)
5. Constraints:
   - availability requirements
   - expected load window
   - maximum acceptable migration duration
6. Whether the app code will be deployed concurrently

## Safety principles (follow in order)
1. **Backward compatible first**
2. Prefer **expand → migrate → contract**
3. Keep transactions short when possible
4. Avoid long locks (reindex/alter carefully)
5. Validate before/after with queries

## Migration plan template

### Step 1) Understand current state
- Identify current schema
- Identify dependencies:
  - foreign keys
  - views
  - triggers
  - application queries

### Step 2) Define the target
- What new columns/tables/indexes/constraints are desired?
- What data transformations are needed?

### Step 3) Plan expand/migrate/contract (example)
#### Expand (backward compatible)
- Add new nullable column(s)
- Add new tables
- Add indexes concurrently (if supported)
- Do **not** add NOT NULL or strict constraints yet

#### Migrate (populate data)
- Backfill in batches
- Ensure idempotency
- Rate limit if needed

#### Contract (enforce invariants)
- Set NOT NULL after backfill completion
- Add constraints
- Drop old columns only after code is updated and verified

### Step 4) Order of deployments
If app code changes too, use:
1. Deploy backward-compatible code
2. Run expand migration
3. Deploy code that writes new format (optional)
4. Run data backfill
5. Deploy forward code
6. Run contract migration

## Concrete examples

### Example: Backfill a new column in batches (SQL pseudocode)
```sql
-- Add column first (expand)
ALTER TABLE users ADD COLUMN display_name TEXT;

-- Backfill in batches (migrate)
-- Repeat until affected_rows = 0
UPDATE users
SET display_name = username
WHERE display_name IS NULL
LIMIT 10000;
```

> If your DB doesn’t support `LIMIT` on UPDATE, use a CTE or batch-selection strategy.

### Example: Index creation carefully (Postgres-style)
- Create index concurrently to reduce locking:
```sql
CREATE INDEX CONCURRENTLY users_display_name_idx
ON users (display_name);
```

## Verification checklist (before and after)
### Before
- Confirm migration has a dry run plan
- Confirm rollback method exists
- Record:
  - row counts
  - min/max timestamps
  - key aggregates

### After
- Re-run invariants:
  - null counts for new required columns
  - foreign key validity checks
- Check application health
- Monitor errors/latency for the migration window

## Rollback strategy
Define one of:
- **Down migration** (if safe/possible)
- **Reverse via feature flag**
- **Recreate old schema** (last resort)
- **Data rollback** (restore from snapshot/backups)

State rollback triggers explicitly (e.g., health checks failing, lock contention too high).

## Edge cases
- If adding NOT NULL column without default to a large table:
  - do it via expand/migrate/contract
- If updating huge datasets:
  - batch and monitor impact
- If migrations aren’t idempotent:
  - redesign to be re-runnable safely
```

---

## 8) Global skills

If you want skills to be available **across projects**, store them in:

**`~/.knowhow/skills/`**

Then include that directory in your `skills` configuration (either in global config or project config, depending on how your setup uses `knowhow.json`).

### Recommended structure
```text
~/.knowhow/skills/
  deploy/
    SKILL.md
  code-review/
    SKILL.md
  database-migration/
    SKILL.md
```

### Example `knowhow.json` (point to global + local)
```json
{
  "skills": [
    "~/.knowhow/skills",
    ".knowhow/skills"
  ]
}
```

---

## Quick checklist for creating a new skill

1. Create a folder (any name) and place a file named **`SKILL.md`**
2. Add frontmatter at the top:
   - `name: ...`
   - `description: ...`
3. Write clear, step-by-step instructions in the body
4. Include examples and edge cases
5. Add the directory to the `skills` array in `.knowhow/knowhow.json`
6. Test by prompting the agent using the exact skill name phrase (case-insensitive substring match)

If you want, tell me your workflow (tools/stack) and I can generate a tailored set of `SKILL.md` templates for your team.