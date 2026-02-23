const crypto = require("crypto");
const express = require("express");
const logger = require("../utils/logger");
const { processTaskAssignment } = require("../services/taskProcessor");

const router = express.Router();

/**
 * Verify the HMAC-SHA256 signature that ClickUp sends in the
 * `X-Signature` header.  Returns false if the secret isn't configured
 * (webhook still accepted – useful in dev).
 */
function verifySignature(req) {
  const secret = process.env.CLICKUP_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn("[Webhook] CLICKUP_WEBHOOK_SECRET not set – skipping signature verification");
    return true;
  }

  const signature = req.headers["x-signature"];
  if (!signature) return false;

  const hmac = crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(req.body))
    .digest("hex");

  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
}

/**
 * Determine whether a ClickUp event payload represents a task-assignment event.
 * ClickUp fires "taskAssigneeUpdated" when assignees change.
 * We also accept "taskCreated" events that already have assignees.
 */
function isAssignmentEvent(event, historyItems = []) {
  if (event === "taskAssigneeUpdated") return true;

  // taskUpdated can contain assignee changes buried in history_items
  if (event === "taskUpdated") {
    return historyItems.some(
      (h) => h.field === "assignee" && h.after && Object.keys(h.after).length > 0
    );
  }

  return false;
}

// ── POST /webhooks/clickup ───────────────────────────────────────────────────
router.post("/", express.json(), (req, res) => {
  // Acknowledge immediately – ClickUp expects a fast 200
  res.status(200).json({ received: true });

  if (!verifySignature(req)) {
    logger.warn("[Webhook] Invalid signature – ignoring payload");
    return;
  }

  const { event, task_id, history_items } = req.body;
  logger.info(`[Webhook] Received event: "${event}" for task ${task_id}`);

  if (!task_id) {
    logger.warn("[Webhook] Payload missing task_id");
    return;
  }

  if (isAssignmentEvent(event, history_items || [])) {
    // Fire-and-forget – heavy work happens async
    processTaskAssignment(task_id).catch((err) =>
      logger.error(`[Webhook] Unhandled error in processTaskAssignment: ${err.message}`)
    );
  } else {
    logger.info(`[Webhook] Event "${event}" is not an assignment event – skipping`);
  }
});

module.exports = router;
