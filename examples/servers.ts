// Mock upstream servers for the demo/tests — a realistic fat GitHub call plus a
// small Slack surface, so the SDK runs end-to-end offline.
import { MockUpstream } from "../src/upstream/mock.ts";

function fatPR(n: number) {
  const stale = n % 3 === 0;
  const daysAgo = (d: number) => new Date(Date.UTC(2026, 6, 28 - d)).toISOString();
  const user = (login: string) => ({ login, id: 1000 + n, url: `https://api.github.com/users/${login}`, html_url: `https://github.com/${login}`, type: "User", site_admin: false });
  return {
    id: 500000 + n, number: n, state: "open", locked: false,
    title: `Refactor module ${n}: extract the ${["parser", "cache", "router", "loader"][n % 4]}`,
    user: user(`dev${n % 7}`),
    body: `This PR splits out subsystem ${n}. Reduces coupling; adds migration notes. Fixes #${n + 200}.`,
    labels: [{ id: 1, name: "refactor", color: "blue" }, { id: 2, name: n % 2 ? "needs-review" : "wip", color: "yellow" }],
    created_at: daysAgo(20 - (n % 15)), updated_at: daysAgo(stale ? 10 + (n % 5) : n % 6),
    assignees: [user(`dev${(n + 1) % 7}`)],
    requested_reviewers: stale ? [] : [user(`reviewer${n % 3}`)],
    head: { ref: `feature-${n}`, sha: "a".repeat(40) }, base: { ref: "main", sha: "b".repeat(40) },
    _links: { html: { href: `https://github.com/org/app/pull/${n}` }, self: { href: `https://api.github.com/repos/org/app/pulls/${n}` } },
    comments: n % 4, commits: 1 + (n % 8), additions: 50 + n * 3, deletions: 10 + n, changed_files: 1 + (n % 12),
  };
}

export function githubServer() {
  return new MockUpstream("github", [
    { name: "list_pull_requests", description: "List pull requests on github, with optional state filter and pagination.", aliases: ["PRs", "reviews needed", "open changes"], inputSchema: { type: "object", properties: { state: { type: "string", enum: ["open", "closed", "all"] }, limit: { type: "integer" } } }, handler: () => Array.from({ length: 30 }, (_, i) => fatPR(i + 1)) },
    { name: "get_pull_request", description: "Fetch a single pull request by id, including full detail.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, handler: (a) => fatPR(Number(a.id) || 1) },
    { name: "create_issue", description: "Create a new issue on github.", inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"] }, handler: (a) => ({ id: 42, number: 42, title: a.title }) },
    { name: "list_workflow_runs", description: "List CI workflow runs on github.", aliases: ["CI", "pipeline", "builds"], inputSchema: { type: "object", properties: { status: { type: "string" } } }, handler: () => [{ id: 1, status: "completed", conclusion: "success" }] },
  ]);
}

export function slackServer() {
  return new MockUpstream("slack", [
    { name: "create_message", description: "Post a message to a slack channel.", aliases: ["notify", "chat", "send"], inputSchema: { type: "object", properties: { channel: { type: "string" }, text: { type: "string" } }, required: ["channel", "text"] }, handler: (a) => ({ ok: true, channel: a.channel, ts: "1720000000.000100" }) },
    { name: "list_channels", description: "List slack channels.", inputSchema: { type: "object", properties: {} }, handler: () => [{ id: "C1", name: "general" }, { id: "C2", name: "eng" }] },
    { name: "get_user", description: "Look up a slack user profile by id.", aliases: ["profile", "who is"], inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, handler: (a) => ({ id: a.id, name: "Ada", tz: "UTC" }) },
  ]);
}
