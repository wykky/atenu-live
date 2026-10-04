#!/usr/bin/env node
/**
 * Production-runnable port of scripts/import-library-quiz.ts.
 *
 * The TS version imports through path aliases that don't resolve at runtime
 * in the bare Next.js Docker image. This CJS file talks to better-sqlite3
 * directly so it can be invoked with just `node scripts/import-library-quiz.cjs`
 * from inside the atenu-live container — no tsx, no path-alias setup.
 *
 * Same flags as the TS version:
 *   --tsv <path>         (required)
 *   --slug <slug>        (required, unique key for the library quiz)
 *   --title <title>      (required, human-readable)
 *   --subject <subject>  Math / Biology / Geography / ...
 *   --grade <9..12>
 *   --language en|am|om
 *   --description <text>
 *   --think <seconds>    default 5
 *   --answer <seconds>   default 20
 *   --shuffle 1          default off
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const Database = require('better-sqlite3');

const DB_PATH = process.env.ATENU_DB_PATH || '/app/data/atenu.db';

// Mirror of src/lib/game/validators.ts LIMITS — the same caps the live createGame path
// enforces. Kept in sync by hand because this file must run with plain `node` in the
// container (no TS, no path aliases). If you change validators.ts, change this too.
const LIMITS = {
  QUESTION_TEXT_MAX: 1000,
  OPTION_TEXT_MAX: 300,
  EXPLANATION_MAX: 2000,
  IMAGE_URL_MAX: 2048,
  TIME_MIN: 3,
  TIME_MAX: 120,
};

/**
 * Validate every data row against LIMITS. Returns a list of "row N: problem" strings;
 * empty means the file is importable. `rowNo` is the 1-based line number in the TSV
 * (header = line 1) so the message points at the line to fix.
 */
function validateRows(rows) {
  const problems = [];
  rows.forEach((r) => {
    const where = `row ${r.__line}`;
    if (!r.question) problems.push(`${where}: empty question`);
    else if (r.question.length > LIMITS.QUESTION_TEXT_MAX) problems.push(`${where}: question longer than ${LIMITS.QUESTION_TEXT_MAX} chars`);
    for (const col of ['correct', 'wrong1', 'wrong2', 'wrong3']) {
      const v = r[col] ?? '';
      if (!v) problems.push(`${where}: empty ${col}`);
      else if (v.length > LIMITS.OPTION_TEXT_MAX) problems.push(`${where}: ${col} longer than ${LIMITS.OPTION_TEXT_MAX} chars`);
    }
    const opts = [r.correct, r.wrong1, r.wrong2, r.wrong3].filter(Boolean);
    if (new Set(opts).size !== opts.length) problems.push(`${where}: duplicate option text`);
    if (r.explanation && r.explanation.length > LIMITS.EXPLANATION_MAX) {
      problems.push(`${where}: explanation longer than ${LIMITS.EXPLANATION_MAX} chars`);
    }
    if (r.time) {
      const t = Number(r.time);
      if (!Number.isInteger(t) || t < LIMITS.TIME_MIN || t > LIMITS.TIME_MAX) {
        problems.push(`${where}: time must be an integer ${LIMITS.TIME_MIN}..${LIMITS.TIME_MAX} (got "${r.time}")`);
      }
    }
    if (r.image) {
      if (r.image.length > LIMITS.IMAGE_URL_MAX || !/^https?:\/\//i.test(r.image)) {
        problems.push(`${where}: image must be an http(s) URL up to ${LIMITS.IMAGE_URL_MAX} chars`);
      }
    }
  });
  return problems;
}

function parseTsv(content) {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error('TSV must have a header row and at least one data row.');
  }
  const header = lines[0].split('\t').map((h) => h.trim().toLowerCase());
  const required = ['question', 'correct', 'wrong1', 'wrong2', 'wrong3'];
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new Error(`Missing required columns: ${missing.join(', ')}`);
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const row = { __line: i + 1 };
    header.forEach((col, j) => {
      row[col] = (cells[j] ?? '').trim();
    });
    // Rows with an empty question/correct used to be skipped silently, which hid
    // off-by-one column mistakes. validateRows() reports them instead.
    rows.push(row);
  }
  return rows;
}

