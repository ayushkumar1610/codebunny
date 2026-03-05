const logger = require("../utils/logger");
const dbService = require("./dbService");

// Executor functions injected to avoid circular dependencies
let planningExecutor = null;
let buildingExecutor = null;

const MAX_CONCURRENT_WORKTREES = parseInt(process.env.MAX_CONCURRENT_WORKTREES || "3", 10);
let activeBuilders = 0;
let isPlanningPolling = false;
let isBuildingPolling = false;

/**
 * Register the planning pipeline function.
 * @param {Function} fn - async function(taskId, sessionId)
 */
function setPlanningExecutor(fn) {
  planningExecutor = fn;
}

/**
 * Register the building pipeline function.
 * @param {Function} fn - async function(taskId, sessionId)
 */
function setBuildingExecutor(fn) {
  buildingExecutor = fn;
}

/**
 * Kick off both queue loops.
 */
function triggerQueues() {
  triggerPlanningQueue();
  triggerBuildingQueue();
}

/**
 * Planning queue — processes one "queued" session at a time (single-threaded).
 * No worktree needed; the planning agent only reads the repo.
 */
async function triggerPlanningQueue() {
  if (isPlanningPolling) return;
  isPlanningPolling = true;

  try {
    // Process one at a time to avoid duplicate plans
    const session = await dbService.getNextQueuedSession();
    if (session) {
      logger.info(`[PlanQueue] Dequeued task ${session.issue_id} (Session: ${session.session_id})`);
      await processPlanningTask(session.session_id, session.issue_id);
    }
  } catch (err) {
    logger.error(`[PlanQueue] Polling error: ${err.message}`);
  } finally {
    isPlanningPolling = false;
  }
}

/**
 * Building queue — processes "planned" sessions concurrently up to MAX_CONCURRENT_WORKTREES.
 */
async function triggerBuildingQueue() {
  if (isBuildingPolling) return;
  isBuildingPolling = true;

  try {
    while (activeBuilders < MAX_CONCURRENT_WORKTREES) {
      const session = await dbService.getNextPlannedSession();

      if (!session) break;

      logger.info(`[BuildQueue] Dequeued task ${session.issue_id} (Session: ${session.session_id})`);

      activeBuilders++;
      logger.info(`[BuildQueue] Active builders: ${activeBuilders}/${MAX_CONCURRENT_WORKTREES}`);

      // Fire and forget — let it run in the background
      processBuildingTask(session.session_id, session.issue_id).catch(err => {
        logger.error(`[BuildQueue] Unhandled error in builder worker: ${err.message}`);
      });
    }
  } catch (err) {
    logger.error(`[BuildQueue] Polling error: ${err.message}`);
  } finally {
    isBuildingPolling = false;
  }
}

/**
 * Wrapper for planning executor.
 */
async function processPlanningTask(sessionId, taskId) {
  try {
    if (!planningExecutor) {
      throw new Error("Planning executor not initialized in queueService");
    }
    await planningExecutor(taskId, sessionId);
    // After planning completes, trigger the building queue
    triggerBuildingQueue();
    // Also check if more tasks need planning
    triggerPlanningQueue();
  } catch (err) {
    logger.error(`[PlanQueue] Planning failed for task ${taskId}: ${err.message}`);
    await dbService.updateSessionStatus(sessionId, 'failed');
    // Still try to process more from the queue
    triggerPlanningQueue();
  }
}

/**
 * Wrapper for building executor with worker count management.
 */
async function processBuildingTask(sessionId, taskId) {
  try {
    if (!buildingExecutor) {
      throw new Error("Building executor not initialized in queueService");
    }
    await buildingExecutor(taskId, sessionId);
  } catch (err) {
    logger.error(`[BuildQueue] Building failed for task ${taskId}: ${err.message}`);
    await dbService.updateSessionStatus(sessionId, 'failed');
  } finally {
    activeBuilders--;
    logger.info(`[BuildQueue] Builder released. Active: ${activeBuilders}/${MAX_CONCURRENT_WORKTREES}`);
    // Check if more planned tasks are waiting
    triggerBuildingQueue();
  }
}

module.exports = {
  setPlanningExecutor,
  setBuildingExecutor,
  triggerQueues
};
