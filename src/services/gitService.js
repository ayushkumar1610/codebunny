const path = require("path");
const fs = require("fs");
const simpleGit = require("simple-git");
const logger = require("../utils/logger");

const REPOS_BASE_DIR = path.resolve(process.env.REPOS_BASE_DIR || "./repos");

/**
 * Derive a safe local directory name from a repo URL.
 * e.g. "https://github.com/acme/my-app.git" → "acme__my-app"
 */
function repoUrlToDir(repoUrl) {
  return repoUrl
    .replace(/https?:\/\/[^/]*\//, "")  // strip protocol + host
    .replace(/\.git$/, "")
    .replace(/\//g, "__");
}

/**
 * Inject GitHub or GitLab token into the URL for authenticated cloning.
 */
function injectToken(repoUrl) {
  if (repoUrl.includes("github.com")) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return repoUrl;
    return repoUrl.replace(/^(https?:\/\/)/, `$1${token}@`);
  } else if (repoUrl.includes("gitlab.com")) {
    const token = process.env.GITLAB_TOKEN;
    // GitLab uses oauth2:TOKEN or user:TOKEN for HTTP cloning
    if (!token) return repoUrl;
    return repoUrl.replace(/^(https?:\/\/)/, `$1oauth2:${token}@`);
  }
  return repoUrl;
}

/**
 * Ensure the repository is present locally.
 * - Clones if not present.
 * - Fetches & resets to the default branch if already cloned.
 *
 * @param {string} repoUrl  Remote URL of the repository
 * @returns {{ localPath: string, git: SimpleGit }}
 */
async function ensureRepo(repoUrl) {
  fs.mkdirSync(REPOS_BASE_DIR, { recursive: true });

  const dirName = repoUrlToDir(repoUrl);
  const localPath = path.join(REPOS_BASE_DIR, dirName);
  const defaultBranch = process.env.GIT_DEFAULT_BRANCH || "main";

  let alreadyExists = fs.existsSync(localPath);

  if (!alreadyExists) {
    logger.info(`[Git] Cloning ${repoUrl} → ${localPath}`);
    await simpleGit().clone(injectToken(repoUrl), localPath);
    logger.info(`[Git] Clone complete`);
  }

  const git = simpleGit({
    baseDir: localPath,
    config: [
      `user.name=${process.env.GIT_USER_NAME || "opencode-agent"}`,
      `user.email=${process.env.GIT_USER_EMAIL || "agent@localhost"}`,
    ],
  });

  if (alreadyExists) {
    logger.info(`[Git] Repo already exists at ${localPath}, fetching latest…`);
    await git.fetch(["--all", "--prune"]);
    
    logger.info(`[Git] Syncing default branch: "${defaultBranch}"`);
    try {
      await git.checkout(defaultBranch);
      await git.reset(["--hard", `origin/${defaultBranch}`]);
      logger.info(`[Git] Reset to origin/${defaultBranch}`);
    } catch (err) {
      logger.warn(`[Git] Failed to checkout or reset to "${defaultBranch}": ${err.message}`);
    }
  }

  return { localPath, git };
}

/**
 * Build a sanitised branch name from a ClickUp task.
 * Strategy controlled by BRANCH_PREFIX_STRATEGY env var.
 *
 * @param {object} task  ClickUp task object
 * @returns {string}     e.g. "feature/CU-abc123-fix-login-button"
 */
function buildBranchName(task) {
  const strategy = process.env.BRANCH_PREFIX_STRATEGY || "both";
  const slug = task.name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .substring(0, 50);

  let suffix;
  if (strategy === "task-id") suffix = task.id;
  else if (strategy === "task-name") suffix = slug;
  else suffix = `${task.id}-${slug}`;                  // "both" (default)

  return `feature/CU-${suffix}`;
}

/**
 * Create and checkout a new branch (or reuse if it already exists).
 * @param {{ localPath: string, git: SimpleGit }} repoCtx
 * @param {string} branchName
 */
async function checkoutBranch(repoCtx, branchName) {
  const { git } = repoCtx;
  const branches = await git.branch();

  if (branches.all.includes(branchName) || branches.all.includes(`remotes/origin/${branchName}`)) {
    logger.info(`[Git] Branch "${branchName}" exists, checking out`);
    await git.checkout(branchName);
  } else {
    logger.info(`[Git] Creating branch "${branchName}"`);
    await git.checkoutLocalBranch(branchName);
  }
}

/**
 * Push the current branch to origin.
 * @param {{ localPath: string, git: SimpleGit }} repoCtx
 * @param {string} branchName
 */
async function pushBranch(repoCtx, branchName) {
  logger.info(`[Git] Pushing branch "${branchName}" to origin`);
  await repoCtx.git.push(["--set-upstream", "origin", branchName]);
}

/**
 * Creates a unique git worktree for a specific task.
 * @param {{ localPath: string, git: SimpleGit }} repoCtx
 * @param {string} taskId
 * @param {string} branchName
 * @param {string} baseBranch
 * @returns {Promise<string>} The absolute path to the newly created worktree
 */
async function setupWorktree(repoCtx, taskId, branchName, baseBranch) {
  const { git, localPath } = repoCtx;
  const worktreePath = `${localPath}__worktrees/${taskId}`;
  
  // Ensure the base worktrees directory exists
  fs.mkdirSync(`${localPath}__worktrees`, { recursive: true });

  const branches = await git.branch();
  const remoteBranch = `remotes/origin/${branchName}`;

  try {
    if (branches.all.includes(branchName) || branches.all.includes(remoteBranch)) {
      logger.info(`[Git] Branch "${branchName}" already exists, adding worktree at ${worktreePath}`);
      // If branch exists remotely but not locally, we need to track it
      if (!branches.all.includes(branchName) && branches.all.includes(remoteBranch)) {
        await git.raw(["branch", "--track", branchName, remoteBranch]);
      }
      await git.raw(["worktree", "add", worktreePath, branchName]);
    } else {
      logger.info(`[Git] Creating new branch "${branchName}" and adding worktree at ${worktreePath}`);
      await git.raw(["worktree", "add", "-b", branchName, worktreePath, `origin/${baseBranch}`]);
    }
    
    logger.info(`[Git] Worktree ready at: ${worktreePath}`);
    return worktreePath;
  } catch (err) {
    logger.error(`[Git] Failed to setup worktree: ${err.message}`);
    throw err;
  }
}

/**
 * Removes a git worktree safely.
 * @param {{ localPath: string, git: SimpleGit }} repoCtx
 * @param {string} worktreePath
 */
async function teardownWorktree(repoCtx, worktreePath) {
  try {
    logger.info(`[Git] Removing worktree at ${worktreePath}`);
    await repoCtx.git.raw(["worktree", "remove", "--force", worktreePath]);
  } catch (err) {
    logger.warn(`[Git] Failed to remove worktree: ${err.message}`);
    // Best effort cleanup: if worktree remove fails, try removing dir
    try {
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        await repoCtx.git.raw(["worktree", "prune"]);
      }
    } catch (cleanupErr) {
      logger.warn(`[Git] Cleanup fallback failed: ${cleanupErr.message}`);
    }
  }
}

module.exports = { 
  ensureRepo, 
  buildBranchName, 
  checkoutBranch, 
  pushBranch, 
  repoUrlToDir, 
  REPOS_BASE_DIR,
  setupWorktree,
  teardownWorktree
};
