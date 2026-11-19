// Git smart HTTP: pkt-lines, packfiles (parse + generate, OFS/REF deltas),
// protocol v2 upload-pack (ls-refs, fetch), v0 upload-pack, v0 receive-pack.
import { inflateSync, deflateSync } from 'node:zlib';
import {
  ZERO_OID, EMPTY_TREE_OID, getObject, parseCommit, parseTree, reachableObjects,
  isAncestor, storeObject, type Repo, type GitObject,
} from './store.ts';

export const AGENT = 'makefun-git-forge/1.0';

// ---- pkt-lines ----
export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), payload]);
}
export const FLUSH = Buffer.from('0000', 'utf8');
export const DELIM = Buffer.from('0001', 'utf8');
export const RESPONSE_END = Buffer.from('0002', 'utf8');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}
export function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const lenHex = buf.subarray(i, i + 4).toString('utf8');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) break; // malformed: stop
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
    } else if (len === 2) {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      i += 4;
    } else {
      if (i + len > buf.length) break;
      out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
      i += len;
    }
  }
  return out;
}
export function pktLinesToText(pkts: Pkt[]): string[] {
  return pkts.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
}

// ---- packfile parsing ----
interface PackEntry {
  type: number; // 1 commit, 2 tree, 3 blob, 4 tag, 6 ofs-delta, 7 ref-delta
  data: Buffer; // resolved data
  baseOid?: string;
  offset?: number;
}
function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] as number & 0x7f;
  let shift = 7;
  let i = off + 1;
  while (buf[i - 1] !== undefined && (buf[i - 1] as number) & 0x80) {
    value |= ((buf[i] as number) & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { value, next: i };
}
function readOfsOffset(buf: Buffer, off: number): { value: number; next: number } {
  let byte = buf[off] as number;
  let i = off + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[i] as number;
    i += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, next: i };
}
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVar = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i] as number;
      i += 1;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const baseSize = readVar();
  const resultSize = readVar();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (i < delta.length) {
    const op = delta[i] as number;
    i += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset |= delta[i] as number, i += 1;
      if (op & 0x02) offset |= (delta[i] as number) << 8, i += 1;
      if (op & 0x04) offset |= (delta[i] as number) << 16, i += 1;
      if (op & 0x08) offset |= (delta[i] as number) << 24, i += 1;
      if (op & 0x10) size |= delta[i] as number, i += 1;
      if (op & 0x20) size |= (delta[i] as number) << 8, i += 1;
      if (op & 0x40) size |= (delta[i] as number) << 16, i += 1;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      out.push(delta.subarray(i, i + op));
      total += op;
      i += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  return result;
}
const TYPE_NAMES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function parsePack(pack: Buffer, haveObjects?: Map<string, GitObject>): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { oid: string; type: string; data: Buffer }>();
  let off = 12;
  const pending: Array<{ offset: number; type: number; data: Buffer; baseOffset?: number; baseOid?: string }> = [];
  for (let n = 0; n < count; n += 1) {
    const start = off;
    const first = pack[off] as number;
    const type = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    off += 1;
    while (pack[off - 1] !== undefined && (pack[off - 1] as number) & 0x80) {
      size |= ((pack[off] as number) & 0x7f) << shift;
      shift += 7;
      off += 1;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === 6) {
      const r = readOfsOffset(pack, off);
      baseOffset = start - r.value;
      off = r.next;
    } else if (type === 7) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const consumed = deflatedLength(pack.subarray(off));
    const inflated = inflateSync(pack.subarray(off, off + consumed));
    if (inflated.length !== size) throw new Error('pack entry size mismatch');
    off += consumed;
    pending.push({ offset: start, type, data: inflated, baseOffset, baseOid });
  }
  // Resolve in offset order (OFS bases always precede).
  for (const entry of pending) {
    if (entry.type >= 1 && entry.type <= 4) {
      const typeName = TYPE_NAMES[entry.type] as string;
      const oid = objectIdOf(typeName, entry.data);
      objects.set(oid, { type: typeName, data: entry.data });
      byOffset.set(entry.offset, { oid, type: typeName, data: entry.data });
    }
  }
  // Deltas: resolve iteratively.
  let progress = true;
  const unresolved = pending.filter((e) => e.type === 6 || e.type === 7);
  while (unresolved.length && progress) {
    progress = false;
    for (let i = unresolved.length - 1; i >= 0; i -= 1) {
      const entry = unresolved[i] as (typeof unresolved)[number];
      let base: { type: string; data: Buffer } | undefined;
      if (entry.type === 6 && entry.baseOffset !== undefined) base = byOffset.get(entry.baseOffset);
      if (entry.type === 7 && entry.baseOid) {
        base = byOffset.size ? [...byOffset.values()].find((v) => v.oid === entry.baseOid) : undefined;
        if (!base && haveObjects?.has(entry.baseOid)) base = haveObjects.get(entry.baseOid);
        if (!base) {
          // base may be in objects map already
          const o = objects.get(entry.baseOid);
          if (o) base = o;
        }
      }
      if (!base) continue;
      const data = applyDelta(base.data, entry.data);
      const oid = objectIdOf(base.type, data);
      objects.set(oid, { type: base.type, data });
      byOffset.set(entry.offset, { oid, type: base.type, data });
      unresolved.splice(i, 1);
      progress = true;
    }
  }
  if (unresolved.length) throw new Error('unresolved delta in pack');
  return objects;
}
import { createHash } from 'node:crypto';
function objectIdOf(type: string, data: Buffer): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data])).digest('hex');
}
// Length of the zlib stream starting at buf[0]: smallest prefix that
// inflates cleanly (exponential search, then binary search).
function deflatedLength(buf: Buffer): number {
  const tryInflate = (n: number): boolean => {
    try {
      inflateSync(buf.subarray(0, n));
      return true;
    } catch {
      return false;
    }
  };
  let step = 64;
  let n = Math.min(step, buf.length);
  while (n < buf.length && !tryInflate(n)) {
    step *= 2;
    n = Math.min(n + step, buf.length);
  }
  let lo = Math.max(1, n - step);
  let hi = n;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (tryInflate(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ---- packfile generation (no deltas: plain objects, fast and correct) ----
export function buildPack(repo: Repo, oids: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = getObject(repo, oid);
    if (!obj) continue;
    const typeCode = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    headerBytes.push(first);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
export function sidebandPacket(band: number, data: Buffer): Buffer {
  // One pkt-line whose payload is band byte + data, split to <= 65516 payload.
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < data.length || (data.length === 0 && offset === 0)) {
    const slice = data.subarray(offset, offset + 65515);
    const payload = Buffer.concat([Buffer.from([band]), slice]);
    chunks.push(pktLine(payload));
    offset += slice.length;
    if (data.length === 0) break;
  }
  return Buffer.concat(chunks);
}

// ---- ref helpers ----
export function allRefs(repo: Repo): Array<{ oid: string; ref: string }> {
  const out: Array<{ oid: string; ref: string }> = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort()) out.push({ oid, ref });
  return out;
}
export function headRef(repo: Repo): string {
  return `refs/heads/${repo.default_branch}`;
}
export function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}
export function peeledOid(repo: Repo, oid: string): string | undefined {
  const obj = getObject(repo, oid);
  if (!obj || obj.type !== 'tag') return undefined;
  const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
  return m ? (m[1] as string) : undefined;
}

// ---- v0 advertisement ----
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const chunks: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k multi_ack_detailed thin-pack ofs-delta agent=makefun-git-forge/1.0'
      : 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=makefun-git-forge/1.0';
  const refs = allRefs(repo);
  const head = headRef(repo);
  const symref = ` symref=HEAD:${head}`;
  if (refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}${symref}\n`));
  } else {
    refs.forEach((r, i) => {
      const extra = i === 0 ? `\0${caps}${symref}` : '';
      chunks.push(pktLine(`${r.oid} ${r.ref}${extra}\n`));
      const peeled = peeledOid(repo, r.oid);
      if (peeled) chunks.push(pktLine(`${peeled} ${r.ref}^{}\n`));
    });
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

// ---- v2 advertisement ----
export function advertiseV2(): Buffer {
  const lines = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
  ];
  return Buffer.concat([...lines.map((l) => pktLine(l)), FLUSH]);
}

// ---- ls-refs (v2) ----
export function lsRefs(repo: Repo, args: string[]): Buffer {
  let prefix: string | undefined;
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const a of args) {
    if (a.startsWith('ref-prefix ')) prefix = a.slice('ref-prefix '.length).trim();
    else if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a === 'unborn') unborn = true;
  }
  const chunks: Buffer[] = [];
  const refs = allRefs(repo).filter((r) => !prefix || r.ref.startsWith(prefix));
  const head = headRef(repo);
  const headTip = repo.refs.get(head);
  if ((!prefix || head.startsWith(prefix) || 'HEAD'.startsWith(prefix)) && (!prefix || 'HEAD'.startsWith(prefix))) {
    // HEAD line: emitted when no prefix or prefix matches HEAD/refs.
    if (!prefix) {
      const attrs: string[] = [];
      if (headTip) attrs.push(`symref-target:${head}`);
      else if (unborn) attrs.push('unborn');
      chunks.push(pktLine(`${headTip ?? ZERO_OID} HEAD${attrs.length ? ' ' + attrs.join(' ') : ''}\n`));
    }
  }
  if (symrefs && headTip && (!prefix || head.startsWith(prefix))) {
    // HEAD already emitted above with symref-target when no prefix; for prefix
    // refs/heads/ the HEAD line is not expected. Keep as above.
  }
  for (const r of refs) {
    const attrs: string[] = [];
    if (peel) {
      const peeled = peeledOid(repo, r.oid);
      if (peeled) attrs.push(`peeled:${peeled}`);
    }
    chunks.push(pktLine(`${r.oid} ${r.ref}${attrs.length ? ' ' + attrs.join(' ') : ''}\n`));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

// ---- fetch object selection ----
export interface FetchSelection {
  objects: string[]; // oids to send, in an order where parents come after children
  shallow: string[];
  unshallow: string[];
}
/** Follow an annotated tag (possibly nested) to its target object id. */
function tagTarget(repo: Repo, oid: string): string | undefined {
  const obj = getObject(repo, oid);
  if (!obj || obj.type !== 'tag') return undefined;
  const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
  return m ? (m[1] as string) : undefined;
}

export function selectFetch(repo: Repo, wants: string[], haves: string[], depth: number | null, shallowBoundaries: string[]): FetchSelection {
  // A shallow boundary's history is not held: the have-closure stops there.
  const stopAt = new Set<string>(shallowBoundaries);
  const haveSet = new Set<string>();
  for (const h of haves) {
    for (const o of reachableObjects(repo, [h], stopAt)) haveSet.add(o);
  }
  // Expand annotated tag wants to their target commits, but remember the
  // tag objects themselves: they must be sent too.
  const tagOids = new Set<string>();
  const expandedWants: string[] = [];
  for (const w of wants) {
    let cur = w;
    const seen = new Set<string>();
    while (!seen.has(cur)) {
      seen.add(cur);
      const target = tagTarget(repo, cur);
      if (!target) break;
      tagOids.add(cur);
      cur = target;
    }
    expandedWants.push(cur);
  }
  const wantsForWalk = expandedWants;
  // Commits reachable from wants.
  const wantCommits = new Set<string>();
  const stack = [...wantsForWalk];
  const seen = new Set<string>();
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      wantCommits.add(oid);
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
  }
  // Depth-limited commit set.
  const selectedCommits = new Set<string>();
  const shallow = new Set<string>();
  const unshallow = new Set<string>();
  if (depth !== null) {
    // BFS by generation from wants. The shallow boundary is the deepest
    // included commit (generation depth-1) that has parents outside the set:
    // in git the boundary commit itself is listed as shallow.
    const gen = new Map<string, number>();
    const q: Array<[string, number]> = wantsForWalk.map((w) => [w, 0] as [string, number]);
    while (q.length) {
      const [oid, g] = q.shift() as [string, number];
      if (gen.has(oid)) continue;
      const obj = getObject(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      gen.set(oid, g);
      selectedCommits.add(oid);
      if (g + 1 < depth) {
        for (const p of parseCommit(obj.data).parents) q.push([p, g + 1]);
      }
    }
    for (const [oid, g] of gen) {
      if (g !== depth - 1) continue;
      const obj = getObject(repo, oid);
      if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) shallow.add(oid);
    }
    // Boundaries that were shallow before and are now included with a parent
    // fetched become unshallow (they are no longer a boundary); boundaries
    // outside the fetched set stay shallow.
    for (const b of shallowBoundaries) {
      if (selectedCommits.has(b) && !shallow.has(b)) unshallow.add(b);
      else if (!selectedCommits.has(b)) shallow.add(b);
    }
  } else {
    for (const c of wantCommits) selectedCommits.add(c);
    for (const b of shallowBoundaries) {
      if (!selectedCommits.has(b)) shallow.add(b);
    }
  }
  // Objects to send: reachable from selected commits, minus held objects.
  const send = new Set<string>();
  for (const c of selectedCommits) {
    for (const o of reachableObjects(repo, [c])) {
      if (!haveSet.has(o)) send.add(o);
    }
  }
  // Annotated tag objects themselves (their targets are covered above).
  for (const t of tagOids) {
    if (!haveSet.has(t)) send.add(t);
  }
  // Order: commits first (newest first by walk), then trees/blobs. Any order
  // that keeps parents after children is fine for a pack without deltas.
  const ordered: string[] = [];
  const commitList = [...selectedCommits];
  // Sort commits by BFS depth from wants (children before parents).
  const depthMap = new Map<string, number>();
  const q2: Array<[string, number]> = wantsForWalk.map((w) => [w, 0] as [string, number]);
  const seen2 = new Set<string>();
  while (q2.length) {
    const [oid, g] = q2.shift() as [string, number];
    if (seen2.has(oid)) continue;
    seen2.add(oid);
    depthMap.set(oid, g);
    const obj = getObject(repo, oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) q2.push([p, g + 1]);
  }
  commitList.sort((a, b) => (depthMap.get(a) ?? 0) - (depthMap.get(b) ?? 0));
  for (const c of commitList) if (send.has(c)) ordered.push(c);
  for (const o of send) {
    const obj = getObject(repo, o);
    if (obj && obj.type !== 'commit' && !ordered.includes(o)) ordered.push(o);
  }
  return { objects: ordered, shallow: [...shallow], unshallow: [...unshallow] };
}
