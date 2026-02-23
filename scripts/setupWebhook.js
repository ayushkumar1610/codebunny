#!/usr/bin/env node
/**
 * scripts/setupWebhook.js
 *
 * One-time script to register (or list) the ClickUp webhook.
 * Run with: node scripts/setupWebhook.js
 *
 * Required env vars:
 *   CLICKUP_API_TOKEN, CLICKUP_TEAM_ID, PUBLIC_URL
 */

require("dotenv").config();
const axios = require("axios");

const API_TOKEN = process.env.CLICKUP_API_TOKEN;
const TEAM_ID = process.env.CLICKUP_TEAM_ID;
const PUBLIC_URL = process.env.PUBLIC_URL;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/webhooks/clickup";

if (!API_TOKEN || !TEAM_ID || !PUBLIC_URL) {
  console.error("❌  Set CLICKUP_API_TOKEN, CLICKUP_TEAM_ID, and PUBLIC_URL in your .env file");
  process.exit(1);
}

const client = axios.create({
  baseURL: "https://api.clickup.com/api/v2",
  headers: { Authorization: API_TOKEN, "Content-Type": "application/json" },
});

const endpointUrl = `${PUBLIC_URL.replace(/\/$/, "")}${WEBHOOK_PATH}`;

async function main() {
  console.log("\n📡  ClickUp Webhook Setup\n");
  console.log(`Endpoint: ${endpointUrl}`);
  console.log(`Team ID:  ${TEAM_ID}\n`);

  // List existing webhooks
  const { data: existing } = await client.get(`/team/${TEAM_ID}/webhook`);
  console.log(`Existing webhooks (${existing.webhooks?.length ?? 0}):`);
  (existing.webhooks || []).forEach((w) => {
    console.log(`  • [${w.id}] ${w.endpoint} – ${w.status}`);
  });

  const alreadyExists = (existing.webhooks || []).some(
    (w) => w.endpoint === endpointUrl && w.status === "active"
  );

  if (alreadyExists) {
    console.log("\n✅  Webhook already registered and active. Nothing to do.");
    return;
  }

  // Register new webhook
  console.log("\nRegistering new webhook…");
  const { data } = await client.post(`/team/${TEAM_ID}/webhook`, {
    endpoint: endpointUrl,
    events: [
      "taskAssigneeUpdated",   // Primary: someone is assigned to a task
      "taskUpdated",           // Secondary: catch assignment changes via history_items
      "taskCreated",           // Optional: handle newly created tasks with assignees
    ],
  });

  console.log(`\n✅  Webhook registered!`);
  console.log(`    ID:     ${data.webhook?.id}`);
  console.log(`    Secret: ${data.webhook?.secret}`);
  console.log(`\n👉  Add this to your .env:`);
  console.log(`    CLICKUP_WEBHOOK_SECRET=${data.webhook?.secret}`);
}

main().catch((err) => {
  console.error("\n❌  Error:", err.response?.data ?? err.message);
  process.exit(1);
});
