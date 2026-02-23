const express = require("express");
const { processTaskAssignment } = require("../services/taskProcessor");
const logger = require("../utils/logger");

const router = express.Router();

/**
 * POST /tasks/process
 * Body: { "taskId": "..." } or { "task_id": "..." }
 *
 * Manually trigger the processing pipeline for a specific ClickUp task.
 */
router.post("/process", express.json(), (req, res) => {
  const taskId = req.body.taskId || req.body.task_id;

  if (!taskId) {
    return res.status(400).json({ error: "Missing taskId in request body" });
  }

  logger.info(`[API] Manually triggered processing for task ${taskId}`);

  // Fire-and-forget the processing pipeline
  processTaskAssignment(taskId).catch((err) => {
    logger.error(`[API] Error processing task ${taskId}: ${err.message}`);
  });

  res.status(202).json({
    message: "Processing started",
    taskId,
    status: "accepted"
  });
});

module.exports = router;
