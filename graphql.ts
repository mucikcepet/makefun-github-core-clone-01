// Minimal GraphQL v4 executor for the documents gh / github-mcp-server send.
// Parses a small subset of the GraphQL language (operations, variables,
// aliases, inline fragments, input objects/lists/enums) and resolves against
// the same in-memory store as REST.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRepo, listViewerRepos, getObject, parseCommit, newCommentId, gid, type Repo, type Issue, type Pull } from './store.ts';
import { createPullInternal, mergePullInternal } from './rest.ts';
import { VIEWER } from './scenario.ts';
import { sendJson, errorJson, parseJsonBody, isAuthenticated } from './http.ts';

// ---------- tokenizer / parser ----------
type Token = { kind: string; value: string };
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c) || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: '...', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(c)) { tokens.push({ kind: c, value: c }); i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; } else { out += src[j]; j += 1; }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}
interface Selection {
  kind: 'field' | 'fragment';
  alias?: string;
  name?: string;
  args?: Record<string, unknown>;
  selections?: Selection[];
  typeCondition?: string;
}
interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  variableDefs?: Record<string, { default?: unknown }>;
  selections: Selection[];
}
class Parser {
  tokens: Token[];
  pos = 0;
  constructor(src: string) { this.tokens = tokenize(src); }
  peek(): Token { return this.tokens[this.pos] as Token; }
  next(): Token { return this.tokens[this.pos++] as Token; }
  expect(kind: string): Token {
    const t = this.next();
    if (t.kind !== kind) throw new Error(`expected ${kind}, got ${t.kind}`);
    return t;
  }
  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === '{') {
        ops.push({ type: 'query', selections: this.parseSelectionSet() });
      } else if (this.peek().kind === 'name' && (this.peek().value === 'query' || this.peek().value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableDefs: Record<string, { default?: unknown }> = {};
        if (this.peek().kind === '(') {
          this.next();
          while (this.peek().kind !== ')') {
            if (this.peek().kind === '$') {
              this.next();
              const vname = this.expect('name').value;
              // skip type (name, [, ], !)
              while (this.peek().kind === 'name' || this.peek().kind === '[' || this.peek().kind === ']' || this.peek().kind === '!') this.next();
              let def: unknown;
              if (this.peek().kind === '=') { this.next(); def = this.parseValue({}); }
              variableDefs[vname] = { default: def };
            } else this.next();
          }
          this.expect(')');
        }
        ops.push({ type, name, variableDefs, selections: this.parseSelectionSet() });
      } else if (this.peek().kind === 'name' && this.peek().value === 'fragment') {
        // Skip fragment definitions (inline fragments are handled in selections);
        // named fragments are not used by the suite's documents.
        this.next();
        if (this.peek().kind === 'name') this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') { this.next(); if (this.peek().kind === 'name') this.next(); }
        this.parseSelectionSet();
      } else {
        this.next();
      }
    }
    return ops;
  }
  parseSelectionSet(): Selection[] {
    this.expect('{');
    const sels: Selection[] = [];
    while (this.peek().kind !== '}') {
      if (this.peek().kind === 'eof') break;
      sels.push(this.parseSelection());
    }
    this.expect('}');
    return sels;
  }
  parseSelection(): Selection {
    if (this.peek().kind === '...') {
      this.next();
      let typeCondition: string | undefined;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expect('name').value;
      } else if (this.peek().kind === 'name') {
        // named fragment spread: skip (not used)
        this.next();
        return { kind: 'fragment', selections: [] };
      }
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    let alias: string | undefined;
    let name = this.expect('name').value;
    if (this.peek().kind === ':') {
      this.next();
      alias = name;
      name = this.expect('name').value;
    }
    let args: Record<string, unknown> | undefined;
    if (this.peek().kind === '(') args = this.parseArgs({});
    let selections: Selection[] | undefined;
    if (this.peek().kind === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }
  parseArgs(vars: Record<string, unknown>): Record<string, unknown> {
    this.expect('(');
    const args: Record<string, unknown> = {};
    while (this.peek().kind !== ')') {
      const name = this.expect('name').value;
      this.expect(':');
      args[name] = this.parseValue(vars);
    }
    this.expect(')');
    return args;
  }
  parseValue(vars: Record<string, unknown>): unknown {
    const t = this.peek();
    if (t.kind === '$') {
      this.next();
      const name = this.expect('name').value;
      return { __var: name, __vars: vars };
    }
    if (t.kind === 'string') { this.next(); return t.value; }
    if (t.kind === 'number') { this.next(); return Number(t.value); }
    if (t.kind === '{') {
      this.next();
      const obj: Record<string, unknown> = {};
      while (this.peek().kind !== '}') {
        const k = this.expect('name').value;
        this.expect(':');
        obj[k] = this.parseValue(vars);
      }
      this.expect('}');
      return obj;
    }
    if (t.kind === '[') {
      this.next();
      const arr: unknown[] = [];
      while (this.peek().kind !== ']') arr.push(this.parseValue(vars));
      this.expect(']');
      return arr;
    }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return { __enum: t.value };
    }
    throw new Error(`unexpected token ${t.kind}`);
  }
}
function resolveVars(value: unknown, vars: Record<string, unknown>, defs: Record<string, { default?: unknown }>): unknown {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('__var' in v) {
      const name = v.__var as string;
      return name in vars ? vars[name] : defs[name]?.default ?? null;
    }
    if ('__enum' in v) return v.__enum as string;
    if (Array.isArray(value)) return (value as unknown[]).map((x) => resolveVars(x, vars, defs));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = resolveVars(x, vars, defs);
    return out;
  }
  return value;
}
function resolveArgs(sel: Selection, vars: Record<string, unknown>, defs: Record<string, { default?: unknown }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sel.args ?? {})) out[k] = resolveVars(v, vars, defs);
  return out;
}

