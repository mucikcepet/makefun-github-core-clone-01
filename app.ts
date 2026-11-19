// HTTP server: routing to git smart HTTP, REST v3, GraphQL, MCP.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getRepo, getObject, parseCommit, ZERO_OID, type Repo } from './store.ts';
import {
  pktLine, FLUSH, DELIM, parsePktLines, pktLinesToText, parsePack, buildPack,
  sidebandPacket, advertiseV0, advertiseV2, lsRefs, selectFetch, allRefs,
} from './git.ts';
import { sendJson, sendRaw, errorJson, readBody, isAuthenticated, pathOf } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

function sendJsonWithReqId(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendJson(res, status, body, headers);
}

// ---- git smart HTTP ----
async function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, rest: string): Promise<void> {
  const method = req.method ?? 'GET';
  if (!isAuthenticated(req)) {
    errorJson(res, 401, 'Bad credentials');
    return;
  }
  const repo = getRepo(owner, repoName);
  if (!repo) {
    errorJson(res, 404, 'Not Found');
    return;
  }
  const query = (() => {
    try {
      return new URL(req.url ?? '/', 'http://entry').searchParams;
    } catch {
      return new URLSearchParams();
    }
  })();
  if (method === 'GET' && rest === 'info/refs') {
    const service = query.get('service') ?? '';
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-upload-pack') {
      if (isV2) {
        sendRaw(res, 200, advertiseV2(), 'application/x-git-upload-pack-advertisement');
      } else {
        sendRaw(res, 200, advertiseV0(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      }
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, advertiseV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    errorJson(res, 404, 'Not Found');
    return;
  }
  if (method === 'POST' && rest === 'git-upload-pack') {
    const body = await readBody(req);
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    try {
      const out = isV2 ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
      sendRaw(res, 200, out, 'application/x-git-upload-pack-result');
    } catch (e) {
      errorJson(res, 500, e instanceof Error ? e.message : String(e));
    }
    return;
  }
  if (method === 'POST' && rest === 'git-receive-pack') {
    const body = await readBody(req);
    try {
      const out = handleReceivePack(repo, body);
      sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
    } catch (e) {
      errorJson(res, 500, e instanceof Error ? e.message : String(e));
    }
    return;
  }
  errorJson(res, 404, 'Not Found');
}

function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const pkts = parsePktLines(body);
  // Split by delim packets: header section, then argument section.
  const sections: string[][] = [[]];
  for (const pkt of pkts) {
    if (pkt.kind === 'delim' || pkt.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (pkt.kind === 'data') (sections[sections.length - 1] as string[]).push(pkt.payload.toString('utf8').trim());
  }
  const headerLines = sections[0] ?? [];
  const argLines = sections[1] ?? [];
  let command = '';
  for (const line of headerLines) {
    if (line.startsWith('command=')) command = line.slice('command='.length).trim();
  }
  if (command === 'ls-refs') {
    return lsRefs(repo, argLines);
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowBoundaries: string[] = [];
    let depth: number | null = null;
    for (const line of argLines) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10);
    }
    return fetchV2Response(repo, wants, haves, depth, shallowBoundaries);
  }
  return FLUSH;
}

