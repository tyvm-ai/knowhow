```md
# Skills Guide (Knowhow CLI)

## 1) What skills are

**Skills** are reusable instruction sets stored in files named **`SKILL.md`**.

When a user’s request mentions the *skill name*, Knowhow loads the matching **full `SKILL.md` content** and injects it into the agent context, so the agent follows your standardized procedure (checklists, commands, rollback plans, etc.).

Each `SKILL.md` file must include **frontmatter metadata** at the top so Knowhow can identify and match the skill.

---

## 2) How skills work (SkillsPlugin behavior)

Knowhow’s **Skills Plugin** (`src/plugins/SkillsPlugin.ts`) works as follows:

1. **Reads configuration** via `getConfig()`.
2. Loads the configured **skills directories** from `knowhow.json` under a `skills` array.
3. **Recursively scans** each directory:
   - Searches for any file named **exactly** `SKILL.md`
   - Uses recursive directory traversal (`readdir` + recursion)
4. **Parses frontmatter** from each `SKILL.md`:
   - Frontmatter must start with:
     ```md
     ---
     ...
     ---
     ```
   - Each frontmatter line is parsed by splitting on the first `:` to extract fields like:
     - `name: ...`
     - `description: ...`
5. **Matches skills to the user prompt** using substring logic:
   ```ts
   userPrompt.toLowerCase().includes(skill.name.toLowerCase())
   ```
   **Important implication:** matching is **not exact**—it uses `includes()`.
   - If your skill `name` is `deploy`, it may trigger on: “deploy”, “redeploy”, “deployment”, “deploying”.

6. **If one or more skills match**:
   - The plugin reads each matched `SKILL.md` file
   - It injects content into the agent context in a wrapper:
     - Prepends:
       - `## Skill: <name>`
       - `File: <filePath>`
     - Then includes the **entire `SKILL.md` file content**.

7. **If no skill name matches**:
   - The plugin returns a **skills discovery summary** listing each discovered skill:
     - skill name
     - file path
     - description
   - This summary is injected as context so the user can reference the correct skill name.

---

## 3) `SKILL.md` format

A `SKILL.md` file must contain:

### Required frontmatter fields
- `name` — the skill name (must match what users are likely to say; see substring matching)
- `description` — a short description shown during discovery

### Body content
Everything after frontmatter is the full instruction set. The plugin injects the **entire file** into context when the skill matches.

### Full template
```md
---
name: <skill name>
description: <short description>
---

# <Section title>

Step-by-step instructions...

## Examples
...

## Edge cases / gotchas
...
```

### Frontmatter example
```md
---
name: deploy
description: Deploy an application safely with verification and rollback steps.
---
```

---

## 4) Configuring skills

Add your skill directories to `knowhow.json` using a `skills` array.

Example:
```json
{
  "plugins": {
    "skills": true
  },
  "skills": [
    "./skills",
    "~/.knowhow/skills"
  ]
}
```

Notes:
- Paths may be relative or absolute.
- `~` is expanded using the user’s home directory (`process.env.HOME`).
- The plugin scans **recursively**, so `./skills/<any-folders>/SKILL.md` is fine.

---

## 5) Skill discovery (when no skill matches)

If the user request does **not** contain any skill name, Knowhow injects a context item like:

- **`Available skills:`**
  - `- <name> (<filePath>): <description>`

…and then suggests the user reference a skill by name.

**Author takeaway:** choose `name` values that users will naturally include in their requests.

---

## 6) Writing effective skills (best practices)

### A) Use clear, natural `name` values
Because matching is substring-based (`includes()`), avoid names that are likely to match unintentionally.

- ✅ Good: `deploy`, `code review`, `database migration`
- ⚠️ Risky: `run`, `update`, `manage`, `test` (may trigger on many unrelated phrases)

### B) Write step-by-step instructions
Use numbered/structured steps with decision points, e.g.:
- “If you have X, do A; otherwise do B.”

### C) Include copy/paste-ready code examples
Provide exact commands/snippets with clear placeholders:
- `APP_NAME`, `NAMESPACE`, `RELEASE_TAG`, `MIGRATION_NAME`, etc.

### D) Cover edge cases and failure modes
Add sections such as:
- Common failures
- Rollback plan
- Verification steps
- What to do if an environment variable is missing
- What to do if a deployment health check fails

### E) Make the “success criteria” explicit
Tell the agent what “done” means:
- expected outputs
- checklist completion
- verification queries/commands that must pass

