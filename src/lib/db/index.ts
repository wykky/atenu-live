/**
 * SQLite persistence for Atenu Live.
 *
 * Storage: one file at /app/data/atenu.db (mounted from /opt/stack/atenu-live/data on host).
 * Library: better-sqlite3 (synchronous, native binding, ~1µs per query).
 *
 * Phase 4A: games + questions + players + answers (live game state)
 * Phase 4B: users (Google + Telegram identity persistence)
 * Phase 4C: leaderboard SQL helpers
 *
 * Restic backups already cover /opt/stack/* — DB is included automatically.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Game, Player, AnswerRecord } from '@/types/game';

const DB_PATH = process.env.ATENU_DB_PATH || '/app/data/atenu.db';

let db: Database.Database | null = null;

/**
 * Lazily prepared, cached statement for the hot per-answer / per-score paths. Each call
 * used to run db.prepare() again (SQL parse + plan) — 200 players x 30 questions = 6,000
 * compiles per game for insertAnswer alone. Re-prepares if the Database instance changes.
 */
function prepared(sql: string): () => Database.Statement {
  let stmt: Database.Statement | undefined;
  let owner: Database.Database | null = null;
  return () => {
    const d = getDb();
    if (!stmt || owner !== d) {
      stmt = d.prepare(sql);
      owner = d;
    }
    return stmt;
  };
}

