const axios = require("axios");
const logger = require("../utils/logger");

/**
 * Determine the git provider from the repository URL.
 */
function getProviderOptions(repoUrl) {
  if (repoUrl.includes("github.com")) {
    return { provider: "github" };
  } else if (repoUrl.includes("gitlab.com")) {
    return { provider: "gitlab" };
  }
  // Default to GitHub, or you can throw an error for unsupported providers
  logger.warn(`[GitProvider] Unknown provider for URL ${repoUrl}, defaulting to github`);
  return { provider: "github" };
}

/**
 * Parse owner and repo name from a GitHub URL.
 */
function parseGitHubRepo(repoUrl) {
  const match = repoUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Cannot parse GitHub owner/repo from: ${repoUrl}`);
  return { owner: match[1], repo: match[2] };
}

/**
 * Parse project path from a GitLab URL.
 */
function parseGitLabRepo(repoUrl) {
  const match = repoUrl.match(/gitlab\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Cannot parse GitLab project from: ${repoUrl}`);
  return { projectPath: match[1] };
}

/**
 * Create a draft Pull Request / Merge Request on the provider.
 *
 * @param {object} opts
 * @param {string} opts.repoUrl       Remote repo URL
 * @param {string} opts.branchName    Head branch
 * @param {string} opts.baseBranch    Target branch (e.g. "main")
 * @param {string} opts.title         PR/MR title
 * @param {string} opts.body          PR/MR description (markdown)
 * @returns {Promise<string>}          URL of the created PR/MR
 */
async function createPullRequest({ repoUrl, branchName, baseBranch, title, body }) {
  const { provider } = getProviderOptions(repoUrl);
  const targetBranch = baseBranch || process.env.GIT_DEFAULT_BRANCH || "main";

  if (provider === "github") {
    const { owner, repo } = parseGitHubRepo(repoUrl);
    logger.info(`[GitHub] Creating draft PR: ${branchName} → ${targetBranch} in ${owner}/${repo}`);

    const gh = axios.create({
      baseURL: "https://api.github.com",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    const { data } = await gh.post(`/repos/${owner}/${repo}/pulls`, {
      title,
      head: branchName,
      base: targetBranch,
      body,
      draft: true,
    });

    logger.info(`[GitHub] PR created: ${data.html_url}`);
    return data.html_url;
  } else if (provider === "gitlab") {
    const { projectPath } = parseGitLabRepo(repoUrl);
    // GitLab API needs the project path to be URL-encoded
    const encodedProject = encodeURIComponent(projectPath);
    logger.info(`[GitLab] Creating draft MR: ${branchName} → ${targetBranch} in ${projectPath}`);

    const gl = axios.create({
      baseURL: "https://gitlab.com/api/v4",
      headers: {
        "PRIVATE-TOKEN": process.env.GITLAB_TOKEN,
      },
    });

    const { data } = await gl.post(`/projects/${encodedProject}/merge_requests`, {
      title: `Draft: ${title}`, // GitLab marks as draft by prepending "Draft: "
      source_branch: branchName,
      target_branch: targetBranch,
      description: body,
    });

    logger.info(`[GitLab] MR created: ${data.web_url}`);
    return data.web_url;
  }

  throw new Error(`Unsupported git provider for ${repoUrl}`);
}

module.exports = { createPullRequest };
