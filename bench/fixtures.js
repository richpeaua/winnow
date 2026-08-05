// Representative fixtures: ~5 servers / ~80 tools with realistic MCP-style
// schemas, plus a realistic "fat" GitHub PR-list payload for the task.
// Not live servers — a fixed, repeatable surface (per spec M1). Ratios depend
// on this surface; it is deliberately realistic, not tuned to flatter the SDK.

const jsonType = (t) => ({ type: t });

// Build a tool definition the way a host injects it into a model's tool list.
function tool(server, name, description, params) {
  const properties = {};
  const required = [];
  for (const p of params) {
    properties[p.name] = {
      type: p.type,
      description: p.description,
      ...(p.enum ? { enum: p.enum } : {}),
    };
    if (p.required) required.push(p.name);
  }
  return {
    name: `${server}:${name}`,
    description,
    inputSchema: { type: "object", properties, required },
  };
}

// A server defined as operations over resources -> realistic tool fan-out,
// mirroring how real MCP servers (github, slack, ...) expose many tools.
function buildServer(server, resources, ops) {
  const tools = [];
  for (const r of resources) {
    for (const op of ops) {
      if (!op.applies(r)) continue;
      tools.push(
        tool(server, op.name(r), op.desc(r, server), op.params(r))
      );
    }
  }
  return tools;
}

const listP = (r) => [
  { name: "limit", type: "integer", description: `Max ${r.plural} to return (1-100).` },
  { name: "cursor", type: "string", description: "Pagination cursor from a previous page." },
  { name: "state", type: "string", description: `Filter by ${r.singular} state.`, enum: ["open", "closed", "all"] },
];
const getP = (r) => [
  { name: "id", type: "string", description: `The ${r.singular} identifier.`, required: true },
];
const createP = (r) => [
  { name: "title", type: "string", description: `Title of the ${r.singular}.`, required: true },
  { name: "body", type: "string", description: `Body / description of the ${r.singular}.` },
  { name: "labels", type: "array", description: `Labels to attach to the ${r.singular}.` },
];
const updateP = (r) => [
  { name: "id", type: "string", description: `The ${r.singular} identifier.`, required: true },
  { name: "title", type: "string", description: `New title.` },
  { name: "state", type: "string", description: "New state.", enum: ["open", "closed"] },
];

const OPS = [
  { name: (r) => `list_${r.plural}`, desc: (r, s) => `List ${r.plural} on ${s}, with optional state filter and pagination.`, params: listP, applies: () => true },
  { name: (r) => `get_${r.singular}`, desc: (r, s) => `Fetch a single ${r.singular} from ${s} by id, including its full detail.`, params: getP, applies: () => true },
  { name: (r) => `create_${r.singular}`, desc: (r, s) => `Create a new ${r.singular} on ${s}.`, params: createP, applies: (r) => r.writable },
  { name: (r) => `update_${r.singular}`, desc: (r, s) => `Update fields on an existing ${r.singular} on ${s}.`, params: updateP, applies: (r) => r.writable },
];

const R = (singular, plural, writable = true) => ({ singular, plural, writable });

export const SERVERS = {
  github: buildServer("github", [
    R("pull_request", "pull_requests"), R("issue", "issues"), R("repository", "repositories", false),
    R("branch", "branches"), R("release", "releases"), R("workflow_run", "workflow_runs", false),
  ], OPS),
  slack: buildServer("slack", [
    R("message", "messages"), R("channel", "channels"), R("user", "users", false),
  ], OPS),
  filesystem: buildServer("filesystem", [
    R("file", "files"), R("directory", "directories"),
  ], OPS),
  postgres: buildServer("postgres", [
    R("table", "tables", false), R("row", "rows"), R("index", "indexes"),
  ], OPS),
  websearch: buildServer("websearch", [
    R("result", "results", false), R("page", "pages", false),
  ], OPS),
};

export const ALL_TOOLS = Object.values(SERVERS).flat();

// ---- The four meta-tools the SDK surfaces to the model instead of all schemas.
export const META_TOOLS = [
  tool("mcp", "search_tools", "Search available tools across all connected MCP servers by natural-language intent. Returns a ranked list of minimal tool entries (id, name, one-line summary, server). Load a tool's full schema with load_tool before calling.", [
    { name: "query", type: "string", description: "Natural-language description of what you want to do.", required: true },
    { name: "topK", type: "integer", description: "Max results to return (default 8)." },
  ]),
  tool("mcp", "load_tool", "Load the full input schema(s) for one or more tool ids returned by search_tools, so you can call them correctly.", [
    { name: "ids", type: "array", description: "Tool id or ids to load full schemas for.", required: true },
  ]),
  tool("mcp", "call_tool", "Call a single tool by id. Optionally pass a JMESPath projection and token cap to trim the result before it returns.", [
    { name: "id", type: "string", description: "Tool id, e.g. 'github:list_pull_requests'.", required: true },
    { name: "args", type: "object", description: "Arguments matching the tool's input schema.", required: true },
    { name: "project", type: "string", description: "Optional JMESPath expression to reshape/trim the result." },
    { name: "maxTokens", type: "integer", description: "Optional hard cap on returned tokens (cannot exceed the server default)." },
  ]),
  tool("mcp", "run_code", "Run sandboxed TypeScript against typed per-server modules to compose many tool calls and return only a small computed result. Use for multi-tool workflows and in-code filtering.", [
    { name: "code", type: "string", description: "TypeScript to execute in the sandbox.", required: true },
  ]),
];