---

## 7) Example skills (complete `SKILL.md` files)

Below are complete, copyable examples. Save each as **`SKILL.md`** inside a directory included by your `skills` config.

---

### Example 1: `deploy` skill

**File:** `./skills/deploy/SKILL.md`
```md
---
name: deploy
description: Deploy an application safely with verification and rollback steps.
---

# Deploy Skill

Use this checklist to deploy an application reliably. Tailor steps to your stack (Node/Python/Go/etc.), but keep the flow the same.

## 1) Pre-deploy verification
1. Confirm the target environment:
   - `dev`, `staging`, or `production`
2. Confirm the artifact/version to deploy:
   - Commit SHA or release tag
3. Confirm required secrets/config exist:
   - API keys
   - database connection strings
   - environment variables required by the app

## 2) Readiness checks
1. Check current health:
   - Ensure the service is reachable
2. Check recent errors:
   - Look for failing pods/services/jobs
3. Estimate downtime expectations:
   - Can deployments be zero-downtime?

## 3) Deploy procedure (generic)
1. Backup/ensure rollback readiness
   - If using containers: ensure you can redeploy the previous image tag
2. Deploy the new artifact
   - Update deployment manifest / pipeline configuration
3. Apply changes
   - Run CI/CD or execute deployment commands (examples below)

### Example: Kubernetes rollout
```bash
kubectl config use-context <context>
kubectl set image deployment/<app> <container>=<image>:<tag> -n <namespace>
kubectl rollout status deployment/<app> -n <namespace> --timeout=5m
```

### Example: Docker Compose
```bash
export IMAGE_TAG="<tag>"
docker compose pull
docker compose up -d
docker compose ps
```

## 4) Post-deploy verification
1. Health endpoints
   - Verify `/health` or equivalent returns 200
2. Smoke tests
   - Login flow (if applicable)
   - Minimal read/write operation
3. Check logs for startup errors
   - Look for crashes, migrations failing, missing env vars

## 5) Rollback plan (define before you need it)
If verification fails:
1. Identify the previous version/image
2. Roll back
   - Kubernetes:
     ```bash
     kubectl rollout undo deployment/<app> -n <namespace>
     kubectl rollout status deployment/<app> -n <namespace> --timeout=5m
     ```
   - Compose/Docker:
     ```bash
     export IMAGE_TAG="<previous-tag>"
     docker compose up -d
     ```

## 6) Report the outcome
Provide:
- Environment name
- Version/artifact deployed
- Verification results (what succeeded)
- Any follow-up tasks or incidents
```

---

### Example 2: `code review` skill (checklist)

**File:** `./skills/code-review/SKILL.md`
```md
---
name: code review
description: Perform a structured code review with correctness, security, and style checks.
---

# Code Review Skill

Use this checklist for reviewing PRs or patches. If you lack context (language/framework/test coverage), ask targeted questions.

## 0) First pass (understand)
1. What is the change trying to accomplish?
2. Does the change align with the existing codebase patterns?
3. Are there any new dependencies or risky integrations?

## 1) Correctness & behavior
- [ ] All intended behaviors are implemented
- [ ] Edge cases are handled (empty input, nulls, timeouts, boundaries)
- [ ] Error handling is consistent and actionable
- [ ] Tests exist and cover the changed logic
- [ ] Performance implications are understood (e.g., new loops, DB queries)

## 2) Security review
- [ ] Input validation is present where needed
- [ ] Secrets are not logged or exposed
- [ ] AuthZ/AuthN is enforced (no missing permission checks)
- [ ] Injection risks are mitigated (SQL/command/template)
- [ ] File/path handling is safe (no traversal)

## 3) API / interface correctness
- [ ] Contracts are updated consistently (types, docs, callers)
- [ ] Backwards compatibility is preserved if required
- [ ] Status codes / error shapes are stable

## 4) Code quality & maintainability
- [ ] Naming is clear and consistent
- [ ] Complexity is reasonable; no deeply nested logic
- [ ] Duplicated logic is refactored when appropriate
- [ ] Comments explain “why”, not “what”

## 5) Tests
- [ ] Unit tests cover core logic
- [ ] Integration tests cover boundaries (DB/network/interfaces)
- [ ] Test data is minimal and deterministic
- [ ] Flaky tests are avoided

## 6) Documentation
- [ ] README or inline docs updated if user-facing behavior changed
- [ ] Migration notes added when needed
- [ ] Examples updated

## 7) Final response format
Return the review as:

1. Summary of key changes
2. Must-fix issues (severity: critical/high)
3. Should-fix issues (medium/low)
4. Nice-to-have improvements
5. Suggested diffs (if possible) or questions for the author
```

