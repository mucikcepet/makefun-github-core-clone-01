// In-memory store: git objects + refs per repo, REST resources (issues, PRs,
// labels, comments) sharing the same objects. No disk, no git binary.
import { createHash } from 'node:crypto';
import { VIEWER, SCENARIO_EPOCH_SEC } from './scenario.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
export function objectId(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}
export function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

export interface GitObject {
  type: string;
  data: Buffer;
}
export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}
export interface Comment {
  id: number;
  node_id: string;
  body: string;
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
}
export interface Issue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: Label[];
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: Comment[];
  seq: number;
}
export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}
export interface Pull {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  mergeable: boolean;
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
  baseShaAtCreate: string;
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
  files: PullFile[];
  seq: number;
}

export interface Repo {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  ownerLogin: string;
  private: boolean;
  description: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  tags: Map<string, { oid: string; annotated: boolean }>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
  nextLabelId: number;
  seq: number;
}

let repoIdCounter = 1000;
let issueIdCounter = 10000;
let pullIdCounter = 20000;
let commentIdCounter = 30000;
let globalSeq = 0;
export function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}
export function nowIso(): string {
  // Deterministic-ish: trial now if provided, else fixed epoch + seq seconds.
  const trialNow = process.env.MAKEFUN_TRIAL_NOW;
  if (trialNow) return trialNow;
  return new Date((SCENARIO_EPOCH_SEC + globalSeq) * 1000).toISOString();
}
export function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export const repos = new Map<string, Repo>(); // key: owner/name (lowercase owner + '/' + name)
export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name}`;
}
export function createRepo(name: string, isPrivate: boolean, description: string): Repo {
  repoIdCounter += 1;
  const id = repoIdCounter;
  const repo: Repo = {
    id,
    node_id: gid('Repository', String(id)),
    name,
    full_name: `${VIEWER.login}/${name}`,
    ownerLogin: VIEWER.login,
    private: isPrivate,
    description,
    default_branch: 'main',
    created_at: nowIso(),
    updated_at: nowIso(),
    objects: new Map(),
    refs: new Map(),
    tags: new Map(),
    issues: [],
    pulls: [],
    labels: [],
    nextIssue: 1,
    nextPull: 1,
    nextCommentId: 1,
    nextLabelId: 1,
    seq: nextSeq(),
  };
  // empty tree object present for convenience
  repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
  repos.set(repoKey(VIEWER.login, name), repo);
  return repo;
}
export function getRepo(owner: string, name: string): Repo | undefined {
  if (owner.toLowerCase() !== VIEWER.login.toLowerCase()) return undefined;
  return repos.get(repoKey(owner, name));
}
export function listViewerRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => a.seq - b.seq);
}
export function deleteRepo(repo: Repo): void {
  repos.delete(repoKey(repo.ownerLogin, repo.name));
}

// ---- git object helpers ----
export function storeObject(repo: Repo, type: string, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid.toLowerCase());
}
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; raw: Buffer } {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message, raw: data };
}
export function parseTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const mode = data.subarray(i, space).toString('utf8');
    const nul = data.indexOf(0, space);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}
export function buildTree(repo: Repo, entries: Array<{ mode: string; name: string; oid: string }>): string {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return storeObject(repo, 'tree', Buffer.concat(parts));
}
// Flatten a tree into path -> {oid, mode} for all files.
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      for (const [k, v] of flattenTree(repo, e.oid, path)) out.set(k, v);
    } else {
      out.set(path, { oid: e.oid, mode: e.mode });
    }
  }
  return out;
}
// Build a nested tree from a flat path->blob map.
export function treeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  // Build recursively.
  const build = (prefix: string): string => {
    const base = prefix ? `${prefix}/` : '';
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    const dirs = new Set<string>();
    for (const [path, v] of files) {
      if (!path.startsWith(base)) continue;
      const rest = path.slice(base.length);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: v.mode, name: rest, oid: v.oid });
      else dirs.add(rest.slice(0, slash));
    }
    for (const d of dirs) {
      const sub = build(`${base}${d}`);
      entries.push({ mode: '40000', name: d, oid: sub });
    }
    if (entries.length === 0) return EMPTY_TREE_OID;
    return buildTree(repo, entries);
  };
  return build('');
}
export function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string, epochSec?: number): string {
  const epoch = epochSec ?? SCENARIO_EPOCH_SEC;
  const ident = `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', message.endsWith('\n') ? message : `${message}\n`);
  return storeObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  // BFS over parents from descendant.
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}
export function reachableObjects(repo: Repo, tips: string[], stopAtParents?: Set<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      // A shallow boundary commit is held with its tree/blobs, but its
      // parents are NOT held: stop the closure here.
      if (!stopAtParents?.has(oid)) for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) stack.push(m[1] as string);
    }
  }
  return out;
}
export function newIssueId(): number {
  issueIdCounter += 1;
  return issueIdCounter;
}
export function newPullId(): number {
  pullIdCounter += 1;
  return pullIdCounter;
}
export function newCommentId(): number {
  commentIdCounter += 1;
  return commentIdCounter;
}