// ---- Minimal at-rest catalog entry (what a search hit costs in context).
export function catalogEntry(t) {
  return {
    id: t.name,
    name: t.name.split(":")[1],
    summary: t.description.split(". ")[0].slice(0, 100),
    server: t.name.split(":")[0],
  };
}

// ---- A realistic "fat" response: github:list_pull_requests, GitHub-shaped.
function fatPR(n) {
  const user = (login) => ({
    login, id: 1000 + n, node_id: "U_" + login, avatar_url: `https://avatars.example/${login}.png`,
    gravatar_id: "", url: `https://api.github.com/users/${login}`, html_url: `https://github.com/${login}`,
    type: "User", site_admin: false,
  });
  const daysAgo = (d) => new Date(Date.UTC(2026, 6, 28 - d)).toISOString();
  const stale = n % 3 === 0; // ~1/3 are stale (no review in 7 days)
  return {
    id: 500000 + n, node_id: "PR_" + n, number: n, state: "open", locked: false,
    title: `Refactor module ${n}: extract the ${["parser", "cache", "router", "loader"][n % 4]} into its own package`,
    user: user(`dev${n % 7}`),
    body: `This PR splits out the ${n} subsystem. Motivation: reduce coupling and make the ${n} path independently testable. Includes migration notes and updates the docs. Fixes #${n + 200}.`,
    labels: [
      { id: 1, node_id: "L1", url: "https://api.github.com/labels/1", name: "refactor", color: "blue", default: false, description: "Code refactor" },
      { id: 2, node_id: "L2", url: "https://api.github.com/labels/2", name: n % 2 ? "needs-review" : "wip", color: "yellow", default: false, description: "" },
    ],
    milestone: null, draft: n % 5 === 0,
    created_at: daysAgo(20 - (n % 15)), updated_at: daysAgo(stale ? 10 + (n % 5) : n % 6),
    closed_at: null, merged_at: null,
    assignees: [user(`dev${(n + 1) % 7}`)],
    requested_reviewers: stale ? [] : [user(`reviewer${n % 3}`)],
    requested_teams: [],
    head: { label: `dev:feature-${n}`, ref: `feature-${n}`, sha: "a".repeat(40), user: user(`dev${n % 7}`), repo: { id: 9, name: "app", full_name: "org/app", private: false } },
    base: { label: "org:main", ref: "main", sha: "b".repeat(40), user: user("org"), repo: { id: 9, name: "app", full_name: "org/app", private: false } },
    _links: {
      self: { href: `https://api.github.com/repos/org/app/pulls/${n}` },
      html: { href: `https://github.com/org/app/pull/${n}` },
      comments: { href: `https://api.github.com/repos/org/app/issues/${n}/comments` },
      review_comments: { href: `https://api.github.com/repos/org/app/pulls/${n}/comments` },
      commits: { href: `https://api.github.com/repos/org/app/pulls/${n}/commits` },
    },
    author_association: "CONTRIBUTOR",
    comments: n % 4, review_comments: n % 3, commits: 1 + (n % 8),
    additions: 50 + n * 3, deletions: 10 + n, changed_files: 1 + (n % 12),
  };
}

export const RAW_PR_LIST = Array.from({ length: 30 }, (_, i) => fatPR(i + 1));

// The task: "find open PRs with no review in 7 days, post a one-line summary of
// each to Slack." Stale = requested_reviewers empty AND updated_at > 7d ago.
export const TASK = {
  // Tools the task actually calls.
  usedToolIds: ["github:list_pull_requests", "slack:post_message"],
  // The searches the agent issues to discover them.
  searches: ["list open pull requests", "post a message to a slack channel"],
  // JMESPath the agent (or the tool's static policy) uses to trim the fat call.
  prProjection: "[].{number: number, title: title, url: _links.html.href, updated_at: updated_at, reviewers: requested_reviewers[].login}",
  // Slack call + response are already small.
  slackRawResult: { ok: true, channel: "C123", ts: "1720000000.000100", message: { text: "posted", user: "U0", type: "message" } },
};
