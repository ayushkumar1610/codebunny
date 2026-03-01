const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const logger = require("../utils/logger");

/**
 * Build a prompt that instructs the agent to ONLY produce a technical plan.
 * No code changes, no commits — just analysis and a markdown plan.
 */
function buildPlanningPrompt({ taskSummary, repoUrl, baseBranch }) {
  return `You are an expert software architect and technical lead.
A task has been assigned from a ticket. Your job is to analyse the codebase and
produce a detailed **technical implementation plan** — nothing else.

---

${taskSummary}

---

## Your Instructions

1. Read the task description above carefully.

2. Explore the repository to understand the existing architecture, patterns,
   conventions, and relevant files.

3. Produce a **Technical Implementation Plan** in Markdown with the following
   sections:
   - **Summary**: One-paragraph overview of what needs to change and why.
   - **Files to Modify**: List every file that needs changes, with a brief
     description of what changes are required in each.
   - **New Files**: Any new files that need to be created.
   - **Dependencies**: New packages or services required (if any).
   - **Testing Strategy**: How to verify the changes work correctly.
   - **Risks & Edge Cases**: Potential pitfalls to watch out for.

4. Output ONLY the plan as your final response. The plan will be posted as a
   comment on the ticket for review before implementation begins.

Begin your analysis now.
`.trim();
}

/**
 * Build a prompt for the builder agent that includes the technical plan.
 */
function buildBuilderPrompt({ plan, branchName, repoUrl, baseBranch }) {
  return `You are an expert software engineer working inside a git repository.
A technical plan has been created by a planning agent. Follow the plan closely
to implement the required changes.

---

## Technical Plan

${plan}

---

## Your Instructions

1. **You are already on branch \`${branchName}\`.**  Do NOT switch branches.
   The branch has been created from \`${baseBranch}\` and is ready for your changes.

2. Follow the technical plan above. It identifies which files to modify,
   what changes to make, and what to watch out for.

3. Implement the changes. Follow the existing code style, conventions and
   patterns you find in the repository.
   Make sure to validate the changes and new changes wont break the existing code.
   Write tests if the project has a test suite.

4. Make sure the project still builds / compiles without errors. Run any
   relevant lint or test commands if you can do so safely.

5. Git stage and commit your changes with a clear, conventional-commit message.
   Example: \`feat(auth): add OAuth2 login flow (CU-${branchName.split("/").pop()})\`

If anything in the task description is unclear or if you encounter a blocker,
explain your reasoning in comments inside the code.

Begin now.
`.trim();
}

/**
 * Spawn a CLI agent and capture its stdout output as the result.
 * Used by the planning agent to capture the plan text.
 *
 * @param {object} opts
 * @param {string} opts.localPath   Absolute path to the local repo
 * @param {string} opts.prompt      Full prompt string
 * @param {string} opts.taskId      ClickUp task ID
 * @returns {Promise<string>}       The captured stdout output (the plan)
 */
function runPlanningAgent({ localPath, prompt, taskId }) {
  return new Promise((resolve, reject) => {
    const logsDir = path.join(process.cwd(), "logs", "agent");
    fs.mkdirSync(logsDir, { recursive: true });

    const promptFile = path.join(logsDir, `plan-prompt-${taskId}.md`);
    fs.writeFileSync(promptFile, prompt, "utf8");

    const agentCli = process.env.AGENT_CLI || "opencode";
    let cmd, args;

    if (agentCli === "opencode") {
      cmd = process.env.OPENCODE_PATH || "opencode";
      const model = process.env.PLANNING_MODEL || process.env.OPENCODE_MODEL || "opencode/minimax-m2.5-free";
      args = [
        "run",
        "Attached the instructions in the file, follow it strictly",
        "--file", promptFile,
        "--agent", "plan",
        "--model", model
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

    logger.info(`[PlanningAgent] Spawning: ${cmd} ${args.join(" ")}`);
    logger.info(`[PlanningAgent] Working directory: ${localPath}`);

    const logStream = fs.createWriteStream(path.join(logsDir, `plan-session-${taskId}.log`), { flags: "a" });
    let capturedOutput = "";

    const child = spawn(cmd, args, {
      cwd: localPath,
      env: {
        ...process.env,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    child.stdout.on("data", (d) => {
      const text = d.toString();
      capturedOutput += text;
      logger.info(`[PlanningAgent stdout] ${text.trim()}`);
    });
    child.stderr.on("data", (d) => logger.warn(`[PlanningAgent stderr] ${d.toString().trim()}`));

    child.on("close", (code) => {
      logStream.close();
      if (code === 0) {
        logger.info(`[PlanningAgent] Process exited cleanly for task ${taskId}`);
        resolve(capturedOutput.trim());
      } else {
        reject(new Error(`PlanningAgent exited with code ${code} for task ${taskId}`));
      }
    });

    child.on("error", (err) => {
      logStream.close();
      reject(err);
    });
  });
}

/**
 * Spawn a CLI agent for the builder phase (code implementation).
 *
 * @param {object} opts
 * @param {string} opts.localPath   Absolute path to the worktree
 * @param {string} opts.prompt      Full prompt string
 * @param {string} opts.taskId      ClickUp task ID
 * @returns {Promise<void>}
 */
function runBuilderAgent({ localPath, prompt, taskId }) {
  return new Promise((resolve, reject) => {
    const logsDir = path.join(process.cwd(), "logs", "agent");
    fs.mkdirSync(logsDir, { recursive: true });

    const promptFile = path.join(logsDir, `build-prompt-${taskId}.md`);
    fs.writeFileSync(promptFile, prompt, "utf8");

    const agentCli = process.env.AGENT_CLI || "opencode";
    let cmd, args;

    if (agentCli === "opencode") {
      cmd = process.env.OPENCODE_PATH || "opencode";
      const model = process.env.OPENCODE_MODEL || "opencode/minimax-m2.5-free";
      args = [
        "run",
        "Attached file is the techinical plan generated by planning agent. Implement the changes.",
        "--file", promptFile,
        "--model", model
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

    logger.info(`[BuilderAgent] Spawning: ${cmd} ${args.join(" ")}`);
    logger.info(`[BuilderAgent] Working directory: ${localPath}`);

    const logStream = fs.createWriteStream(path.join(logsDir, `build-session-${taskId}.log`), { flags: "a" });

    const child = spawn(cmd, args, {
      cwd: localPath,
      env: {
        ...process.env,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    child.stdout.on("data", (d) => logger.info(`[BuilderAgent stdout] ${d.toString().trim()}`));
    child.stderr.on("data", (d) => logger.warn(`[BuilderAgent stderr] ${d.toString().trim()}`));

    child.on("close", (code) => {
      logStream.close();
      if (code === 0) {
        logger.info(`[BuilderAgent] Process exited cleanly for task ${taskId}`);
        resolve();
      } else {
        reject(new Error(`BuilderAgent exited with code ${code} for task ${taskId}`));
      }
    });

    child.on("error", (err) => {
      logStream.close();
      reject(err);
    });
  });
}

module.exports = {
  buildPlanningPrompt,
  buildBuilderPrompt,
  runPlanningAgent,
  runBuilderAgent
};