// ---------- schema ----------
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'createdAt', 'updatedAt', 'url', 'author'],
  IssueConnection: ['nodes', 'pageInfo', 'edges', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'edges', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  User: ['login', 'id', 'name', 'email'],
  Ref: ['name'],
  PullRequestChangedFile: ['path'],
  IssueComment: ['id', 'body'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};
const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};
const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'createdAt', 'updatedAt', 'url', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['login', 'id', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'edges', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'edges', 'totalCount'],
};

// ---------- resolvers ----------
interface Ctx {
  errors: Array<{ message: string }>;
  vars: Record<string, unknown>;
  defs: Record<string, { default?: unknown }>;
}
function err(ctx: Ctx, message: string): void {
  ctx.errors.push({ message });
}
function findRepoByGlobalId(id: string): Repo | undefined {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const m = /^Repository:(\d+)$/.exec(decoded);
    if (!m) return undefined;
    const repoId = parseInt(m[1] as string, 10);
    return listViewerRepos().find((r) => r.id === repoId);
  } catch {
    return undefined;
  }
}
function findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | undefined {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const m = /^Issue:(\d+):(\d+)$/.exec(decoded);
    if (!m) return undefined;
    const repo = listViewerRepos().find((r) => r.id === parseInt(m[1] as string, 10));
    const issue = repo?.issues.find((i) => i.number === parseInt(m[2] as string, 10));
    return repo && issue ? { repo, issue } : undefined;
  } catch {
    return undefined;
  }
}
function findPullByGlobalId(id: string): { repo: Repo; pull: Pull } | undefined {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const m = /^PullRequest:(\d+):(\d+)$/.exec(decoded);
    if (!m) return undefined;
    const repo = listViewerRepos().find((r) => r.id === parseInt(m[1] as string, 10));
    const pull = repo?.pulls.find((p) => p.number === parseInt(m[2] as string, 10));
    return repo && pull ? { repo, pull } : undefined;
  } catch {
    return undefined;
  }
}
function cursorFor(n: number): string {
  return Buffer.from(`issue:${n}`, 'utf8').toString('base64');
}
function cursorToNumber(cursor: string): number | null {
  try {
    const m = /^issue:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return m ? parseInt(m[1] as string, 10) : null;
  } catch {
    return null;
  }
}

