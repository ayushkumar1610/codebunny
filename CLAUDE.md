# CLAUDE.md — CodeBunny AI Agent Guide

This file provides guidance for AI assistants (Claude, etc.) working in this repository.

---

## Project Overview

**CodeBunny** (package name: `clickup-bunny`) is a Node.js automation agent that bridges ClickUp task management with AI-powered code implementation. When a ClickUp task is assigned to the agent, it:

1. **Plans** — Reads the repository and generates a technical implementation plan, posted as a ClickUp comment.
2. **Builds** — Implements the plan in an isolated git worktree, pushes a branch, and opens a draft PR/MR on GitHub or GitLab.

The AI that performs planning/building is a configurable external CLI tool (`opencode`, `claude`, or `gemini`), spawned as a child process.

---

## Repository Structure

```
codebunny/
├── src/
│   ├── index.js                  # Express server entry point (port 3000)
│   ├── config/
│   │   └── opencode.json         # OpenCode CLI config (formatter: false)
│   ├── routes/
│   │   └── tasks.js              # POST /tasks/process — manual task trigger
│   ├── services/
│   │   ├── agentService.js       # Prompt building & agent CLI spawning
│   │   ├── clickupService.js     # ClickUp REST API client
│   │   ├── dbService.js          # PostgreSQL client (agent_sessions table)
│   │   ├── gitProviderService.js # GitHub/GitLab PR/MR creation via axios
│   │   ├── gitService.js         # Git clone, branch, worktree operations (simple-git)
│   │   ├── queueService.js       # Planning & building queue orchestration
│   │   └── taskProcessor.js      # Top-level pipeline orchestrator
│   ├── utils/
│   │   └── logger.js             # Winston logger (console + file)
│   └── webhooks/
│       └── clickup.js            # Webhook receiver with HMAC-SHA256 verification
├── scripts/
│   └── setupWebhook.js           # One-time ClickUp webhook registration
├── .env.example                  # All configurable environment variables
├── Dockerfile                    # node:22-alpine image
└── docker-compose.yml            # PostgreSQL 15 + agent service
```

---

## Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 (Alpine in Docker) |
| HTTP framework | Express 4 |
| Git operations | simple-git 3 |
| Database | PostgreSQL 15 (via `pg` driver) |
| HTTP client | axios 1 |
| Logging | Winston 3 + chalk 4 |
| Agent CLI | opencode-ai / claude / gemini (external binary) |
| Dev tooling | nodemon, Jest |

---

## Available Commands

```bash
npm start             # Production (node src/index.js)
npm run dev           # Development with nodemon auto-reload
npm run setup-webhook # Register ClickUp webhook (run once)
npm test              # Jest test suite
```

**Docker:**
```bash
docker-compose up     # Start PostgreSQL + agent
docker-compose down   # Stop services
```

---

## Environment Variables

Copy `.env.example` to `.env` and configure. Key variables:

| Variable | Description |
|---|---|
| `PORT` | HTTP server port (default: 3000) |
| `CLICKUP_API_TOKEN` | ClickUp personal API token |
| `CLICKUP_TEAM_ID` | ClickUp workspace/team ID |
| `CLICKUP_WEBHOOK_SECRET` | HMAC secret for webhook verification |
| `DATABASE_URL` | PostgreSQL connection string |
| `REPOS_BASE_DIR` | Directory to clone repos into (default: `./repos`) |
| `GIT_USER_NAME` / `GIT_USER_EMAIL` | Git author identity |
| `GITHUB_TOKEN` / `GITLAB_TOKEN` | Tokens for authenticated cloning and PR creation |
| `GITHUB_DEFAULT_OWNER` | Fallback GitHub org/user if not in task |
| `AGENT_CLI` | Which agent to spawn: `opencode`, `claude`, or `gemini` |
| `OPENCODE_PATH` | Path to opencode binary |
| `OPENCODE_MODEL` | Model to use with opencode |
| `AUTO_CREATE_PR` | Whether to auto-open draft PRs (default: true) |
| `MAX_CONCURRENT_WORKTREES` | Parallel build workers (default: 3) |
| `BRANCH_PREFIX_STRATEGY` | `full` (`feature/CU-{id}-{slug}`) or `short` (`feature/CU-{id}`) |

