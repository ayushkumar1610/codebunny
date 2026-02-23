# ClickUp → OpenCode Agent

> Listens for ClickUp task-assignment events, automatically clones the linked repository, and launches [OpenCode CLI](https://opencode.ai) to implement the task — then pushes a branch and opens a draft Pull Request.

```
ClickUp assigns task
       │
       ▼
Webhook (this server)
       │
       ├─ Fetch full task + comments from ClickUp API
       ├─ Resolve repository URL
       ├─ Clone repo (or git pull if already present)
       ├─ Create feature branch  feature/CU-<id>-<slug>
       ├─ Build rich prompt (task description + instructions)
       ├─ Spawn opencode CLI in the repo directory
       │      └─ OpenCode implements, commits, pushes
       └─ Post branch/PR link back as a ClickUp comment
```

---

## Prerequisites

| Tool | Purpose |
|------|---------|
| **Node.js ≥ 18** | Runtime |
| **[OpenCode CLI](https://opencode.ai/docs/getting-started/installation)** | AI coding agent |
| **ClickUp API token** | Read tasks, post comments |
| **GitHub token** (optional) | Clone private repos, create PRs |
| **Public URL** (dev/prod) | Expose local server to ClickUp |

---

## Quick Start

```bash
# 1. Clone this repo and install dependencies
git clone <this-repo>
cd clickup-opencode-agent
npm install

# 2. Configure environment
cp .env.example .env
# → edit .env and fill in your tokens

# 3. Start the server
npm run dev          # development (auto-restart)
npm start            # production

# 4. Expose to the internet
# → if developing locally, use a tool like Cloudflare Tunnel or localtunnel
# → copy your public HTTPS URL into PUBLIC_URL in .env

# 5. Register the ClickUp webhook (one-time)
npm run setup-webhook
# → copy the returned secret into CLICKUP_WEBHOOK_SECRET in .env

# 6. Assign a ClickUp task to yourself and watch the magic ✨
```

---

## How Repository URLs Are Resolved

The agent looks for the repository URL in this order:

1. **ClickUp custom field** – Add a custom field named `repo_url` (or any name in `REPO_URL_FIELD_NAMES`) to your ClickUp space/list containing the full GitHub/GitLab URL.
2. **Task description** – Scans the description for a `github.com` or `gitlab.com` URL.
3. **Heuristic** – Combines `GITHUB_DEFAULT_OWNER` with the list name, e.g. owner=`acme`, list=`Backend API` → `https://github.com/acme/backend-api.git`.

---

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLICKUP_API_TOKEN` | ✅ | — | Personal API token from ClickUp |
| `CLICKUP_TEAM_ID` | ✅ | — | Workspace (team) ID |
| `CLICKUP_WEBHOOK_SECRET` | — | — | HMAC secret returned by setup-webhook |
| `PORT` | — | `3000` | HTTP port |
| `PUBLIC_URL` | ✅ setup | — | Publicly reachable base URL |
| `REPOS_BASE_DIR` | — | `./repos` | Where repos are cloned |
| `GIT_DEFAULT_BRANCH` | — | `main` | Base branch for feature branches |
| `GITHUB_TOKEN` | — | — | For private repos & PR creation |
| `GITHUB_DEFAULT_OWNER` | — | — | Fallback repo owner/org |
| `OPENCODE_PATH` | — | `opencode` | Path to opencode binary |
| `OPENCODE_MODEL` | — | `anthropic/claude-sonnet-4-5` | Model for opencode |
| `REPO_URL_FIELD_NAMES` | — | `repo_url,repository,github_url` | Custom field names to check |
| `BRANCH_PREFIX_STRATEGY` | — | `both` | `task-id` / `task-name` / `both` |
| `AUTO_CREATE_PR` | — | `true` | Create draft PR after opencode finishes |

---

## Project Structure

```
clickup-opencode-agent/
├── src/
│   ├── index.js                  # Express server entry point
│   ├── webhooks/
│   │   └── clickup.js            # Webhook signature verification + routing
│   ├── services/
│   │   ├── clickupService.js     # ClickUp REST API client
│   │   ├── gitService.js         # Clone / branch / push helpers
│   │   ├── githubService.js      # GitHub PR creation
│   │   ├── opencodeService.js    # Prompt builder + opencode spawner
│   │   └── taskProcessor.js     # Orchestrates the full pipeline
│   └── utils/
│       └── logger.js             # Winston logger
├── scripts/
│   └── setupWebhook.js           # One-time webhook registration
├── logs/                         # Created at runtime
├── repos/                        # Cloned repos (REPOS_BASE_DIR)
├── .env.example
└── package.json
```

---

## Adding More Ticket Systems

The architecture is intentionally modular. To add Jira or Linear:

1. Create `src/webhooks/jira.js` following the same pattern as `clickup.js`.
2. Create `src/services/jiraService.js` implementing `getTask`, `getTaskComments`, `postComment`, `buildTaskSummary`.
3. Mount the new router in `src/index.js`:
   ```js
   app.use("/webhooks/jira", require("./webhooks/jira"));
   ```
4. Call `processTaskAssignment` from the new webhook handler — the rest of the pipeline is system-agnostic.

---

## Security Notes

- Always set `CLICKUP_WEBHOOK_SECRET` in production. The server verifies the `X-Signature` HMAC on every request.
- Store `GITHUB_TOKEN` and `CLICKUP_API_TOKEN` as secrets (e.g. in Vault, AWS SSM, or your CI/CD environment — never commit them).
- The agent runs `opencode` with the full environment; ensure your deployment environment has minimal blast radius.
