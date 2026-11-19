// MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, modern
// revision 2026-07-28 with server/discover, plus legacy initialize handshake.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRepo, getRepo, newIssueId, gid, type Repo } from './store.ts';
import { VIEWER } from './scenario.ts';
import { readBody, isAuthenticated } from './http.ts';
import { repoJson, issueJson, pullJson, createPullInternal, mergePullInternal } from './rest.ts';

const SERVER_INFO = { name: 'makefun-git-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'Repository name' },
      owner: { type: 'string', description: 'Owner login (the authenticated user)' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'owner/repo' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'owner/repo' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'owner/repo' },
      state: { type: 'string', description: 'Issue state: open, closed, or all' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'owner/repo' },
      title: { type: 'string', description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request body' },
      head: { type: 'string', description: 'Head branch name' },
      base: { type: 'string', description: 'Base branch name' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'owner/repo' },
      pull_number: { type: 'number', description: 'Pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];
function toolsList(): unknown {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object', properties: t.properties, required: t.required },
    })),
  };
}
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
const ALIASES: Record<string, string[]> = {
  create_repo: ['createrepository', 'repocreate', 'reposcreate', 'repositorycreate'],
  get_repo: ['getrepository', 'repoget', 'reposget', 'repositoryget'],
  create_issue: ['issuecreate', 'issuescreate'],
  list_issues: ['issueslist', 'issuelist'],
  create_pull_request: ['pullrequestcreate', 'pullscreate', 'createpr', 'prcreate'],
  merge_pull_request: ['pullrequestmerge', 'pullsmerge', 'mergepr', 'prmerge'],
};
function findTool(name: string): ToolDef | undefined {
  const norm = normalizeName(name);
  for (const tool of TOOLS) {
    if (normalizeName(tool.name) === norm) return tool;
    if (norm.endsWith(normalizeName(tool.name))) return tool;
    for (const alias of ALIASES[tool.name] ?? []) {
      if (norm === alias || norm.endsWith(alias)) return tool;
    }
  }
  return undefined;
}
function arg(args: Record<string, unknown>, ...candidates: string[]): unknown {
  for (const c of candidates) {
    if (args[c] !== undefined && args[c] !== null) return args[c];
  }
  return undefined;
}
function splitFullName(args: Record<string, unknown>): { owner?: string; repo?: string } {
  const full = arg(args, 'full_name', 'fullName') as string | undefined;
  if (full && typeof full === 'string' && full.includes('/')) {
    const [owner, repo] = full.split('/');
    return { owner, repo };
  }
  return {};
}
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  const fromFull = splitFullName(args);
  const owner = String(arg(args, 'owner', 'owner_login', 'org', 'user_login', 'login') ?? fromFull.owner ?? '');
  const repo = String(arg(args, 'repo', 'repository', 'repo_name', 'name') ?? fromFull.repo ?? '');
  return { owner, repo };
}
function toolResult(data: unknown): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data, isError: false };
}
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function callTool(name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; rpcError?: { code: number; message: string } } {
  const tool = findTool(name);
  if (!tool) return { rpcError: { code: -32601, message: `Unknown tool: ${name}` } };
  // Missing required arguments (checked against canonical + synonym names).
  const requiredSynonyms: Record<string, string[]> = {
    name: ['name', 'repo', 'repository'],
    owner: ['owner', 'owner_login', 'org', 'user_login', 'login', 'full_name'],
    repo: ['repo', 'repository', 'repo_name', 'name', 'full_name'],
    title: ['title'],
    head: ['head', 'head_ref', 'source_branch', 'from'],
    base: ['base', 'base_ref', 'target_branch', 'into'],
    pull_number: ['pull_number', 'pr_number', 'number'],
  };
  for (const req of tool.required) {
    const cands = requiredSynonyms[req] ?? [req];
    if (arg(args, ...cands) === undefined) {
      return { rpcError: { code: -32602, message: `Missing required argument: ${req}` } };
    }
  }
  try {
    if (tool.name === 'create_repo') {
      const repoName = String(arg(args, 'name', 'repo', 'repository') ?? '');
      if (getRepo(VIEWER.login, repoName)) return { result: toolError(`Repository ${repoName} already exists`) };
      const repo = createRepo(repoName, arg(args, 'private') === true, String(arg(args, 'description') ?? ''));
      return { result: toolResult({ name: repo.name, full_name: repo.full_name, owner: repo.ownerLogin, private: repo.private, id: repo.id }) };
    }
    const { owner, repo: repoName } = ownerRepo(args);
    const repo = getRepo(owner, repoName);
    if (tool.name === 'get_repo') {
      if (!repo) return { result: toolError(`Repository not found: ${owner}/${repoName}`) };
      return { result: toolResult(repoJson(repo, '')) };
    }
    if (!repo) return { result: toolError(`Repository not found: ${owner}/${repoName}`) };
    if (tool.name === 'create_issue') {
      const title = String(arg(args, 'title') ?? '');
      const body = String(arg(args, 'body', 'description', 'content') ?? '');
      const number = repo.nextIssue;
      repo.nextIssue += 1;
      const issue = {
        id: newIssueId(), node_id: gid('Issue', `${repo.id}:${number}`), number, title, body, state: 'open',
        labels: [] as never[], user: { login: VIEWER.login, id: VIEWER.id },
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), closed_at: null,
        comments: [] as never[], seq: 0,
      };
      repo.issues.push(issue);
      return { result: toolResult({ number, id: issue.node_id, title, body, state: 'open', full_name: repo.full_name }) };
    }
    if (tool.name === 'list_issues') {
      const state = String(arg(args, 'state') ?? 'open');
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      return { result: toolResult({ issues: list.map((i) => ({ number: i.number, title: i.title, body: i.body, state: i.state, id: i.node_id })) }) };
    }
    if (tool.name === 'create_pull_request') {
      const title = String(arg(args, 'title') ?? '');
      const body = String(arg(args, 'body', 'description', 'content') ?? '');
      const head = String(arg(args, 'head', 'head_ref', 'source_branch', 'from') ?? '');
      const base = String(arg(args, 'base', 'base_ref', 'target_branch', 'into') ?? repo.default_branch);
      const pull = createPullInternal(repo, head, base, title, body);
      if (!pull) return { result: toolError(`Invalid head or base ref: ${head} / ${base}`) };
      return { result: toolResult({ number: pull.number, id: pull.node_id, title, state: 'open', head: { ref: head }, base: { ref: base } }) };
    }
    if (tool.name === 'merge_pull_request') {
      const num = Number(arg(args, 'pull_number', 'pr_number', 'number'));
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return { result: toolError(`Pull request not found: ${num}`) };
      const result = mergePullInternal(repo, pull, 'squash');
      if (!result.ok) return { result: toolError(result.message ?? 'Merge failed') };
      return { result: toolResult({ number: pull.number, merged: true, sha: result.sha, state: 'closed' }) };
    }
  } catch (e) {
    return { result: toolError(e instanceof Error ? e.message : String(e)) };
  }
  return { rpcError: { code: -32601, message: `Unknown tool: ${name}` } };
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const raw = await readBody(req);
  const sendRpc = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): void => {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'x-github-request-id': `req-mcp-${Date.now().toString(36)}`, ...extraHeaders });
    res.end(text);
  };
  if (!isAuthenticated(req)) {
    sendRpc(401, { message: 'Bad credentials' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    let id: unknown = null;
    const m = /"id"\s*:\s*(\d+)/.exec(raw.toString('utf8'));
    if (m) id = Number(m[1]);
    sendRpc(400, { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const id = obj.id ?? null;
  const method = String(obj.method ?? '');
  const params = (obj.params ?? {}) as Record<string, unknown>;
  // Notifications have no id: answer 202 with no body.
  if (obj.id === undefined) {
    res.writeHead(202);
    res.end();
    return true;
  }
  if (method === 'server/discover') {
    sendRpc(200, {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2026-07-28',
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      },
    });
    return true;
  }
  if (method === 'initialize') {
    const requested = (params.protocolVersion as string) || '2026-07-28';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    sendRpc(200, {
      jsonrpc: '2.0', id,
      result: { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
    }, { 'mcp-session-id': 'forge-session-1' });
    return true;
  }
  if (method === 'ping') {
    sendRpc(200, { jsonrpc: '2.0', id, result: {} });
    return true;
  }
  if (method === 'tools/list') {
    sendRpc(200, { jsonrpc: '2.0', id, result: toolsList() });
    return true;
  }
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const out = callTool(name, args);
    if (out.rpcError) {
      sendRpc(200, { jsonrpc: '2.0', id, error: out.rpcError });
      return true;
    }
    sendRpc(200, { jsonrpc: '2.0', id, result: out.result });
    return true;
  }
  sendRpc(200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  return true;
}
