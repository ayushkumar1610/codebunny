const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const logger = require("../utils/logger");
const dbService = require("./dbService");

/**
 * Build the full system prompt / instruction file that is fed to the agent.
 *
 * @param {object} opts
 * @param {string} opts.taskSummary   Markdown summary of the ClickUp task
 * @param {string} opts.branchName    Feature branch already checked out locally
 * @param {string} opts.repoUrl       Remote repo URL (for PR context)
 * @param {string} opts.baseBranch    Target/base branch for the PR
 * @returns {string} Full prompt text
 */
function buildPrompt({ taskSummary, branchName, repoUrl, baseBranch }) {
  const autoPR = process.env.AUTO_CREATE_PR !== "false";

  return `You are an expert software engineer working inside a git repository.
A task has been assigned to you from ClickUp. Read the details below carefully
and implement the required changes.

---

${taskSummary}

---

## Your Instructions

1. **You are already on branch \`${branchName}\`.**  Do NOT switch branches.
   The branch has been created from \`${baseBranch}\` and is ready for your changes.

2. Analyse the task description above and if its a bug, then get the root cause first.
   Then identify all the code changes needed.

3. Implement the changes. Follow the existing code style, conventions and patterns you find in the repository. 
   Make sure to validate the changes and new changes wont break the existing code.
   Write tests if the project has a test suite.

4. Make sure the project still builds / compiles without errors. Run any
   relevant lint or test commands if you can do so safely.

5. Git stage and commit your changes with a clear, conventional-commit message.
   Example: \`feat(auth): add OAuth2 login flow (CU-${branchName.split("/").pop()})\`

If anything in the task description is unclear or if you encounter a blocker,
explain your reasoning in comments inside the code or in the PR description.

Begin now.
`.trim();
}

/**
 * Write the prompt to a temporary file and spawn the configured CLI in the repo directory.
 * Returns a Promise that resolves when the process exits successfully.
 *
 * @param {object} opts
 * @param {string} opts.localPath     Absolute path to the local repo
 * @param {string} opts.prompt        Full prompt string
 * @param {string} opts.taskId        ClickUp task ID (used for log file naming)
 * @returns {Promise<void>}
 */
function runAgent({ localPath, prompt, taskId }) {
  return new Promise(async (resolve, reject) => {
    const logsDir = path.join(process.cwd(), "logs", "agent");
    fs.mkdirSync(logsDir, { recursive: true });

    // Track session stats
    const sessionId = randomUUID();
    await dbService.startSession(sessionId, taskId);

    // Write prompt to a temp file so we can pass it cleanly
    const promptFile = path.join(logsDir, `prompt-${taskId}.md`);
    fs.writeFileSync(promptFile, prompt, "utf8");

    const agentCli = process.env.AGENT_CLI || "opencode";
    let cmd, args;

    if (agentCli === "opencode") {
      cmd = process.env.OPENCODE_PATH || "opencode";
      const model = process.env.OPENCODE_MODEL || "opencode/minimax-m2.5-free";
      args = [
        "run",
        "Read the task instructions from the attached file and implement the required changes.",
        "--model", model,
        "--file", promptFile
      ];
    } else if (agentCli === "claude") {
      cmd = "claude";
      args = ["-p", promptFile];
    } else if (agentCli === "gemini") {
      cmd = "gemini";
      args = ["-p", promptFile];
    } else {
      return reject(new Error(`Unknown AGENT_CLI: ${agentCli}`));
    }

    logger.info(`[Agent] Spawning: ${cmd} ${args.join(" ")}`);
    logger.info(`[Agent] Working directory: ${localPath}`);

    const logStream = fs.createWriteStream(path.join(logsDir, `session-${taskId}.log`), { flags: "a" });

    const child = spawn(cmd, args, {
      cwd: localPath,
      env: {
        ...process.env,
        // Surface GITHUB_TOKEN and other credentials to the child
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    child.stdout.on("data", (d) => logger.info(`[Agent stdout] ${d.toString().trim()}`));
    child.stderr.on("data", (d) => logger.warn(`[Agent stderr] ${d.toString().trim()}`));

    child.on("close", async (code) => {
      logStream.close();
      
      // We pass 0 for tokenCount for MVP since tracking CLI output precisely varies per tool.
      await dbService.endSession(sessionId, 0);

      if (code === 0) {
        logger.info(`[Agent] Process exited cleanly for task ${taskId}`);
        resolve();
      } else {
        reject(new Error(`Agent exited with code ${code} for task ${taskId}`));
      }
    });

    child.on("error", async (err) => {
      logStream.close();
      await dbService.endSession(sessionId, 0);
      reject(err);
    });
  });
}

module.exports = { buildPrompt, runAgent };
