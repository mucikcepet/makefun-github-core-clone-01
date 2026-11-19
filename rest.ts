// REST v3 handlers (/api/v3/...).
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createRepo, getRepo, listViewerRepos, deleteRepo, storeObject, getObject,
  flattenTree, treeFromFiles, makeCommit, parseCommit, isAncestor, reachableObjects,
  newIssueId, newPullId, newCommentId, gid, nextSeq, nowIso, ZERO_OID,
  type Repo, type Issue, type Pull, type PullFile,
} from './store.ts';
import { VIEWER, SCENARIO_EPOCH_SEC } from './scenario.ts';
import { sendJson, errorJson, parseJsonBody, isAuthenticated, viewerUser, parseQuery, decodePathSegment, type ParsedBody } from './http.ts';

export function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.node_id,
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.ownerLogin, id: VIEWER.id, type: 'User', avatar_url: '', html_url: `https://github.com/${repo.ownerLogin}`, url: `/api/v3/users/${repo.ownerLogin}` },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    html_url: `https://github.com/${repo.full_name}`,
    url: `/api/v3/repos/${repo.full_name}`,
    git_url: `git://github.com/${repo.full_name}.git`,
    clone_url: `${baseUrl}/${repo.full_name}.git`,
    ssh_url: `git@github.com:${repo.full_name}.git`,
    homepage: null,
    topics: [],
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    license: null,
    language: null,
    size: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
  };
}
export function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.node_id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color, description: l.description, url: `/api/v3/repos/${repo.full_name}/labels/${encodeURIComponent(l.name)}` })),
    user: { login: issue.user.login, id: issue.user.id, type: 'User' },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: `https://github.com/${repo.full_name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/comments`,
    comments: issue.comments.length,
    assignees: [],
    locked: false,
  };
}
export function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.node_id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: pull.mergeable,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: pull.head.label, user: { login: repo.ownerLogin, id: VIEWER.id } },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: pull.base.label, user: { login: repo.ownerLogin, id: VIEWER.id } },
    user: { login: pull.user.login, id: pull.user.id, type: 'User' },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    html_url: `https://github.com/${repo.full_name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.full_name}/pulls/${pull.number}`,
    draft: false,
    locked: false,
  };
}
function commentJson(c: { id: number; node_id: string; body: string; user: { login: string; id: number }; created_at: string; updated_at: string }, repo: Repo, issueNumber: number): Record<string, unknown> {
  return {
    id: c.id,
    node_id: c.node_id,
    body: c.body,
    user: { login: c.user.login, id: c.user.id, type: 'User' },
    created_at: c.created_at,
    updated_at: c.updated_at,
    html_url: `https://github.com/${repo.full_name}/issues/${issueNumber}#issuecomment-${c.id}`,
    url: `/api/v3/repos/${repo.full_name}/issues/${issueNumber}/comments/${c.id}`,
  };
}
function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length;
}
export function diffFiles(repo: Repo, baseTreeOid: string, headTreeOid: string): PullFile[] {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const files: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (!b && h) {
      const content = getObject(repo, h.oid)?.data.toString('utf8') ?? '';
      const additions = countLines(content);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && !h) {
      const content = getObject(repo, b.oid)?.data.toString('utf8') ?? '';
      const deletions = countLines(content);
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b && h && b.oid !== h.oid) {
      const oldText = getObject(repo, b.oid)?.data.toString('utf8') ?? '';
      const newText = getObject(repo, h.oid)?.data.toString('utf8') ?? '';
      const oldLines = new Set(oldText.split('\n'));
      let additions = 0;
      let deletions = 0;
      for (const line of newText.split('\n')) if (!oldLines.has(line)) additions += 1;
      const newLines = new Set(newText.split('\n'));
      for (const line of oldText.split('\n')) if (!newLines.has(line)) deletions += 1;
      if (additions === 0 && deletions === 0) additions = 1;
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}
function tipTree(repo: Repo, ref: string): string {
  const tip = repo.refs.get(ref);
  if (!tip) return '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const obj = getObject(repo, tip);
  if (!obj || obj.type !== 'commit') return '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  return parseCommit(obj.data).tree;
}
export function createPullInternal(repo: Repo, headRef: string, baseRef: string, title: string, body: string): Pull | null {
  const headTip = repo.refs.get(`refs/heads/${headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headTip || !baseTip) return null;
  const pullId = newPullId();
  const number = repo.nextPull;
  repo.nextPull += 1;
  const files = diffFiles(repo, tipTree(repo, `refs/heads/${baseRef}`), tipTree(repo, `refs/heads/${headRef}`));
  const pull: Pull = {
    id: pullId,
    node_id: gid('PullRequest', `${repo.id}:${number}`),
    number,
    title,
    body,
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    mergeable: true,
    head: { ref: headRef, sha: headTip, label: `${repo.ownerLogin}:${headRef}` },
    base: { ref: baseRef, sha: baseTip, label: `${repo.ownerLogin}:${baseRef}` },
    baseShaAtCreate: baseTip,
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: nowIso(),
    updated_at: nowIso(),
    files,
    seq: nextSeq(),
  };
  repo.pulls.push(pull);
  return pull;
}
export function mergePullInternal(repo: Repo, pull: Pull, method: string): { ok: boolean; sha?: string; message?: string; status?: number } {
  if (pull.state !== 'open') return { ok: false, status: 405, message: 'Pull request is already closed' };
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (!headTip || !baseTip) return { ok: false, status: 404, message: 'Not Found' };
  // Conflict: a file changed on base since PR creation, and changed differently on head.
  const baseAtCreate = flattenTree(repo, tipTree(repo, `refs/heads/${pull.base.ref}`) === '' ? '' : (() => {
    const obj = getObject(repo, pull.baseShaAtCreate);
    return obj ? parseCommit(obj.data).tree : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  })());
  const baseNow = flattenTree(repo, tipTree(repo, `refs/heads/${pull.base.ref}`));
  const headNow = flattenTree(repo, tipTree(repo, `refs/heads/${pull.head.ref}`));
  let conflict = false;
  for (const [path, h] of headNow) {
    const bc = baseAtCreate.get(path);
    const bn = baseNow.get(path);
    if (bc && bn && bc.oid !== bn.oid && h.oid !== bn.oid && h.oid !== bc.oid) conflict = true;
    if (!bc && bn && h.oid !== bn.oid) conflict = true;
  }
  // Also: file deleted on base but modified on head.
  for (const [path, bc] of baseAtCreate) {
    if (!baseNow.has(path) && headNow.has(path) && headNow.get(path)?.oid !== bc.oid) conflict = true;
  }
  if (conflict) {
    pull.mergeable = false;
    return { ok: false, status: 405, message: 'Merge conflict' };
  }
  const headTree = tipTree(repo, `refs/heads/${pull.head.ref}`);
  const message = method === 'squash' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.head.ref}`;
  const sha = makeCommit(repo, headTree, [baseTip], message, SCENARIO_EPOCH_SEC + pull.number);
  repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = nowIso();
  pull.merge_commit_sha = sha;
  pull.updated_at = nowIso();
  return { ok: true, sha, message: 'Pull request successfully merged' };
}
function paginate<T>(items: T[], query: URLSearchParams, basePath: string, req: IncomingMessage): { page: T[]; link: string } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link = '';
  const host = req.headers.host ?? 'localhost';
  if (start + perPage < items.length) {
    const next = new URL(basePath, `http://${host}`);
    const q = new URLSearchParams(query);
    q.set('page', String(page + 1));
    q.set('per_page', String(perPage));
    next.search = q.toString();
    link = `<${next.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}
function linkHeader(res: ServerResponse, link: string): Record<string, string> {
  return link ? { link } : {};
}

// Body for POST/PUT/PATCH: parse JSON, 400 on malformed.
async function bodyOr400(req: IncomingMessage, res: ServerResponse): Promise<ParsedBody | null> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok) {
    errorJson(res, 400, 'Invalid JSON');
    return null;
  }
  return parsed;
}
function asObj(v: unknown): Record<string, unknown> {
  return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, baseUrl: string): Promise<boolean> {
  const path = (() => {
    try {
      return new URL(req.url ?? '/', 'http://entry').pathname;
    } catch {
      return '/';
    }
  })();
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const query = parseQuery(req);
  // Auth: every REST call needs the bearer token (except none here).
  if (!isAuthenticated(req)) {
    errorJson(res, 401, 'Bad credentials');
    return true;
  }
  const sub = path.slice('/api/v3'.length) || '/';

  // GET /api/v3/ root
  if (method === 'GET' && (sub === '/' || sub === '')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && sub === '/meta') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', github_services_sha: '0000000000000000000000000000000000000000' });
    return true;
  }
  if (method === 'GET' && sub === '/rate_limit') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 5000, reset: 1735689600 } }, rate: { limit: 5000, remaining: 5000, reset: 1735689600 } });
    return true;
  }
  if (method === 'GET' && sub === '/user') {
    sendJson(res, 200, viewerUser());
    return true;
  }
  // POST /user/repos and GET /user/repos
  if (sub === '/user/repos') {
    if (method === 'POST') {
      const parsed = await bodyOr400(req, res);
      if (!parsed) return true;
      const body = asObj(parsed.value);
      const name = String(body.name ?? '');
      if (!name) {
        errorJson(res, 422, 'name is required');
        return true;
      }
      if (getRepo(VIEWER.login, name)) {
        errorJson(res, 422, 'Repository already exists');
        return true;
      }
      const repo = createRepo(name, body.private === true, String(body.description ?? ''));
      sendJson(res, 201, repoJson(repo, baseUrl));
      return true;
    }
    if (method === 'GET') {
      const { page, link } = paginate(listViewerRepos(), query, path, req);
      sendJson(res, 200, page.map((r) => repoJson(r, baseUrl)), linkHeader(res, link));
      return true;
    }
  }
  // /repos/{owner}/{repo}...
  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(sub);
  if (repoMatch) {
    const owner = decodePathSegment(repoMatch[1] as string);
    const repoName = decodePathSegment(repoMatch[2] as string);
    const rest = repoMatch[3] ?? '';
    const repo = getRepo(owner, repoName);
    if (!repo) {
      errorJson(res, 404, 'Not Found');
      return true;
    }
    return handleRepoRoute(req, res, repo, rest, method, query, baseUrl);
  }
  // Unknown REST route
  errorJson(res, 404, 'Not Found');
  return true;
}

async function handleRepoRoute(req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string, method: string, query: URLSearchParams, baseUrl: string): Promise<boolean> {
  const parts = rest.split('/').filter((p) => p !== '');
  // GET/PATCH/DELETE /repos/{o}/{r}
  if (parts.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo, baseUrl));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = await bodyOr400(req, res);
      if (!parsed) return true;
      const body = asObj(parsed.value);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) repo.default_branch = body.default_branch;
      repo.updated_at = nowIso();
      sendJson(res, 200, repoJson(repo, baseUrl));
      return true;
    }
    if (method === 'DELETE') {
      deleteRepo(repo);
      res.writeHead(204, { 'x-github-request-id': 'req-deleted' });
      res.end();
      return true;
    }
    errorJson(res, 404, 'Not Found');
    return true;
  }
  const [head, ...tail] = parts as [string, ...string[]];

  // branches
  if (head === 'branches') {
    if (method === 'GET' && tail.length === 0) {
      const branches: Record<string, unknown>[] = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `/api/v3/repos/${repo.full_name}/commits/${sha}` }, protected: false });
      }
      sendJson(res, 200, branches);
      return true;
    }
    if (method === 'GET' && tail.length === 1) {
      const name = decodePathSegment(tail[0] as string);
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (!sha) {
        errorJson(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { name, commit: { sha }, protected: false });
      return true;
    }
  }
  // git/refs
  if (head === 'git' && tail[0] === 'refs') {
    if (method === 'POST' && tail.length === 1) {
      const parsed = await bodyOr400(req, res);
      if (!parsed) return true;
      const body = asObj(parsed.value);
      const ref = String(body.ref ?? '');
      const sha = String(body.sha ?? '');
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !getObject(repo, sha)) {
        errorJson(res, 422, 'Invalid ref or sha');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: gid('Ref', `${repo.id}:${ref}`), url: `/api/v3/repos/${repo.full_name}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.full_name}/git/commits/${sha}` } });
      return true;
    }
    if (method === 'GET' && tail.length >= 2) {
      const ref = `refs/${tail.slice(1).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) {
        errorJson(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { ref, node_id: gid('Ref', `${repo.id}:${ref}`), url: `/api/v3/repos/${repo.full_name}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: 'commit' } });
      return true;
    }
    if (method === 'PATCH' && tail.length >= 2) {
      const ref = `refs/${tail.slice(1).join('/')}`;
      const parsed = await bodyOr400(req, res);
      if (!parsed) return true;
      const body = asObj(parsed.value);
      const sha = String(body.sha ?? '');
      if (!repo.refs.has(ref) || !/^[0-9a-f]{40}$/.test(sha)) {
        errorJson(res, 404, 'Not Found');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 200, { ref, object: { sha, type: 'commit' } });
      return true;
    }
    if (method === 'DELETE' && tail.length >= 2) {
      const ref = `refs/${tail.slice(1).join('/')}`;
      if (!repo.refs.has(ref)) {
        errorJson(res, 404, 'Not Found');
        return true;
      }
      repo.refs.delete(ref);
      res.writeHead(204, { 'x-github-request-id': 'req-deleted' });
      res.end();
      return true;
    }
  }
  // git/commits (read one)
  if (head === 'git' && tail[0] === 'commits' && method === 'GET' && tail.length === 2) {
    const sha = tail[1] as string;
    const obj = getObject(repo, sha);
    if (!obj || obj.type !== 'commit') {
      errorJson(res, 404, 'Not Found');
      return true;
    }
    const c = parseCommit(obj.data);
    sendJson(res, 200, { sha, node_id: gid('Commit', sha), message: c.message, tree: { sha: c.tree }, parents: c.parents.map((p) => ({ sha: p })) });
    return true;
  }
  // commits list
  if (head === 'commits' && method === 'GET' && tail.length === 0) {
    const shaParam = query.get('sha');
    let tip: string | undefined;
    if (shaParam) tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (getObject(repo, shaParam) ? shaParam : undefined);
    else tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
    const list: Record<string, unknown>[] = [];
    if (tip) {
      const seen = new Set<string>();
      const stack = [tip];
      while (stack.length) {
        const oid = stack.pop() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = getObject(repo, oid);
        if (!obj || obj.type !== 'commit') continue;
        const c = parseCommit(obj.data);
        // GitHub's REST API returns the message without the object's trailing newline.
        const displayMessage = c.message.endsWith('\n') ? c.message.slice(0, -1) : c.message;
        list.push({ sha: oid, node_id: gid('Commit', oid), commit: { message: displayMessage, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } }, parents: c.parents.map((p) => ({ sha: p })) });
        for (const p of c.parents) stack.push(p);
      }
    }
    const { page, link } = paginate(list, query, `/api/v3/repos/${repo.full_name}/commits`, req);
    sendJson(res, 200, page, linkHeader(res, link));
    return true;
  }
  // contents
  if (head === 'contents') {
    const filePath = tail.map(decodePathSegment).join('/');
    return handleContents(req, res, repo, filePath, method, query);
  }
  // labels
  if (head === 'labels') {
    if (method === 'POST' && tail.length === 0) {
      const parsed = await bodyOr400(req, res);
      if (!parsed) return true;
      const body = asObj(parsed.value);
      const name = String(body.name ?? '');
      if (!name) {
        errorJson(res, 422, 'name is required');
        return true;
      }
      const existing = repo.labels.find((l) => l.name === name);
      if (existing) {
        sendJson(res, 200, { id: existing.id, name: existing.name, color: existing.color, description: existing.description, url: `/api/v3/repos/${repo.full_name}/labels/${encodeURIComponent(name)}` });
        return true;
      }
      const label = { id: repo.nextLabelId, name, color: String(body.color ?? 'ededed'), description: String(body.description ?? '') };
      repo.nextLabelId += 1;
      repo.labels.push(label);
      sendJson(res, 201, { id: label.id, name: label.name, color: label.color, description: label.description, url: `/api/v3/repos/${repo.full_name}/labels/${encodeURIComponent(name)}` });
      return true;
    }
    if (method === 'GET' && tail.length === 0) {
      sendJson(res, 200, repo.labels.map((l) => ({ id: l.id, name: l.name, color: l.color, description: l.description })));
      return true;
    }
    if (method === 'GET' && tail.length === 1) {
      const label = repo.labels.find((l) => l.name === decodePathSegment(tail[0] as string));
      if (!label) {
        errorJson(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { id: label.id, name: label.name, color: label.color, description: label.description });
      return true;
    }
  }
  // issues
  if (head === 'issues') {
    return handleIssues(req, res, repo, tail, method, query);
  }
  // pulls
  if (head === 'pulls') {
    return handlePulls(req, res, repo, tail, method, query);
  }
  errorJson(res, 404, 'Not Found');
  return true;
}

async function handleContents(req: IncomingMessage, res: ServerResponse, repo: Repo, filePath: string, method: string, query: URLSearchParams): Promise<boolean> {
  const refName = query.get('ref') ?? repo.default_branch;
  const ref = `refs/heads/${refName}`;
  const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${repo.default_branch}`);
  const treeOid = tip ? parseCommit(getObject(repo, tip)?.data ?? Buffer.alloc(0)).tree : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const files = flattenTree(repo, treeOid);
  // For PUT/DELETE the file set must come from the branch being written,
  // which may differ from the ?ref branch used for GET.
  const filesForBranch = (branch: string): Map<string, { oid: string; mode: string }> => {
    const bTip = repo.refs.get(`refs/heads/${branch}`);
    if (!bTip) return new Map();
    if (bTip === tip) return files;
    const bTree = parseCommit(getObject(repo, bTip)?.data ?? Buffer.alloc(0)).tree;
    return flattenTree(repo, bTree);
  };
  if (method === 'GET') {
    // Directory?
    const prefix = filePath ? `${filePath}/` : '';
    const dirEntries: Record<string, unknown>[] = [];
    const seenDirs = new Set<string>();
    for (const [path, v] of files) {
      if (filePath && !path.startsWith(prefix) && path !== filePath) continue;
      if (path === filePath) {
        const obj = getObject(repo, v.oid);
        const content = obj ? obj.data.toString('base64') : '';
        sendJson(res, 200, { type: 'file', encoding: 'base64', size: obj?.data.length ?? 0, name: filePath.split('/').pop(), path: filePath, content, sha: v.oid, url: `/api/v3/repos/${repo.full_name}/contents/${filePath}`, html_url: `https://github.com/${repo.full_name}/blob/${refName}/${filePath}` });
        return true;
      }
      if (filePath) {
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) dirEntries.push({ type: 'file', name: rest, path, sha: v.oid, size: getObject(repo, v.oid)?.data.length ?? 0, url: `/api/v3/repos/${repo.full_name}/contents/${path}` });
        else {
          const dir = rest.slice(0, slash);
          if (!seenDirs.has(dir)) {
            seenDirs.add(dir);
            dirEntries.push({ type: 'dir', name: dir, path: `${filePath}/${dir}`, sha: v.oid, url: `/api/v3/repos/${repo.full_name}/contents/${filePath}/${dir}` });
          }
        }
      } else {
        const slash = path.indexOf('/');
        if (slash < 0) dirEntries.push({ type: 'file', name: path, path, sha: v.oid, size: getObject(repo, v.oid)?.data.length ?? 0, url: `/api/v3/repos/${repo.full_name}/contents/${path}` });
        else {
          const dir = path.slice(0, slash);
          if (!seenDirs.has(dir)) {
            seenDirs.add(dir);
            dirEntries.push({ type: 'dir', name: dir, path: dir, sha: v.oid, url: `/api/v3/repos/${repo.full_name}/contents/${dir}` });
          }
        }
      }
    }
    if (filePath && dirEntries.length === 0) {
      errorJson(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, dirEntries.sort((a, b) => String(a.name).localeCompare(String(b.name))));
    return true;
  }
  if (method === 'PUT') {
    const parsed = await bodyOr400(req, res);
    if (!parsed) return true;
    const body = asObj(parsed.value);
    const contentB64 = String(body.content ?? '');
    const branch = String(body.branch ?? refName);
    const branchRef = `refs/heads/${branch}`;
    const branchTip = repo.refs.get(branchRef);
    const message = String(body.message ?? 'Update file');
    let contentBuf: Buffer;
    try {
      contentBuf = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
    } catch {
      errorJson(res, 422, 'Invalid base64 content');
      return true;
    }
    const branchFiles = filesForBranch(branch);
    const existing = branchFiles.get(filePath);
    const isCreate = !existing;
    if (body.sha !== undefined && body.sha !== null) {
      if (!existing || String(body.sha) !== existing.oid) {
        errorJson(res, 409, 'sha does not match');
        return true;
      }
    }
    const blobOid = storeObject(repo, 'blob', contentBuf);
    const newFiles = new Map(branchFiles);
    newFiles.set(filePath, { oid: blobOid, mode: '100644' });
    const newTree = treeFromFiles(repo, newFiles);
    const parents = branchTip ? [branchTip] : [];
    const commitSha = makeCommit(repo, newTree, parents, message, SCENARIO_EPOCH_SEC + nextSeq());
    repo.refs.set(branchRef, commitSha);
    repo.updated_at = nowIso();
    sendJson(res, isCreate ? 201 : 200, {
      content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: contentBuf.length, url: `/api/v3/repos/${repo.full_name}/contents/${filePath}`, html_url: `https://github.com/${repo.full_name}/blob/${branch}/${filePath}`, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, node_id: gid('Commit', commitSha), message, tree: { sha: newTree }, parents: parents.map((p) => ({ sha: p })) },
    });
    return true;
  }
  if (method === 'DELETE') {
    const parsed = await bodyOr400(req, res);
    if (!parsed) return true;
    const body = asObj(parsed.value);
    const branch = String(body.branch ?? refName);
    const branchFiles = filesForBranch(branch);
    const existing = branchFiles.get(filePath);
    if (!existing) {
      errorJson(res, 404, 'Not Found');
      return true;
    }
    if (body.sha !== undefined && body.sha !== null && String(body.sha) !== existing.oid) {
      errorJson(res, 409, 'sha does not match');
      return true;
    }
    const branchRef = `refs/heads/${branch}`;
    const branchTip = repo.refs.get(branchRef);
    const newFiles = new Map(branchFiles);
    newFiles.delete(filePath);
    const newTree = treeFromFiles(repo, newFiles);
    const parents = branchTip ? [branchTip] : [];
    const commitSha = makeCommit(repo, newTree, parents, String(body.message ?? 'Delete file'), SCENARIO_EPOCH_SEC + nextSeq());
    repo.refs.set(branchRef, commitSha);
    sendJson(res, 200, { commit: { sha: commitSha, message: String(body.message ?? 'Delete file') } });
    return true;
  }
  errorJson(res, 404, 'Not Found');
  return true;
}

async function handleIssues(req: IncomingMessage, res: ServerResponse, repo: Repo, tail: string[], method: string, query: URLSearchParams): Promise<boolean> {
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = await bodyOr400(req, res);
      if (!parsed) return true;
      const body = asObj(parsed.value);
      const title = String(body.title ?? '');
      const labelsArg = Array.isArray(body.labels) ? (body.labels as unknown[]) : [];
      const labels: Issue['labels'] = [];
      for (const l of labelsArg) {
        const name = typeof l === 'string' ? l : String((l as Record<string, unknown>).name ?? '');
        const found = repo.labels.find((x) => x.name === name);
        if (!found) {
          errorJson(res, 422, `Label does not exist: ${name}`);
          return true;
        }
        labels.push(found);
      }
      const number = repo.nextIssue;
      repo.nextIssue += 1;
      const issue: Issue = {
        id: newIssueId(),
        node_id: gid('Issue', `${repo.id}:${number}`),
        number,
        title,
        body: String(body.body ?? ''),
        state: 'open',
        labels,
        user: { login: VIEWER.login, id: VIEWER.id },
        created_at: nowIso(),
        updated_at: nowIso(),
        closed_at: null,
        comments: [],
        seq: nextSeq(),
      };
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(issue, repo));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = repo.issues.filter((i) => state === 'all' || i.state === state);
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page, link } = paginate(list, query, `/api/v3/repos/${repo.full_name}/issues`, req);
      sendJson(res, 200, page.map((i) => issueJson(i, repo)), linkHeader(res, link));
      return true;
    }
  }
  const num = parseInt(tail[0] as string, 10);
  const issue = repo.issues.find((i) => i.number === num);
  if (!issue) {
    errorJson(res, 404, 'Not Found');
    return true;
  }
  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(issue, repo));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = await bodyOr400(req, res);
      if (!parsed) return true;
      const body = asObj(parsed.value);
      if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
        issue.state = body.state;
        issue.closed_at = body.state === 'closed' ? nowIso() : null;
      }
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.updated_at = nowIso();
      sendJson(res, 200, issueJson(issue, repo));
      return true;
    }
  }
  if (tail[1] === 'comments') {
    if (method === 'POST') {
      const parsed = await bodyOr400(req, res);
      if (!parsed) return true;
      const body = asObj(parsed.value);
      const id = newCommentId();
      const comment = {
        id,
        node_id: gid('IssueComment', `${repo.id}:${issue.number}:${id}`),
        body: String(body.body ?? ''),
        user: { login: VIEWER.login, id: VIEWER.id },
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      issue.comments.push(comment);
      sendJson(res, 201, commentJson(comment, repo, issue.number));
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => commentJson(c, repo, issue.number)));
      return true;
    }
  }
  errorJson(res, 404, 'Not Found');
  return true;
}