type Value = Record<string, unknown> | null;
function resolveSelections(obj: Value, typeName: string, sels: Selection[] | undefined, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!sels) return out;
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== typeName) continue;
      Object.assign(out, resolveSelections(obj, typeName, sel.selections, ctx));
      continue;
    }
    const field = sel.name as string;
    const key = sel.alias ?? field;
    const allowed = TYPE_FIELDS[typeName] ?? [];
    if (!allowed.includes(field)) {
      err(ctx, `Cannot query field "${field}" on type "${typeName}".`);
      out[key] = null;
      continue;
    }
    out[key] = resolveField(obj, typeName, sel, ctx);
  }
  return out;
}
function resolveField(obj: Value, typeName: string, sel: Selection, ctx: Ctx): unknown {
  const field = sel.name as string;
  const args = resolveArgs(sel, ctx.vars, ctx.defs);
  const sels = sel.selections;
  if (typeName === 'Query') {
    if (field === 'viewer') {
      return resolveSelections({ login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email } as unknown as Value, 'User', sels, ctx);
    }
    if (field === 'repository') {
      const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) return null;
      return resolveSelections(repoToValue(repo), 'Repository', sels, ctx);
    }
    if (field === 'node') {
      const id = String(args.id ?? '');
      const repo = findRepoByGlobalId(id);
      if (repo) return resolveSelections(repoToValue(repo), 'Repository', sels, ctx);
      const issue = findIssueByGlobalId(id);
      if (issue) return resolveSelections(issueToValue(issue.issue), 'Issue', sels, ctx);
      return null;
    }
    if (field === '__type') {
      const name = String(args.name ?? '');
      const fields = INTROSPECTION_FIELDS[name];
      const enums = ENUM_VALUES[name];
      const result: Record<string, unknown> = { name };
      if (fields) result.fields = fields.map((f) => ({ name: f }));
      if (enums) result.enumValues = enums.map((e) => ({ name: e }));
      // __type selections may ask for fields/enumValues with sub-selections.
      if (sels) {
        const out: Record<string, unknown> = {};
        for (const s of sels) {
          if (s.kind === 'fragment') continue;
          const k = s.alias ?? s.name;
          if (s.name === 'fields') out[k as string] = fields ? fields.map((f) => ({ name: f })) : null;
          else if (s.name === 'enumValues') out[k as string] = enums ? enums.map((e) => ({ name: e })) : null;
          else if (s.name === 'name') out[k as string] = name;
          else out[k as string] = null;
        }
        return out;
      }
      return result;
    }
    return null;
  }
  if (typeName === 'Mutation') {
    return resolveMutation(sel, ctx);
  }
  if (!obj) return null;
  const o = obj as Record<string, unknown>;
  // Scalar / nested fields on entity values (already computed in toValue).
  if (field === 'issues' && typeName === 'Repository') return issuesConnection(o.__repo as Repo, args, sels, ctx);
  if (field === 'issue' && typeName === 'Repository') {
    const repo = o.__repo as Repo;
    const issue = repo.issues.find((i) => i.number === Number(args.number));
    return issue ? resolveSelections(issueToValue(issue), 'Issue', sels, ctx) : null;
  }
  if (field === 'pullRequests' && typeName === 'Repository') {
    const repo = o.__repo as Repo;
    const first = typeof args.first === 'number' ? args.first : undefined;
    const nodes = [...repo.pulls].sort((a, b) => b.seq - a.seq).slice(0, first);
    return resolveSelections({ __nodes: nodes.map((p) => pullToValue(p)), __pageInfo: { hasNextPage: false, endCursor: null } } as unknown as Value, 'PullRequestConnection', sels, ctx);
  }
  if (field === 'pullRequest' && typeName === 'Repository') {
    const repo = o.__repo as Repo;
    const pull = repo.pulls.find((p) => p.number === Number(args.number));
    return pull ? resolveSelections(pullToValue(pull), 'PullRequest', sels, ctx) : null;
  }
  if (field === 'files' && typeName === 'PullRequest') {
    const pull = (o.__pull as Pull) ?? null;
    const nodes = (pull?.files ?? []).map((f) => ({ path: f.filename }));
    const first = typeof args.first === 'number' ? args.first : undefined;
    const sliced = first !== undefined ? nodes.slice(0, first) : nodes;
    return resolveSelections({ __nodes: sliced, __pageInfo: { hasNextPage: false, endCursor: null } } as unknown as Value, 'PullRequestConnection', sels, ctx);
  }
  if (field === 'owner' && typeName === 'Repository') {
    return resolveSelections({ login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email } as unknown as Value, 'User', sels, ctx);
  }
  if (field === 'defaultBranchRef' && typeName === 'Repository') {
    return resolveSelections({ name: (o.__repo as Repo).default_branch } as unknown as Value, 'Ref', sels, ctx);
  }
  if (field === 'nodes' && (typeName === 'IssueConnection' || typeName === 'PullRequestConnection')) {
    const nodes = (o.__nodes as Array<Record<string, unknown>>) ?? [];
    if (typeName === 'IssueConnection') return nodes.map((n) => resolveSelections(n as Value, 'Issue', sels, ctx));
    // PullRequestConnection carries either pull requests (number) or changed
    // files (path) depending on the field that built it.
    return nodes.map((n) => resolveSelections(n as Value, 'number' in n ? 'PullRequest' : 'PullRequestChangedFile', sels, ctx));
  }
  if (field === 'pageInfo') {
    const pi = (o.__pageInfo as Record<string, unknown>) ?? { hasNextPage: false, endCursor: null };
    return { hasNextPage: pi.hasNextPage ?? false, endCursor: pi.endCursor ?? null, hasPreviousPage: false, startCursor: null };
  }
  if (field === 'edges') return [];
  if (field === 'totalCount') return ((o.__nodes as unknown[]) ?? []).length;
  // Plain scalar stored on the value object; resolve nested selections.
  if (field in o) {
    const raw = o[field];
    if (sels && raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const nested: Record<string, string> = { issue: 'Issue', pullRequest: 'PullRequest', commentEdge: 'CommentEdge', node: 'IssueComment', author: 'User' };
      const nt = nested[field];
      if (nt) return resolveSelections(raw as Value, nt, sels, ctx);
    }
    return raw;
  }
  return null;
}
function issuesConnection(repo: Repo, args: Record<string, unknown>, sels: Selection[] | undefined, ctx: Ctx): Record<string, unknown> {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (states && states.length) list = list.filter((i) => states.includes(i.state.toUpperCase()));
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy?.field === 'CREATED_AT') {
    list.sort((a, b) => (orderBy.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  } else if (orderBy?.field === 'UPDATED_AT') {
    list.sort((a, b) => (orderBy.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  } else {
    list.sort((a, b) => a.seq - b.seq);
  }
  const after = args.after as string | null | undefined;
  if (after) {
    const n = cursorToNumber(after);
    if (n !== null) list = list.filter((i) => i.number > n);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > first;
  const endCursor = page.length ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
  const value: Value = { __nodes: page.map((i) => issueToValue(i)), __pageInfo: { hasNextPage, endCursor } } as unknown as Value;
  return resolveSelections(value, 'IssueConnection', sels, ctx);
}
function repoToValue(repo: Repo): Value {
  return {
    id: repo.node_id,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.full_name,
    owner: null,
    defaultBranchRef: null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    __repo: repo,
  } as unknown as Value;
}
function issueToValue(issue: Issue): Value {
  return {
    id: issue.node_id,
    number: issue.number,
    title: issue.title,
    state: issue.state.toUpperCase(),
    body: issue.body,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    url: `https://github.com/issues/${issue.number}`,
    author: { login: issue.user.login, id: issue.user.id },
  } as unknown as Value;
}
function pullToValue(pull: Pull): Value {
  return {
    id: pull.node_id,
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    mergeable: pull.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    body: pull.body,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    url: `https://github.com/pull/${pull.number}`,
    author: { login: pull.user.login, id: pull.user.id },
    __pull: pull,
  } as unknown as Value;
}
function resolveMutation(sel: Selection, ctx: Ctx): unknown {
  const field = sel.name as string;
  const args = resolveArgs(sel, ctx.vars, ctx.defs);
  const input = (args.input ?? {}) as Record<string, unknown>;
  const sels = sel.selections;
  if (field === 'createIssue') {
    const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
    if (!repo) {
      err(ctx, 'Could not resolve to a Repository with the global id.');
      return null;
    }
    const number = repo.nextIssue;
    repo.nextIssue += 1;
    const issue: Issue = {
      id: 0,
      node_id: '',
      number,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      labels: [],
      user: { login: VIEWER.login, id: VIEWER.id },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      closed_at: null,
      comments: [],
      seq: 0,
    };
    // Reuse REST id allocation via a counter in store: node_id from gid.
    issue.node_id = gid('Issue', `${repo.id}:${number}`);
    issue.id = 10000 + repo.id * 1000 + number;
    repo.issues.push(issue);
    const value: Value = { issue: issueToValue(issue) } as unknown as Value;
    return resolveSelections(value, 'CreateIssuePayload', sels, ctx);
  }
  if (field === 'closeIssue') {
    const found = findIssueByGlobalId(String(input.issueId ?? ''));
    if (!found) {
      err(ctx, 'Could not resolve to an Issue with the global id.');
      return null;
    }
    found.issue.state = 'closed';
    found.issue.closed_at = new Date().toISOString();
    const value: Value = { issue: issueToValue(found.issue) } as unknown as Value;
    return resolveSelections(value, 'CloseIssuePayload', sels, ctx);
  }
  if (field === 'createPullRequest') {
    const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
    if (!repo) {
      err(ctx, 'Could not resolve to a Repository with the global id.');
      return null;
    }
    const pull = createPullInternal(repo, String(input.headRefName ?? ''), String(input.baseRefName ?? repo.default_branch), String(input.title ?? ''), String(input.body ?? ''));
    if (!pull) {
      err(ctx, 'Invalid head or base ref.');
      return null;
    }
    const value: Value = { pullRequest: pullToValue(pull) } as unknown as Value;
    return resolveSelections(value, 'CreatePullRequestPayload', sels, ctx);
  }
  if (field === 'mergePullRequest') {
    const found = findPullByGlobalId(String(input.pullRequestId ?? ''));
    if (!found) {
      err(ctx, 'Could not resolve to a PullRequest with the global id.');
      return null;
    }
    const result = mergePullInternal(found.repo, found.pull, String(input.mergeMethod ?? 'SQUASH') === 'SQUASH' ? 'squash' : 'merge');
    if (!result.ok) {
      err(ctx, result.message ?? 'Merge failed.');
      return null;
    }
    const value: Value = { pullRequest: pullToValue(found.pull) } as unknown as Value;
    return resolveSelections(value, 'MergePullRequestPayload', sels, ctx);
  }
  if (field === 'addComment') {
    const found = findIssueByGlobalId(String(input.subjectId ?? ''));
    if (!found) {
      err(ctx, 'Could not resolve to an Issue with the global id.');
      return null;
    }
    const id = newCommentId();
    const comment = { id, node_id: gid('IssueComment', `${found.repo.id}:${found.issue.number}:${id}`), body: String(input.body ?? ''), user: { login: VIEWER.login, id: VIEWER.id }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    found.issue.comments.push(comment);
    const value: Value = { commentEdge: { node: { id: comment.node_id, body: comment.body } } } as unknown as Value;
    return resolveSelections(value, 'AddCommentPayload', sels, ctx);
  }
  err(ctx, `Cannot query field "${field}" on type "Mutation".`);
  return null;
}
// Payload types: resolve nested selections generically.
const PAYLOAD_FIELDS: Record<string, string[]> = {
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
};

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!isAuthenticated(req)) {
    errorJson(res, 401, 'Bad credentials');
    return true;
  }
  const parsed = await parseJsonBody(req);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON' }] });
    return true;
  }
  const bodies = Array.isArray(parsed.value) ? (parsed.value as unknown[]) : [parsed.value];
  const results: unknown[] = [];
  for (const body of bodies) {
    const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const query = String(obj.query ?? '');
    const variables = (obj.variables ?? {}) as Record<string, unknown>;
    if (!query) {
      results.push({ errors: [{ message: 'No query provided' }] });
      continue;
    }
    let ops: Operation[];
    try {
      ops = new Parser(query).parseDocument();
    } catch (e) {
      results.push({ errors: [{ message: e instanceof Error ? e.message : 'Parse error' }] });
      continue;
    }
    const op = ops[0];
    if (!op) {
      results.push({ errors: [{ message: 'No operation' }] });
      continue;
    }
    // Payload type field sets for mutation results.
    for (const [k, v] of Object.entries(PAYLOAD_FIELDS)) TYPE_FIELDS[k] = v;
    TYPE_FIELDS['CommentEdge'] = ['node'];
    TYPE_FIELDS['IssueComment'] = ['id', 'body'];
    const ctx: Ctx = { errors: [], vars: variables, defs: op.variableDefs ?? {} };
    const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
    // Resolve top-level selections with payload-aware typing.
    const data: Record<string, unknown> = {};
    for (const sel of op.selections) {
      if (sel.kind === 'fragment') continue;
      const key = sel.alias ?? sel.name;
      const allowed = TYPE_FIELDS[rootType] ?? [];
      if (!(allowed as string[]).includes(sel.name as string)) {
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${rootType}".` });
        data[key as string] = null;
        continue;
      }
      if (rootType === 'Mutation') {
        data[key as string] = resolveMutation(sel, ctx);
      } else {
        data[key as string] = resolveField(null, 'Query', sel, ctx);
      }
    }
    // Fix payload nested resolution: resolveSelections for payloads used the
    // generic path; nested issue/pullRequest objects are already resolved
    // inside resolveMutation via resolveSelections with payload types.
    const result: Record<string, unknown> = { data };
    if (ctx.errors.length) result.errors = ctx.errors;
    results.push(result);
  }
  sendJson(res, 200, Array.isArray(parsed.value) ? results : results[0]);
  return true;
}
