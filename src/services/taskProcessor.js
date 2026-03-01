const logger = require("../utils/logger");
const fs = require("fs");
const clickupService = require("./clickupService");
const gitService = require("./gitService");
const agentService = require("./agentService");
const gitProviderService = require("./gitProviderService");
const dbService = require("./dbService");
const queueService = require("./queueService");
const { randomUUID } = require("crypto");

const PLAN_COMMENT_PREFIX = "📋 **Technical Plan**";

/**
 * Enqueue a task when a task-assignment event is received.
 * @param {string} taskId
 */
async function processTaskAssignment(taskId) {
  logger.info(`\n${"=".repeat(60)}`);
  logger.info(`[Processor] Received assignment for task ${taskId}`);
  
  const sessionId = randomUUID();
  await dbService.enqueueSession(sessionId, taskId);
  
  // Kick off both queue loops
  queueService.triggerQueues();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1: PLANNING PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Planning pipeline — runs single-threaded (no worktree needed).
 * Reads the repo, generates a technical plan, posts it to ClickUp.
 *
 * @param {string} taskId
 * @param {string} sessionId
 */
async function executePlanningPipeline(taskId, sessionId) {
  logger.info(`[Planner] Starting planning for task ${taskId} (Session: ${sessionId})`);

  try {
    // ── Mark as planning ─────────────────────────────────────────────────────
    await dbService.updateSessionStatus(sessionId, 'planning');

    // ── Fetch task details ───────────────────────────────────────────────────
    const [task, comments] = await Promise.all([
      clickupService.getTask(taskId),
      clickupService.getTaskComments(taskId),
    ]);
    logger.info(`[Planner] Task: "${task.name}"`);

    // ── Resolve repo URL ─────────────────────────────────────────────────────
    const repoUrl = process.env.GIT_REPO_URL || process.env.GITHUB_REPO_URL;
    if (!repoUrl) {
      throw new Error(`Missing GIT_REPO_URL (or GITHUB_REPO_URL) in env`);
    }

    // ── Ensure local clone (read-only, no worktree) ──────────────────────────
    const repoCtx = await gitService.ensureRepo(repoUrl);
    const baseBranch = process.env.GIT_DEFAULT_BRANCH || "main";

    // ── Build planning prompt ────────────────────────────────────────────────
    const taskSummary = clickupService.buildTaskSummary(task, comments);
    const prompt = agentService.buildPlanningPrompt({ taskSummary, repoUrl, baseBranch });

    // ── Run planning agent ───────────────────────────────────────────────────
    logger.info(`[Planner] Launching Planning Agent…`);
    const plan = await agentService.runPlanningAgent({
      localPath: repoCtx.localPath,
      prompt,
      taskId
    });

    // ── Persist plan in DB ───────────────────────────────────────────────────
    await dbService.savePlan(sessionId, plan);

    // ── Post plan as ClickUp comment ─────────────────────────────────────────
    const planComment = `${PLAN_COMMENT_PREFIX}\n\n${plan}`;
    await clickupService.postComment(taskId, planComment);
    logger.info(`[Planner] Posted technical plan to ClickUp for task ${taskId}`);

    // ── Mark as planned ──────────────────────────────────────────────────────
    await dbService.updateSessionStatus(sessionId, 'planned');
    logger.info(`[Planner] Planning complete for task ${taskId} ✅`);

  } catch (err) {
    logger.error(`[Planner] Planning failed for task ${taskId}: ${err.message}`, err);
    try {
      await clickupService.postComment(
        taskId,
        `⚠️ **Planning Agent** encountered an error:\n\`\`\`\n${err.message}\n\`\`\``
      );
    } catch (_) { /* best-effort */ }
    throw err; // Let queueService mark as failed
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2: BUILDING PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Building pipeline — runs concurrently in isolated worktrees.
 * Reads the plan from DB, implements the code, pushes + creates PR.
 *
 * @param {string} taskId
 * @param {string} sessionId
 */
async function executeBuildingPipeline(taskId, sessionId) {
  logger.info(`[Builder] Starting build for task ${taskId} (Session: ${sessionId})`);
  let worktreePath = null;
  let repoCtx = null;

  try {
    // ── Mark as building ─────────────────────────────────────────────────────
    await dbService.updateSessionStatus(sessionId, 'building');

    // ── Fetch task details (for branch name + PR metadata) ───────────────────
    const task = await clickupService.getTask(taskId);
    logger.info(`[Builder] Task: "${task.name}"`);

    // ── Read plan from DB ────────────────────────────────────────────────────
    const plan = await dbService.getPlan(sessionId);
    if (!plan) {
      throw new Error(`No technical plan found in DB for session ${sessionId}`);
    }
    logger.info(`[Builder] Loaded technical plan from DB (${plan.length} chars)`);

    // ── Resolve repo URL ─────────────────────────────────────────────────────
    const repoUrl = process.env.GIT_REPO_URL || process.env.GITHUB_REPO_URL;
    if (!repoUrl) {
      throw new Error(`Missing GIT_REPO_URL (or GITHUB_REPO_URL) in env`);
    }

    // ── Ensure local clone & Setup worktree ──────────────────────────────────
    repoCtx = await gitService.ensureRepo(repoUrl);
    const branchName = gitService.buildBranchName(task);
    const baseBranch = process.env.GIT_DEFAULT_BRANCH || "main";

    worktreePath = `${repoCtx.localPath}__worktrees/${taskId}`;
    if (fs.existsSync(worktreePath)) {
      logger.info(`[Builder] Cleaning up stale worktree at ${worktreePath}`);
      await gitService.teardownWorktree(repoCtx, worktreePath);
    }

    worktreePath = await gitService.setupWorktree(repoCtx, taskId, branchName, baseBranch);
    logger.info(`[Builder] Working in isolated directory: ${worktreePath}`);

    // ── Build builder prompt (plan only, no task summary) ────────────────────
    const prompt = agentService.buildBuilderPrompt({
      plan,
      branchName,
      repoUrl,
      baseBranch
    });

    // ── Run builder agent ────────────────────────────────────────────────────
    logger.info(`[Builder] Launching Builder Agent…`);
    await agentService.runBuilderAgent({ localPath: worktreePath, prompt, taskId });

    // ── Push branch ──────────────────────────────────────────────────────────
    await gitService.pushBranch({ git: repoCtx.git, localPath: worktreePath }, branchName);

    // ── Create PR/MR ─────────────────────────────────────────────────────────
    let prUrl = null;
    const autoPR = process.env.AUTO_CREATE_PR === "true";
    if (autoPR && (process.env.GITHUB_TOKEN || process.env.GITLAB_TOKEN)) {
      try {
        prUrl = await gitProviderService.createPullRequest({
          repoUrl,
          branchName,
          baseBranch,
          title: `[CU-${task.id}] ${task.name}`,
          body: `## ClickUp Task\n\n[${task.name}](${task.url})\n\n---\n\nAutomatically implemented by Builder Agent.`,
        });
      } catch (prErr) {
        logger.warn(`[Builder] PR creation skipped: ${prErr.message}`);
      }
    }

    // ── Post completion comment ──────────────────────────────────────────────
    const comment = [
      `🤖 **Builder Agent** has implemented this task.`,
      ``,
      `- **Branch:** \`${branchName}\``,
      prUrl ? `- **Draft PR:** ${prUrl}` : "",
    ].filter(Boolean).join("\n");

    await clickupService.postComment(taskId, comment);

    // ── Mark as completed ────────────────────────────────────────────────────
    await dbService.endSession(sessionId, 0);
    logger.info(`[Builder] Build complete for task ${taskId} ✅`);

  } catch (err) {
    logger.error(`[Builder] Build failed for task ${taskId}: ${err.message}`, err);
    try {
      await clickupService.postComment(
        taskId,
        `⚠️ **Builder Agent** encountered an error:\n\`\`\`\n${err.message}\n\`\`\``
      );
    } catch (_) { /* best-effort */ }
    throw err; // Let queueService mark as failed
  } finally {
    // ── Teardown worktree ────────────────────────────────────────────────────
    if (repoCtx && worktreePath) {
      await gitService.teardownWorktree(repoCtx, worktreePath);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGISTER EXECUTORS WITH QUEUE SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

queueService.setPlanningExecutor(executePlanningPipeline);
queueService.setBuildingExecutor(executeBuildingPipeline);

module.exports = { processTaskAssignment };
