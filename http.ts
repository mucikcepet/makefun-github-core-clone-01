// Shared HTTP helpers: JSON replies, request ids, auth, body parsing.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';

let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter}`;
}
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}
export function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}
export function errorJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 64 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
export interface ParsedBody {
  ok: boolean;
  value: unknown;
  raw: Buffer;
}
export async function parseJsonBody(req: IncomingMessage): Promise<ParsedBody> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: undefined, raw };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')), raw };
  } catch {
    return { ok: false, value: undefined, raw };
  }
}
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}
export function isAuthenticated(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (!token) return true; // local mode: no token configured
  const auth = req.headers.authorization ?? '';
  return auth === `Bearer ${token}`;
}
export function viewerUser(): { login: string; id: number; type: string; name: string; email: string; avatar_url: string; html_url: string; url: string } {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    type: 'User',
    name: VIEWER.name,
    email: VIEWER.email,
    avatar_url: '',
    html_url: `https://github.com/${VIEWER.login}`,
    url: `/api/v3/users/${VIEWER.login}`,
  };
}
export function parseQuery(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}
export function decodePathSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