/** Run `fn` inside one SQLite transaction (better-sqlite3 transactions are synchronous). */
export function runInTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');     // better concurrent reads, durable writes
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');   // good durability/perf tradeoff with WAL
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                  TEXT PRIMARY KEY,
      provider            TEXT NOT NULL,
      provider_user_id    TEXT NOT NULL,
      email               TEXT,
      name                TEXT,
      avatar_url          TEXT,
      vip                 INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      last_seen_at        INTEGER NOT NULL,
      UNIQUE(provider, provider_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS games (
      id                      TEXT PRIMARY KEY,
      pin                     TEXT NOT NULL,
      host_user_id            TEXT,
      host_player_id          TEXT NOT NULL,
      title                   TEXT NOT NULL,
      settings_json           TEXT NOT NULL,
      status                  TEXT NOT NULL,
      current_question_index  INTEGER NOT NULL DEFAULT -1,
      player_count            INTEGER NOT NULL DEFAULT 0,
      question_count          INTEGER NOT NULL,
      created_at              INTEGER NOT NULL,
      started_at              INTEGER,
      finished_at             INTEGER,
      tsv_data                TEXT,
      FOREIGN KEY (host_user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_games_host_user ON games(host_user_id);
    CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
    CREATE INDEX IF NOT EXISTS idx_games_finished_at ON games(finished_at);

    CREATE TABLE IF NOT EXISTS questions (
      game_id         TEXT NOT NULL,
      question_index  INTEGER NOT NULL,
      id              TEXT NOT NULL,
      text            TEXT NOT NULL,
      options_json    TEXT NOT NULL,
      correct_answer  INTEGER NOT NULL,
      time_limit      INTEGER NOT NULL,
      explanation     TEXT,
      image_url       TEXT,
      PRIMARY KEY (game_id, question_index),
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS players (
      id                      TEXT NOT NULL,
      game_id                 TEXT NOT NULL,
      user_id                 TEXT,
      name                    TEXT NOT NULL,
      final_score             INTEGER NOT NULL DEFAULT 0,
      is_host                 INTEGER NOT NULL DEFAULT 0,
      has_dyslexia_support    INTEGER NOT NULL DEFAULT 0,
      joined_at               INTEGER NOT NULL,
      PRIMARY KEY (id, game_id),
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_players_user ON players(user_id);
    CREATE INDEX IF NOT EXISTS idx_players_game ON players(game_id);

    CREATE TABLE IF NOT EXISTS answers (
      game_id                 TEXT NOT NULL,
      player_id               TEXT NOT NULL,
      question_index          INTEGER NOT NULL,
      answer_index            INTEGER,
      answer_time             INTEGER,
      response_time_ms        INTEGER NOT NULL,
      points_earned           INTEGER NOT NULL,
      was_correct             INTEGER NOT NULL,
      has_dyslexia_support    INTEGER NOT NULL,
      PRIMARY KEY (game_id, player_id, question_index),
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_answers_player ON answers(player_id);
    CREATE INDEX IF NOT EXISTS idx_answers_game ON answers(game_id);

    /* Curated quiz library — Atenu-uploaded ESSLCE-aligned content.
       Hosts browse + clone, but only admin imports new entries. */
    CREATE TABLE IF NOT EXISTS quiz_library (
      id                       TEXT PRIMARY KEY,
      slug                     TEXT NOT NULL UNIQUE,
      title                    TEXT NOT NULL,
      subject                  TEXT,             -- e.g. 'Math', 'Biology', 'Geography'
      grade                    INTEGER,          -- 9..12 for ESSLCE; null = general
      language                 TEXT,             -- 'en' / 'am' / 'om'; null = English default
      description              TEXT,
      question_count           INTEGER NOT NULL,
      default_think_time       INTEGER NOT NULL DEFAULT 5,
      default_answer_time      INTEGER NOT NULL DEFAULT 20,
      default_shuffle_answers  INTEGER NOT NULL DEFAULT 0,
      published                INTEGER NOT NULL DEFAULT 1,
      created_at               INTEGER NOT NULL,
      updated_at               INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_library_subject_grade ON quiz_library(subject, grade);
    CREATE INDEX IF NOT EXISTS idx_library_published ON quiz_library(published, created_at);

    CREATE TABLE IF NOT EXISTS quiz_library_questions (
      library_id       TEXT NOT NULL,
      question_index   INTEGER NOT NULL,
      id               TEXT NOT NULL,
      text             TEXT NOT NULL,
      options_json     TEXT NOT NULL,
      correct_answer   INTEGER NOT NULL,
      correct_answers  TEXT,   -- JSON array for multi-select; null for single
      question_type    TEXT NOT NULL DEFAULT 'single',
      time_limit       INTEGER NOT NULL,
      explanation      TEXT,
      image_url        TEXT,
      PRIMARY KEY (library_id, question_index),
      FOREIGN KEY (library_id) REFERENCES quiz_library(id) ON DELETE CASCADE
    );
  `);

  // Idempotent column additions for multi-select support.
  // SQLite ADD COLUMN errors if the column exists; check PRAGMA table_info first.
  addColumnIfMissing(d, 'questions', 'question_type', "TEXT NOT NULL DEFAULT 'single'");
  addColumnIfMissing(d, 'questions', 'correct_answers', 'TEXT'); // JSON array of indices for multi-select
  addColumnIfMissing(d, 'answers', 'answer_indices', 'TEXT');    // JSON-array selection for multi-select

  // Display name shown on public leaderboards instead of the full Google
  // account name. NULL falls back to the legacy `name` column. Populated
  // on sign-in by NextAuth's jwt callback.
  addColumnIfMissing(d, 'users', 'display_name', 'TEXT');

  // Hide the auto-seeded "sample" library quiz once real curated quizzes
  // exist. The sample's only purpose was to keep /library non-empty on the
  // first deploy; now that ten real quizzes live alongside it, it's noise.
  // Idempotent: matches only the seed slug and only unpublishes once.
  d.prepare(
    `UPDATE quiz_library
        SET published = 0
      WHERE slug = 'sample-ethiopia-geography'
        AND published = 1
        AND (SELECT COUNT(*) FROM quiz_library WHERE slug != 'sample-ethiopia-geography' AND published = 1) > 0`
  ).run();

  // One-time backfill: pre-existing user rows have full Google names
  // ("WILFRID NGUESSAN"). Pull the first whitespace-delimited token, lowercase
  // it, then title-case via UPPER + LOWER. Skips rows that already have
  // display_name set, so this is idempotent and safe to run on every boot.
  d.prepare(
    `UPDATE users
       SET display_name =
         UPPER(SUBSTR(name, 1, 1))
           || LOWER(
                SUBSTR(
                  name,
                  2,
                  CASE
                    WHEN INSTR(name, ' ') > 0 THEN INSTR(name, ' ') - 2
                    ELSE LENGTH(name) - 1
                  END
                )
              )
     WHERE display_name IS NULL
       AND name IS NOT NULL
       AND TRIM(name) != ''`
  ).run();
}

function addColumnIfMissing(d: Database.Database, table: string, column: string, definition: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    d.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

// ============================================================================
// USERS
// ============================================================================

export interface DbUser {
  id: string;
  provider: 'google' | 'telegram';
  provider_user_id: string;
  email: string | null;
  name: string | null;
  display_name: string | null;
  avatar_url: string | null;
  vip: number;
  created_at: number;
  last_seen_at: number;
}

/**
 * Derive a sensible default display_name from a full account name.
 * - "WILFRID NGUESSAN" → "Wilfrid"
 * - "Sara T."         → "Sara"
 * - null / empty      → null (caller falls back to legacy `name`)
 *
 * We strip after the first space and title-case the result so the public
 * leaderboard doesn't shout the host's last name back at them.
 */
function deriveDisplayName(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  const first = fullName.trim().split(/\s+/)[0];
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

export function upsertUser(input: {
  provider: 'google' | 'telegram';
  providerUserId: string;
  email?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
}): DbUser {
  const d = getDb();
  const now = Date.now();
  const existing = d
    .prepare('SELECT * FROM users WHERE provider = ? AND provider_user_id = ?')
    .get(input.provider, input.providerUserId) as DbUser | undefined;

  if (existing) {
    // Only seed display_name on rows that haven't been set yet, so future host
    // edits via /account aren't clobbered by every sign-in.
    const seededDisplayName = existing.display_name ?? deriveDisplayName(input.name ?? existing.name);
    d.prepare(
      'UPDATE users SET email = COALESCE(?, email), name = COALESCE(?, name), display_name = COALESCE(?, display_name), avatar_url = COALESCE(?, avatar_url), last_seen_at = ? WHERE id = ?'
    ).run(
      input.email ?? null,
      input.name ?? null,
      seededDisplayName,
      input.avatarUrl ?? null,
      now,
      existing.id
    );
    return {
      ...existing,
      email: input.email ?? existing.email,
      name: input.name ?? existing.name,
      display_name: seededDisplayName,
      last_seen_at: now,
    };
  }

  const id = crypto.randomUUID();
  const row: DbUser = {
    id,
    provider: input.provider,
    provider_user_id: input.providerUserId,
    email: input.email ?? null,
    name: input.name ?? null,
    display_name: deriveDisplayName(input.name),
    avatar_url: input.avatarUrl ?? null,
    vip: 0,
    created_at: now,
    last_seen_at: now,
  };
  d.prepare(
    'INSERT INTO users (id, provider, provider_user_id, email, name, display_name, avatar_url, vip, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    row.id,
    row.provider,
    row.provider_user_id,
    row.email,
    row.name,
    row.display_name,
    row.avatar_url,
    row.vip,
    row.created_at,
    row.last_seen_at
  );
  return row;
}

export function getUserById(id: string): DbUser | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as DbUser | undefined;
}

// ============================================================================
// GAMES
// ============================================================================

const insertGameStmt = prepared(
  `INSERT OR REPLACE INTO games (
    id, pin, host_user_id, host_player_id, title, settings_json, status,
    current_question_index, player_count, question_count, created_at,
    started_at, finished_at, tsv_data
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insertQuestionStmt = prepared(
  `INSERT OR REPLACE INTO questions (
    game_id, question_index, id, text, options_json, correct_answer, time_limit, explanation, image_url,
    question_type, correct_answers
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

export function insertGame(game: Game, hostUserId: string | null): void {
  const d = getDb();
  const now = Date.now();
  const tx = d.transaction(() => {
    insertGameStmt().run(
      game.id,
      game.pin,
      hostUserId,
      game.hostId,
      game.title,
      JSON.stringify(game.settings),
      game.status,
      game.currentQuestionIndex,
      game.players.filter((p) => !p.isHost).length,
      game.questions.length,
      now,
      null,
      null,
      null
    );
    game.questions.forEach((q, idx) => {
      insertQuestionStmt().run(
        game.id,
        idx,
        q.id,
        q.question,
        JSON.stringify(q.options),
        q.correctAnswer,
        q.timeLimit,
        q.explanation ?? null,
        q.image ?? null,
        q.questionType ?? 'single',
        q.questionType === 'multi' && q.correctAnswers ? JSON.stringify(q.correctAnswers) : null
      );
    });
  });
  tx();
}

const updateGameStatusStmt = prepared(
  'UPDATE games SET status = ?, current_question_index = ?, started_at = COALESCE(started_at, CASE WHEN status = ? THEN NULL ELSE ? END) WHERE id = ?'
);
export function updateGameStatus(gameId: string, status: string, currentQuestionIndex: number): void {
  updateGameStatusStmt().run(status, currentQuestionIndex, 'waiting', Date.now(), gameId);
}

const finishGameStmt = prepared('UPDATE games SET status = ?, finished_at = ?, tsv_data = ?, player_count = ? WHERE id = ?');
const updateFinalScoreStmt = prepared('UPDATE players SET final_score = ? WHERE id = ? AND game_id = ?');
export function finishGame(gameId: string, tsvData: string, finalPlayers: Player[]): void {
  const now = Date.now();
  runInTransaction(() => {
    finishGameStmt().run(
      'finished',
      now,
      tsvData,
      finalPlayers.filter((p) => !p.isHost).length,
      gameId
    );
    finalPlayers.forEach((p) => updateFinalScoreStmt().run(p.score, p.id, gameId));
  });
}

const getGameTsvStmt = prepared('SELECT tsv_data FROM games WHERE id = ?');
export function getGameTsv(gameId: string): string | null {
  const row = getGameTsvStmt().get(gameId) as { tsv_data: string | null } | undefined;
  return row?.tsv_data ?? null;
}

const getGamePinStmt = prepared('SELECT pin FROM games WHERE id = ?');
export function getGamePin(gameId: string): string | null {
  const row = getGamePinStmt().get(gameId) as { pin: string } | undefined;
  return row?.pin ?? null;
}

export interface HostGameSummary {
  id: string;
  pin: string;
  title: string;
  status: string;
  player_count: number;
  question_count: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  has_tsv: number;
}

/**
 * Games this host has run, newest first. Excludes draft lobbies that were
 * created but never started (started_at IS NULL) — those are noise for the
 * "my past quizzes" view. To include them, drop the started_at filter.
 */
export function getGamesByHost(hostUserId: string, opts: { limit?: number; offset?: number } = {}): HostGameSummary[] {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  return getDb()
    .prepare(
      `SELECT
        id, pin, title, status, player_count, question_count,
        created_at, started_at, finished_at,
        CASE WHEN tsv_data IS NOT NULL THEN 1 ELSE 0 END AS has_tsv
       FROM games
       WHERE host_user_id = ? AND started_at IS NOT NULL
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(hostUserId, limit, offset) as HostGameSummary[];
}

/**
 * TSV download with ownership check baked in: returns null if the game
 * doesn't exist OR isn't owned by this host. Prevents IDOR via guessed gameIds.
 */
export function getGameTsvForHost(gameId: string, hostUserId: string): string | null {
  const row = getDb()
    .prepare('SELECT tsv_data FROM games WHERE id = ? AND host_user_id = ?')
    .get(gameId, hostUserId) as { tsv_data: string | null } | undefined;
  return row?.tsv_data ?? null;
}

/** Boot sweep: any non-finished game becomes finished (server crashed mid-game). */
export function sweepInflightGamesOnBoot(generateTsv: (gameId: string) => string | null): number {
  const d = getDb();
  const inflight = d
    .prepare("SELECT id FROM games WHERE status != 'finished'")
    .all() as { id: string }[];
  let count = 0;
  for (const { id } of inflight) {
    const tsv = generateTsv(id);
    d.prepare('UPDATE games SET status = ?, finished_at = ?, tsv_data = ? WHERE id = ?').run(
      'finished',
      Date.now(),
      tsv,
      id
    );
    count++;
  }
  return count;
}

/** Retention sweep: delete games finished more than `days` ago. */
export function deleteOldGames(days: number): number {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return getDb().prepare('DELETE FROM games WHERE finished_at IS NOT NULL AND finished_at < ?').run(cutoff).changes;
}

// ============================================================================
// PLAYERS
// ============================================================================

const upsertPlayerStmt = prepared(
  `INSERT OR REPLACE INTO players (
    id, game_id, user_id, name, final_score, is_host, has_dyslexia_support, joined_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?,
    COALESCE((SELECT joined_at FROM players WHERE id = ? AND game_id = ?), ?)
  )`
);
export function upsertPlayer(gameId: string, player: Player, userId: string | null): void {
  upsertPlayerStmt().run(
      player.id,
      gameId,
      userId,
      player.name,
      player.score,
      player.isHost ? 1 : 0,
      player.hasDyslexiaSupport ? 1 : 0,
      player.id,
      gameId,
      Date.now()
    );
}

export function updatePlayerScore(gameId: string, playerId: string, score: number): void {
  updateFinalScoreStmt().run(score, playerId, gameId);
}

// ============================================================================
// ANSWERS
// ============================================================================

const insertAnswerStmt = prepared(
  `INSERT OR REPLACE INTO answers (
    game_id, player_id, question_index, answer_index, answer_indices, answer_time,
    response_time_ms, points_earned, was_correct, has_dyslexia_support
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
export function insertAnswer(gameId: string, answer: AnswerRecord): void {
  // answerIndex carries either a single number (single-select), a comma-joined
  // string like "0,2" (multi-select), or null. INTEGER columns in SQLite accept
  // mixed types but querying gets messy, so split: keep answer_index INTEGER for
  // single-select, store the multi-select form in answer_indices TEXT.
  const isMulti = typeof answer.answerIndex === 'string';
  insertAnswerStmt().run(
      gameId,
      answer.playerId,
      answer.questionIndex,
      isMulti ? null : (answer.answerIndex as number | null),
      isMulti ? (answer.answerIndex as string) : null,
      answer.answerTime ?? null,
      answer.responseTime,
      answer.pointsEarned,
      answer.wasCorrect ? 1 : 0,
      answer.hasDyslexiaSupport ? 1 : 0
    );
}

// ============================================================================
// LEADERBOARDS (Phase 4C)
// ============================================================================

export interface LeaderboardEntry {
  user_id: string;
  name: string;
  avatar_url: string | null;
  total_points: number;
  games_played: number;
  correct_count: number;
  total_answers: number;
}

/**
 * Top signed-in users by total points earned during a time window.
 * Anonymous players (players.user_id IS NULL) are excluded.
 */
export function getLeaderboard(opts: { sinceTs?: number; limit?: number } = {}): LeaderboardEntry[] {
  const limit = opts.limit ?? 50;
  const sinceTs = opts.sinceTs ?? 0;
  return getDb()
    .prepare(
      `SELECT
        u.id                                       AS user_id,
        COALESCE(u.display_name, u.name, 'Player') AS name,
        u.avatar_url                               AS avatar_url,
        SUM(a.points_earned)                       AS total_points,
        COUNT(DISTINCT a.game_id)                  AS games_played,
        SUM(CASE WHEN a.was_correct = 1 THEN 1 ELSE 0 END) AS correct_count,
        COUNT(*)                                   AS total_answers
       FROM answers a
       JOIN players p ON p.id = a.player_id AND p.game_id = a.game_id
       JOIN users u ON u.id = p.user_id
       JOIN games g ON g.id = a.game_id
       WHERE g.finished_at IS NOT NULL
         AND g.finished_at >= ?
         AND p.is_host = 0
       GROUP BY u.id
       ORDER BY total_points DESC
       LIMIT ?`
    )
    .all(sinceTs, limit) as LeaderboardEntry[];
}

/**
 * Per-game leaderboard for the public /leaderboard/[gameId] share page.
 *
 * Unlike `getLeaderboard()` which only ranks signed-in users across many games,
 * this returns EVERY non-host player in the given game — anonymous nicknames
 * included. For a single-game permalink the nickname IS the identity, so
 * filtering them out would gut the page.
 *
 * Score source: `players.final_score` (authoritative after the boot sweep + the
 * `finishGame()` write). For mid-game / not-yet-finished games this still works
 * but callers should gate on `getGameMetadata()` returning non-null first.
 */
export interface GameLeaderboardEntry {
  player_id: string;
  name: string;
  avatar_url: string | null;
  total_score: number;
  correct_count: number;
  total_answers: number;
  is_signed_in: boolean;
}

export function getGameLeaderboard(gameId: string, opts: { limit?: number } = {}): GameLeaderboardEntry[] {
  const limit = opts.limit ?? 20;
  const rows = getDb()
    .prepare(
      // For signed-in players the public name is u.display_name (first name
       // only, set on sign-in). Anonymous players show whatever nickname they
       // typed in at /join. COALESCE order is: display_name → users.name →
       // players.name (the typed-in nickname).
      `SELECT
        p.id                                                       AS player_id,
        COALESCE(u.display_name, u.name, p.name)                   AS name,
        u.avatar_url                                               AS avatar_url,
        p.final_score                                              AS total_score,
        COALESCE(SUM(CASE WHEN a.was_correct = 1 THEN 1 ELSE 0 END), 0) AS correct_count,
        COALESCE(COUNT(a.question_index), 0)                       AS total_answers,
        CASE WHEN p.user_id IS NOT NULL THEN 1 ELSE 0 END          AS is_signed_in
       FROM players p
       LEFT JOIN answers a ON a.player_id = p.id AND a.game_id = p.game_id
       LEFT JOIN users u   ON u.id = p.user_id
       WHERE p.game_id = ?
         AND p.is_host = 0
       GROUP BY p.id
       ORDER BY total_score DESC, p.joined_at ASC
       LIMIT ?`
    )
    .all(gameId, limit) as Array<Omit<GameLeaderboardEntry, 'is_signed_in'> & { is_signed_in: number }>;

  return rows.map((r) => ({
    player_id: r.player_id,
    name: r.name,
    avatar_url: r.avatar_url,
    total_score: r.total_score,
    correct_count: r.correct_count,
    total_answers: r.total_answers,
    is_signed_in: r.is_signed_in === 1,
  }));
}

export interface GameMetadata {
  title: string;
  pin: string;
  player_count: number;
  finished_at: number;
  question_count: number;
}

/**
 * Returns the game's display metadata for the public share page.
 * Returns null if the game doesn't exist OR isn't finished yet — this gates
 * in-progress games from leaking via guessable IDs.
 */
export function getGameMetadata(gameId: string): GameMetadata | null {
  const row = getDb()
    .prepare(
      `SELECT title, pin, player_count, finished_at, question_count
       FROM games
       WHERE id = ? AND finished_at IS NOT NULL`
    )
    .get(gameId) as
    | { title: string; pin: string; player_count: number; finished_at: number; question_count: number }
    | undefined;
  return row ?? null;
}

// ============================================================================
// QUIZ LIBRARY (curated)
// ============================================================================

export interface LibraryQuizSummary {
  id: string;
  slug: string;
  title: string;
  subject: string | null;
  grade: number | null;
  language: string | null;
  description: string | null;
  question_count: number;
  default_think_time: number;
  default_answer_time: number;
  default_shuffle_answers: number; // 0/1
  created_at: number;
}

export interface LibraryQuestionRow {
  id: string;
  question_index: number;
  text: string;
  options_json: string;
  correct_answer: number;
  correct_answers: string | null;
  question_type: string;
  time_limit: number;
  explanation: string | null;
  image_url: string | null;
}

/**
 * Public list of curated quizzes. Filters optional. Sort by created_at DESC so
 * newest content surfaces first. Caller paginates with limit/offset.
 */
export function listLibraryQuizzes(opts: {
  limit?: number;
  offset?: number;
  subject?: string;
  grade?: number;
} = {}): LibraryQuizSummary[] {
  const limit = opts.limit ?? 24;
  const offset = opts.offset ?? 0;
  const conditions: string[] = ['published = 1'];
  const params: Array<string | number> = [];
  if (opts.subject) {
    conditions.push('subject = ?');
    params.push(opts.subject);
  }
  if (opts.grade !== undefined) {
    conditions.push('grade = ?');
    params.push(opts.grade);
  }
  const where = conditions.join(' AND ');
  return getDb()
    .prepare(
      `SELECT id, slug, title, subject, grade, language, description, question_count,
              default_think_time, default_answer_time, default_shuffle_answers, created_at
         FROM quiz_library
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as LibraryQuizSummary[];
}

export function countLibraryQuizzes(opts: { subject?: string; grade?: number } = {}): number {
  const conditions: string[] = ['published = 1'];
  const params: Array<string | number> = [];
  if (opts.subject) {
    conditions.push('subject = ?');
    params.push(opts.subject);
  }
  if (opts.grade !== undefined) {
    conditions.push('grade = ?');
    params.push(opts.grade);
  }
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM quiz_library WHERE ${conditions.join(' AND ')}`)
    .get(...params) as { c: number };
  return row.c;
}

export function getLibraryQuiz(id: string): LibraryQuizSummary | null {
  const row = getDb()
    .prepare(
      `SELECT id, slug, title, subject, grade, language, description, question_count,
              default_think_time, default_answer_time, default_shuffle_answers, created_at
         FROM quiz_library
         WHERE id = ? AND published = 1`
    )
    .get(id) as LibraryQuizSummary | undefined;
  return row ?? null;
}

export function getLibraryQuizQuestions(libraryId: string): LibraryQuestionRow[] {
  return getDb()
    .prepare(
      `SELECT id, question_index, text, options_json, correct_answer, correct_answers,
              question_type, time_limit, explanation, image_url
         FROM quiz_library_questions
         WHERE library_id = ?
         ORDER BY question_index ASC`
    )
    .all(libraryId) as LibraryQuestionRow[];
}

/**
 * Insert (or replace by slug) a library quiz with its questions. Used by the
 * admin import script — not exposed to end users. The transaction guarantees
 * the quiz row + every question row land together or not at all.
 */
export function insertLibraryQuiz(input: {
  slug: string;
  title: string;
  subject?: string | null;
  grade?: number | null;
  language?: string | null;
  description?: string | null;
  defaultThinkTime?: number;
  defaultAnswerTime?: number;
  defaultShuffleAnswers?: boolean;
  questions: Array<{
    id?: string;
    text: string;
    options: string[];
    correctAnswer: number;
    correctAnswers?: number[];
    questionType?: 'single' | 'multi';
    timeLimit?: number;
    explanation?: string | null;
    imageUrl?: string | null;
  }>;
}): { id: string; replaced: boolean } {
  const d = getDb();
  const now = Date.now();

  const existing = d
    .prepare('SELECT id FROM quiz_library WHERE slug = ?')
    .get(input.slug) as { id: string } | undefined;
  const id = existing?.id ?? crypto.randomUUID();
  const thinkTime = input.defaultThinkTime ?? 5;
  const answerTime = input.defaultAnswerTime ?? 20;
  const shuffle = input.defaultShuffleAnswers ? 1 : 0;

  const upsertQuiz = d.prepare(
    `INSERT OR REPLACE INTO quiz_library (
       id, slug, title, subject, grade, language, description, question_count,
       default_think_time, default_answer_time, default_shuffle_answers, published,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  );

  const deleteQuestions = d.prepare(
    'DELETE FROM quiz_library_questions WHERE library_id = ?'
  );

  const insertQuestion = d.prepare(
    `INSERT INTO quiz_library_questions (
       library_id, question_index, id, text, options_json, correct_answer,
       correct_answers, question_type, time_limit, explanation, image_url
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = d.transaction(() => {
    upsertQuiz.run(
      id,
      input.slug,
      input.title,
      input.subject ?? null,
      input.grade ?? null,
      input.language ?? null,
      input.description ?? null,
      input.questions.length,
      thinkTime,
      answerTime,
      shuffle,
      existing ? (d.prepare('SELECT created_at FROM quiz_library WHERE id = ?').get(id) as { created_at: number }).created_at : now,
      now
    );
    deleteQuestions.run(id);
    input.questions.forEach((q, idx) => {
      insertQuestion.run(
        id,
        idx,
        q.id ?? crypto.randomUUID(),
        q.text,
        JSON.stringify(q.options),
        q.correctAnswer,
        q.questionType === 'multi' && q.correctAnswers ? JSON.stringify(q.correctAnswers) : null,
        q.questionType ?? 'single',
        q.timeLimit ?? answerTime,
        q.explanation ?? null,
        q.imageUrl ?? null
      );
    });
  });
  tx();

  return { id, replaced: !!existing };
}

// ============================================================================
// BOOT
// ============================================================================

export function initDb(): void {
  getDb();
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
