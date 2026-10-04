import type { Socket } from 'socket.io';
import { getToken } from 'next-auth/jwt';

/**
 * Resolve the signed-in user's DB id from the NextAuth session cookie carried on the
 * Socket.IO handshake. The client used to SEND dbUserId with createGame / joinGame, which
 * let anyone stamp games and players onto any user id. Now the only source is the JWT.
 *
 * Returns null for anonymous sockets (players rarely sign in) or on any decode problem.
 */
export async function resolveSocketUserId(socket: Socket): Promise<string | null> {
  const cookie = socket.handshake.headers.cookie;
  if (!cookie) return null;
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  try {
    const token = await getToken({
      req: { headers: { cookie } },
      secret,
      // Auth.js prefixes the cookie with __Secure- on https origins; the handshake carries
      // the forwarded https URL when served through Cloudflare.
      secureCookie: process.env.NODE_ENV === 'production',
    });
    const id = (token as { dbUserId?: unknown } | null)?.dbUserId;
    return typeof id === 'string' && id.length > 0 && id.length <= 100 ? id : null;
  } catch (e) {
    console.warn('[socket-auth] session decode failed:', (e as Error).message);
    return null;
  }
}

interface SocketUserData { dbUserId?: string | null }

export function setSocketUserId(socket: Socket, id: string | null): void {
  (socket.data as SocketUserData).dbUserId = id;
}

export function getSocketUserId(socket: Socket): string | null {
  return (socket.data as SocketUserData).dbUserId ?? null;
}
