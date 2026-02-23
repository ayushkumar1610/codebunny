const axios = require("axios");
const logger = require("../utils/logger");

const BASE_URL = "https://api.clickup.com/api/v2";

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: process.env.CLICKUP_API_TOKEN,
    "Content-Type": "application/json",
  },
});

/**
 * Fetch full task details including custom fields and assignees.
 * @param {string} taskId
 * @returns {Promise<object>} ClickUp task object
 */
async function getTask(taskId) {
  logger.info(`[ClickUp] Fetching task ${taskId}`);
  const { data } = await client.get(`/task/${taskId}`, {
    params: { include_subtasks: true },
  });
  return data;
}

/**
 * Fetch all comments on a task (used to add richer context to the prompt).
 * @param {string} taskId
 * @returns {Promise<Array>}
 */
async function getTaskComments(taskId) {
  const { data } = await client.get(`/task/${taskId}/comment`);
  return data.comments || [];
}

/**
 * Post a comment back to the ClickUp task (e.g. PR link, branch name).
 * @param {string} taskId
 * @param {string} text
 */
async function postComment(taskId, text) {
  await client.post(`/task/${taskId}/comment`, { comment_text: text });
  logger.info(`[ClickUp] Posted comment to task ${taskId}`);
}

/**
 * Extract a named custom field value from a task object.
 * Checks multiple possible field name variants (case-insensitive).
 * @param {object} task   Full task object from getTask()
 * @param {string[]} names Field names to look for
 * @returns {string|null}
 */
function extractCustomField(task, names) {
  if (!task.custom_fields) return null;
  const lowerNames = names.map((n) => n.toLowerCase().replace(/[_\s-]/g, ""));
  for (const field of task.custom_fields) {
    const normalised = field.name.toLowerCase().replace(/[_\s-]/g, "");
    if (lowerNames.includes(normalised) && field.value) {
      return typeof field.value === "string" ? field.value : field.value?.url ?? null;
    }
  }
  return null;
}

/**
 * Build a human-readable markdown summary of the task for the AI prompt.
 * @param {object} task
 * @param {Array}  comments
 * @returns {string}
 */
function buildTaskSummary(task, comments = []) {
  const assignees = (task.assignees || []).map((a) => a.username).join(", ");
  const tags = (task.tags || []).map((t) => t.name).join(", ");
  const priority = task.priority?.priority ?? "none";

  let md = `# Task: ${task.name}\n\n`;
  md += `**ID:** ${task.id}  \n`;
  md += `**Status:** ${task.status?.status ?? "unknown"}  \n`;
  md += `**Priority:** ${priority}  \n`;
  md += `**Assignees:** ${assignees || "unassigned"}  \n`;
  if (tags) md += `**Tags:** ${tags}  \n`;
  md += `\n## Description\n\n${task.description || "_No description provided._"}\n\n`;

  if (comments.length > 0) {
    md += `## Discussion / Comments\n\n`;
    for (const c of comments.slice(0, 10)) {
      md += `**${c.user?.username ?? "Unknown"} (${c.date ?? ""}):**\n${c.comment_text}\n\n`;
    }
  }

  return md;
}

module.exports = { getTask, getTaskComments, postComment, extractCustomField, buildTaskSummary };