async function handlePulls(req: IncomingMessage, res: ServerResponse, repo: Repo, tail: string[], method: string, query: URLSearchParams): Promise<boolean> {
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = await bodyOr400(req, res);
      if (!parsed) return true;
      const body = asObj(parsed.value);
      const head = String(body.head ?? '');
      const base = String(body.base ?? repo.default_branch);
      const pull = createPullInternal(repo, head, base, String(body.title ?? ''), String(body.body ?? ''));
      if (!pull) {
        errorJson(res, 422, 'Invalid head or base');
        return true;
      }
      sendJson(res, 201, pullJson(pull, repo));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = repo.pulls.filter((p) => state === 'all' || p.state === state);
      list = [...list].sort((a, b) => b.seq - a.seq);
      const { page, link } = paginate(list, query, `/api/v3/repos/${repo.full_name}/pulls`, req);
      sendJson(res, 200, page.map((p) => pullJson(p, repo)), linkHeader(res, link));
      return true;
    }
  }
  const num = parseInt(tail[0] as string, 10);
  const pull = repo.pulls.find((p) => p.number === num);
  if (!pull) {
    errorJson(res, 404, 'Not Found');
    return true;
  }
  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(pull, repo));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = await bodyOr400(req, res);
      if (!parsed) return true;
      const body = asObj(parsed.value);
      if (typeof body.state === 'string' && body.state === 'closed') pull.state = 'closed';
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      pull.updated_at = nowIso();
      sendJson(res, 200, pullJson(pull, repo));
      return true;
    }
  }
  if (tail[1] === 'files' && method === 'GET') {
    sendJson(res, 200, pull.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, patch: f.patch ?? '' })));
    return true;
  }
  if (tail[1] === 'merge' && method === 'PUT') {
    const parsed = await bodyOr400(req, res);
    if (!parsed) return true;
    const body = asObj(parsed.value);
    const result = mergePullInternal(repo, pull, String(body.merge_method ?? 'squash'));
    if (!result.ok) {
      errorJson(res, result.status ?? 405, result.message ?? 'Merge failed');
      return true;
    }
    sendJson(res, 200, { sha: result.sha, merged: true, message: result.message });
    return true;
  }
  if (tail[1] === 'reviews' && method === 'GET') {
    sendJson(res, 200, []);
    return true;
  }
  errorJson(res, 404, 'Not Found');
  return true;
}