// Pack cache: objects are immutable and only added, so a pack for the same
// repo size + selection is identical. The clone workload issues 50
// concurrent identical fetches; rebuilding the pack each time serializes
// ~50 deflate passes on one thread.
const packCache = new Map<string, Buffer>();
function cachedPack(repo: Repo, objects: string[]): Buffer {
  const key = `${repo.id}|${repo.objects.size}|${objects.join(',')}`;
  const hit = packCache.get(key);
  if (hit) return hit;
  const pack = buildPack(repo, objects);
  if (packCache.size > 200) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

function fetchV2Response(repo: Repo, wants: string[], haves: string[], depth: number | null, shallowBoundaries: string[]): Buffer {
  const chunks: Buffer[] = [];
  const sel = selectFetch(repo, wants, haves, depth, shallowBoundaries);
  chunks.push(pktLine('acknowledgments\n'));
  let common: string | undefined;
  for (const h of haves) {
    if (getObject(repo, h)) { common = h; break; }
  }
  if (haves.length === 0) {
    chunks.push(pktLine('NAK\n'));
  } else if (common) {
    chunks.push(pktLine(`ACK ${common}\n`));
    chunks.push(pktLine('ready\n'));
  } else {
    chunks.push(pktLine('NAK\n'));
  }
  chunks.push(DELIM);
  if (sel.shallow.length || sel.unshallow.length) {
    chunks.push(pktLine('shallow-info\n'));
    for (const s of sel.shallow) chunks.push(pktLine(`shallow ${s}\n`));
    for (const u of sel.unshallow) chunks.push(pktLine(`unshallow ${u}\n`));
    chunks.push(DELIM);
  }
  chunks.push(pktLine('wanted-refs\n'));
  const refs = allRefs(repo);
  for (const w of wants) {
    const ref = refs.find((r) => r.oid === w);
    if (ref) chunks.push(pktLine(`${w} ${ref.ref}\n`));
  }
  chunks.push(DELIM);
  if (sel.objects.length > 0) {
    const pack = cachedPack(repo, sel.objects);
    chunks.push(pktLine('packfile\n'));
    chunks.push(sidebandPacket(1, pack));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const lines = pktLinesToText(parsePktLines(body));
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10);
  }
  const sel = selectFetch(repo, wants, haves, depth, shallowBoundaries);
  const chunks: Buffer[] = [];
  let common: string | undefined;
  for (const h of haves) if (getObject(repo, h)) { common = h; break; }
  if (haves.length === 0 || !common) chunks.push(pktLine('NAK\n'));
  else chunks.push(pktLine(`ACK ${common}\n`));
  for (const s of sel.shallow) chunks.push(pktLine(`shallow ${s}\n`));
  for (const u of sel.unshallow) chunks.push(pktLine(`unshallow ${u}\n`));
  if (sel.objects.length > 0) {
    const pack = cachedPack(repo, sel.objects);
    chunks.push(sidebandPacket(1, pack));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  let cmdEnd = -1;
  let i = 0;
  while (i + 4 <= body.length) {
    const len = parseInt(body.subarray(i, i + 4).toString('utf8'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { cmdEnd = i + 4; break; }
    if (len < 4) break;
    i += len;
  }
  const cmdBuf = cmdEnd >= 0 ? body.subarray(0, cmdEnd) : body;
  const packBuf = cmdEnd >= 0 ? body.subarray(cmdEnd) : Buffer.alloc(0);
  const lines = pktLinesToText(parsePktLines(cmdBuf));
  interface Cmd { old: string; next: string; ref: string }
  const cmds: Cmd[] = [];
  let clientCaps = '';
  for (const line of lines) {
    const nul = line.indexOf('\0');
    let text = line;
    if (nul >= 0) {
      clientCaps = line.slice(nul + 1);
      text = line.slice(0, nul);
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(text);
    if (m) cmds.push({ old: m[1] as string, next: m[2] as string, ref: m[3] as string });
  }
  const sideband = clientCaps.includes('side-band-64k');
  const reportLines: string[] = [];
  let unpackOk = true;
  if (packBuf.length > 0) {
    try {
      const objects = parsePack(packBuf);
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (e) {
      unpackOk = false;
      reportLines.push(`unpack ${e instanceof Error ? e.message : 'error'}`);
    }
  }
  if (unpackOk) reportLines.push('unpack ok');
  for (const cmd of cmds) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.next === ZERO_OID) {
      if (current && current !== cmd.old) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      } else {
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (cmd.old === ZERO_OID) {
      if (current) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      } else if (!getObject(repo, cmd.next)) {
        reportLines.push(`ng ${cmd.ref} object not found`);
      } else {
        repo.refs.set(cmd.ref, cmd.next);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (current !== cmd.old) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    if (!getObject(repo, cmd.next)) {
      reportLines.push(`ng ${cmd.ref} object not found`);
      continue;
    }
    if (!isAncestorOf(repo, cmd.old, cmd.next)) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.next);
    reportLines.push(`ok ${cmd.ref}`);
  }
  const chunks: Buffer[] = [];
  if (sideband) {
    for (const line of reportLines) chunks.push(sidebandPacket(1, pktLine(`${line}\n`)));
  } else {
    for (const line of reportLines) chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}
function isAncestorOf(repo: Repo, ancestor: string, descendant: string): boolean {
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

// ---- main router ----
export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
      if (method === 'GET' && path === '/healthz') {
        sendJsonWithReqId(res, 200, { ok: true });
        return;
      }
      if (path === '/mcp' && method === 'POST') {
        await handleMcp(req, res);
        return;
      }
      if (path === '/api/graphql' && method === 'POST') {
        await handleGraphQL(req, res);
        return;
      }
      if (path.startsWith('/api/v3')) {
        await handleRest(req, res, baseUrl);
        return;
      }
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
      if (gitMatch) {
        await handleGit(req, res, gitMatch[1] as string, gitMatch[2] as string, gitMatch[3] as string);
        return;
      }
      errorJson(res, 404, 'Not Found');
    } catch (e) {
      try {
        errorJson(res, 500, e instanceof Error ? e.message : String(e));
      } catch {
        // response already gone
      }
    }
  });
}