function shuffleArr(arr, rnd = Math.random) {
  // Shuffle option order ONCE at import time. `rnd` lets callers pass a seeded
  // PRNG so a re-seed reproduces the same layout instead of re-rolling it.
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Deterministic seeded PRNG (mulberry32 seeded via an xfnv1a string hash), so a
// quiz's answer layout is reproducible across re-seeds rather than reshuffled
// every run — the answer key stays stable once seeded.
function seededRng(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Even, clump-free correct-answer slots across all N questions: each of the k
// slots is used ~equally (e.g. 8/8/7/7 for 30 Q over 4 options) and no slot
// repeats 3+ times in a row, so the game never shows a run like C, C, C, C.
function balancedSlots(n, k, rng) {
  const base = [];
  for (let i = 0; i < n; i++) base.push(i % k);
  for (let attempt = 0; attempt < 500; attempt++) {
    const a = base.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    let ok = true;
    for (let i = 2; i < a.length; i++) {
      if (a[i] === a[i - 1] && a[i] === a[i - 2]) {
        ok = false;
        break;
      }
    }
    if (ok) return a;
  }
  return base; // fallback: perfectly balanced, mild clumping tolerated
}

function main() {
  const { values } = parseArgs({
    options: {
      tsv: { type: 'string' },
      slug: { type: 'string' },
      title: { type: 'string' },
      subject: { type: 'string' },
      grade: { type: 'string' },
      language: { type: 'string' },
      description: { type: 'string' },
      think: { type: 'string' },
      answer: { type: 'string' },
      shuffle: { type: 'string' },
    },
    strict: false,
  });

  for (const reqField of ['tsv', 'slug', 'title']) {
    if (!values[reqField]) {
      console.error(`Missing required --${reqField}`);
      process.exit(1);
    }
  }

  const tsv = fs.readFileSync(values.tsv, 'utf8');
  const rows = parseTsv(tsv);
  if (rows.length === 0) {
    console.error('No data rows in TSV.');
    process.exit(1);
  }
  const problems = validateRows(rows);
  if (problems.length > 0) {
    console.error(`Refusing to import ${values.tsv}: ${problems.length} problem(s)`);
    problems.forEach((p) => console.error('  - ' + p));
    process.exit(1);
  }

  const thinkTime = values.think ? parseInt(values.think, 10) : 5;
  const defaultAnswer = values.answer ? parseInt(values.answer, 10) : 20;
  for (const [label, v] of [['--think', thinkTime], ['--answer', defaultAnswer]]) {
    if (!Number.isInteger(v) || v < LIMITS.TIME_MIN || v > LIMITS.TIME_MAX) {
      console.error(`${label} must be an integer ${LIMITS.TIME_MIN}..${LIMITS.TIME_MAX}`);
      process.exit(1);
    }
  }
  const shuffleFlag = values.shuffle === '1' ? 1 : 0;

  // Build canonical question objects. The correct answer is placed at an
  // evenly-distributed, clump-free slot across the whole quiz (not shuffled
  // independently per question) so the answer key can't drift toward one
  // column or produce runs like C, C, C, C. Seeded by slug => reproducible.
  const rng = seededRng(values.slug || values.tsv || 'atenu-live');
  const slots = balancedSlots(rows.length, 4, rng);
  const questions = rows.map((r, idx) => {
    const distractors = shuffleArr([r.wrong1, r.wrong2, r.wrong3], rng);
    const pos = slots[idx] % 4;
    const options = distractors.slice();
    options.splice(pos, 0, r.correct);
    const perQTime = r.time ? parseInt(r.time, 10) : NaN;
    return {
      text: r.question,
      options,
      correctAnswer: pos,
      timeLimit: Number.isFinite(perQTime) ? perQTime : defaultAnswer,
      explanation: r.explanation || null,
      imageUrl: r.image || null,
    };
  });

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  const now = Date.now();

  const existing = db
    .prepare('SELECT id, created_at FROM quiz_library WHERE slug = ?')
    .get(values.slug);
  const id = existing?.id ?? crypto.randomUUID();

  const upsertStmt = db.prepare(
    `INSERT OR REPLACE INTO quiz_library (
       id, slug, title, subject, grade, language, description, question_count,
       default_think_time, default_answer_time, default_shuffle_answers, published,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  );
  const deleteQuestions = db.prepare(
    'DELETE FROM quiz_library_questions WHERE library_id = ?'
  );
  const insertQuestion = db.prepare(
    `INSERT INTO quiz_library_questions (
       library_id, question_index, id, text, options_json, correct_answer,
       correct_answers, question_type, time_limit, explanation, image_url
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    upsertStmt.run(
      id,
      values.slug,
      values.title,
      values.subject || null,
      values.grade ? parseInt(values.grade, 10) : null,
      values.language || null,
      values.description || null,
      questions.length,
      thinkTime,
      defaultAnswer,
      shuffleFlag,
      existing?.created_at ?? now,
      now
    );
    deleteQuestions.run(id);
    questions.forEach((q, idx) => {
      insertQuestion.run(
        id,
        idx,
        crypto.randomUUID(),
        q.text,
        JSON.stringify(q.options),
        q.correctAnswer,
        null,
        'single',
        q.timeLimit,
        q.explanation,
        q.imageUrl
      );
    });
  });
  tx();

  db.close();
  console.log(
    `${existing ? 'Updated' : 'Inserted'}: ${values.title} (${questions.length} questions)`
  );
}

main();