---

### Example 3: `database migration` skill

**File:** `./skills/db-migration/SKILL.md`
```md
---
name: database migration
description: Plan and execute a safe database migration with validation and rollback.
---

# Database Migration Skill

Use this playbook to design and run a database migration safely in real environments.

## 1) Clarify migration intent
Answer:
1. What schema change is required? (add/rename/remove column/table, indexes, constraints)
2. Does it require data backfill?
3. Is it online/zero-downtime or will it incur downtime?

## 2) Safety prerequisites
- Ensure you have:
  - A backup strategy (automated snapshot or external backup)
  - A way to rollback (or a forward-fix plan if rollback is unsafe)
- Confirm:
  - Migration tool (e.g., Alembic, Flyway, Liquibase, Rails)
  - Database engine (Postgres/MySQL/etc.)
  - Staging validation environment mirrors production settings

## 3) Use a safe migration pattern
Common safe approach for risky changes:
1. Additive first
   - Add new columns/constraints as nullable or non-enforcing
2. Backfill
   - Populate existing rows with a controlled job
3. Validate
   - Confirm data correctness (counts, null rates, invariants)
4. Switch reads/writes
   - Update application code to use the new schema
5. Finalize
   - Tighten constraints (NOT NULL, FK constraints, unique indexes)
6. Clean up
   - Remove old columns after a safe window

## 4) Concrete checklist

### Schema change checklist
- [ ] Avoid dropping columns/constraints in the first pass if downtime is not acceptable
- [ ] Prefer “expand/contract” patterns when possible
- [ ] Index changes are planned to avoid locking storms

### Backfill checklist
- [ ] Batch updates (avoid locking large tables)
- [ ] Add progress logging
- [ ] Validate after backfill (row counts, distribution checks)

### Verification checklist
- [ ] Run migration in staging first
- [ ] Confirm application health (no errors on startup)
- [ ] Verify critical queries

### Rollback checklist
Choose one:
- [ ] True rollback supported by the migration tool
- [ ] Or forward-only correction plan (recommended if true rollback is unsafe)

## 5) Example SQL patterns (Postgres)

### Add nullable column + backfill + enforce NOT NULL
```sql
-- 1) Expand: add column as nullable
ALTER TABLE users ADD COLUMN email_normalized text;

-- 2) Backfill in a controlled way (example)
UPDATE users
SET email_normalized = lower(email)
WHERE email_normalized IS NULL;

-- 3) Validate before enforcing (example checks)
SELECT count(*) FROM users WHERE email_normalized IS NULL;

-- 4) Contract: enforce constraint
ALTER TABLE users ALTER COLUMN email_normalized SET NOT NULL;
```

### Create index with lower blocking risk (conceptual)
```sql
-- If supported, use CONCURRENTLY to reduce blocking
CREATE INDEX CONCURRENTLY idx_users_email_normalized
ON users(email_normalized);
```

## 6) What to output as the agent response
Provide:
- Migration plan (phases)
- Estimated risk level and why
- Exact commands (tool-specific)
- Validation queries/tests
- Rollback or forward-fix plan
- Execution order and required application deploy timing
```

---

## 8) Global skills

To reuse skills across multiple projects, store them in:

**`~/.knowhow/skills/`**

Then ensure your `knowhow.json` includes that directory in the `skills` array, for example:
```json
{
  "skills": [
    "~/.knowhow/skills"
  ]
}
```

Recommended structure (nested organization is fine because scanning is recursive):
```text
~/.knowhow/skills/
  deploy/
    SKILL.md
  code-review/
    SKILL.md
  db-migration/
    SKILL.md
```

The plugin does not require the folder name to match the skill name—only the `SKILL.md` frontmatter `name` matters.

---

## Summary checklist (quick reference)

- ✅ Name skill file: **`SKILL.md`**
- ✅ Add frontmatter at the top:
  - `name: ...`
  - `description: ...`
- ✅ Write clear step-by-step instructions + examples
- ✅ Include edge cases / rollback / verification
- ✅ Configure directories in `knowhow.json` under `skills`
- ✅ For global reuse, use `~/.knowhow/skills/`
```