'use client';

/**
 * localStorage helpers for a player's per-game credentials (persistent playerId + playerToken).
 *
 * Keyed by gameId, because the game page (/game/[id]) only knows the id. The join form only
 * knows the PIN, so a pin -> gameId pointer is stored alongside for the "re-enter PIN to
 * rejoin" path. Keying by gameId lets the game page validate in ONE round trip instead of
 * first fetching the game to learn its PIN.
 */
const ID_KEY = (gameId: string) => `player_id_${gameId}`;
const TOKEN_KEY = (gameId: string) => `player_token_${gameId}`;
const PIN_PTR_KEY = (pin: string) => `player_game_${pin}`;

export interface PlayerCreds {
  playerId: string;
  playerToken: string;
}

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function savePlayerCreds(gameId: string, pin: string, playerId: string, playerToken?: string | null): void {
  try {
    localStorage.setItem(ID_KEY(gameId), playerId);
    if (playerToken) localStorage.setItem(TOKEN_KEY(gameId), playerToken);
    localStorage.setItem(PIN_PTR_KEY(pin), gameId);
  } catch { /* private mode / storage blocked */ }
}

export function getPlayerCreds(gameId: string): PlayerCreds | null {
  const playerId = read(ID_KEY(gameId));
  const playerToken = read(TOKEN_KEY(gameId));
  if (!playerId || !playerToken) return null;
  return { playerId, playerToken };
}

export function getPlayerId(gameId: string): string | null {
  return read(ID_KEY(gameId));
}

export function getPlayerCredsByPin(pin: string): PlayerCreds | null {
  const gameId = read(PIN_PTR_KEY(pin));
  return gameId ? getPlayerCreds(gameId) : null;
}

export function clearPlayerCredsByPin(pin: string): void {
  try {
    const gameId = localStorage.getItem(PIN_PTR_KEY(pin));
    if (gameId) {
      localStorage.removeItem(ID_KEY(gameId));
      localStorage.removeItem(TOKEN_KEY(gameId));
    }
    localStorage.removeItem(PIN_PTR_KEY(pin));
  } catch { /* ignore */ }
}