---

## Core Architecture: Two-Phase Pipeline

### Phase 1 — Planning (single-threaded)
1. Webhook arrives → HMAC verified → `processTaskAssignment(taskId)` called
2. Session created in DB with `status = 'queued'`
3. Planning queue picks it up; spawns agent CLI in **read-only** mode at repo root
4. Agent generates a technical plan (markdown)
5. Plan saved to DB (`technical_plan` column), posted as ClickUp comment
6. Status updated to `'planned'`

### Phase 2 — Building (concurrent, up to `MAX_CONCURRENT_WORKTREES`)
1. Building queue picks `status = 'planned'` sessions
2. Creates isolated git worktree at `repos/<owner>__<repo>/__worktrees/<taskId>`
3. Spawns agent CLI with the technical plan as context; agent implements code changes
4. Branch pushed to remote
5. Draft PR/MR created on GitHub/GitLab
6. Session status → `'completed'` (or `'failed'` on error)

### Queue Safety
- `FOR UPDATE SKIP LOCKED` SQL used to safely dequeue sessions across concurrent workers
- Sessions can be manually triggered via `POST /tasks/process` with `{ "taskId": "..." }`

---

## Database Schema

Table: **`agent_sessions`**

| Column | Type | Description |
|---|---|---|
| `session_id` | UUID PK | Auto-generated session identifier |
| `issue_id` | VARCHAR | ClickUp task ID |
| `status` | VARCHAR | `queued` → `planning` → `planned` → `building` → `completed` / `failed` |
| `technical_plan` | TEXT | Markdown plan from planning agent |
| `token_utilised` | INTEGER | Token usage tracking |
| `started_at` | TIMESTAMP | Session creation time |
| `end_at` | TIMESTAMP | Session completion time |

Database connection is optional — if `DATABASE_URL` is unset the app continues with a warning.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Returns `{ status: "ok", ts: <timestamp> }` |
| `POST` | `/webhooks/clickup` | ClickUp webhook receiver (requires `X-Signature` header) |
| `POST` | `/tasks/process` | Manual task trigger: `{ taskId: "abc123" }` |

---

## Git Workflow Conventions

- **Repository storage:** `./repos/<owner>__<repo-name>/`
- **Worktree storage:** `./repos/<owner>__<repo>/__worktrees/<taskId>/`
- **Branch naming:**
  - Full strategy: `feature/CU-{taskId}-{slug}`
  - Short strategy: `feature/CU-{taskId}`
- **Git author:** "Code Bunny" (set globally in Dockerfile)
- **Token injection:** GitHub/GitLab tokens are injected into clone URLs for private repos

---

## Logging

Logs are written to `./logs/` using Winston:
- Console output uses chalk for color
- Agent CLI stdout/stderr is captured to `./logs/agent/<sessionId>.log`
- Structured JSON logs for production

---

## Adding Support for Other Issue Trackers

The codebase is designed for ClickUp but can be extended. See `src/webhooks/clickup.js` for the webhook pattern and `src/services/clickupService.js` for the API client pattern. Mirror these for Jira, Linear, or other trackers.

---

## Security Notes

- Webhook HMAC-SHA256 verification is enforced when `CLICKUP_WEBHOOK_SECRET` is set; skip only in local dev
- Git tokens are injected at runtime and never logged
- Agent prompts are written to temp files in `logs/agent/` (not committed)
- No secrets should ever be committed to source code

---

## Development Tips

- Use `npm run dev` for auto-reload during development
- To test the pipeline manually without a webhook, use `POST /tasks/process`
- Agent prompt logic lives in `src/services/agentService.js` — edit this to change planning/building instructions
- The planning agent must NOT modify files; the building agent DOES modify files in the worktree
- Check `logs/agent/` for raw agent output when debugging failures
- If `DATABASE_URL` is not set, sessions are not persisted; suitable for quick local testing

---

## Dependency Notes

- `simple-git` wraps git CLI — ensure `git` is installed (done in Dockerfile)
- `opencode-ai` is the bundled OpenCode CLI package; path can be overridden via `OPENCODE_PATH`
- `pg` pool is a singleton; do not create additional pools
- Do not upgrade `chalk` past v4 — v5 is ESM-only and incompatible with this CommonJS codebase
