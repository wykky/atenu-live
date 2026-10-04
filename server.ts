import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';
import { GameServer } from './src/lib/game';
import { SOCKET_PATH } from './src/lib/socket-config';
import { initDb, closeDb, sweepInflightGamesOnBoot, deleteOldGames, getGameTsv, countLibraryQuizzes, insertLibraryQuiz } from './src/lib/db';
import { logRateLimitSummary } from './src/lib/rate-limit';

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = parseInt(process.env.PORT || '3000');

// CORS allow-list. In dev we accept localhost; in prod we require explicit ALLOWED_ORIGINS env var.
// Default production set: live.atenu.org + Atenu Live tunnel (Cloudflare).
const defaultAllowed = dev
  ? [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ]
  : [
      'https://live.atenu.org',
    ];

const allowedOrigins = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : defaultAllowed
);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Phase 4: DB init + boot sweep (mark any in-flight game as finished — server crashed mid-game)
initDb();
const swept = sweepInflightGamesOnBoot((gameId) => getGameTsv(gameId));
if (swept > 0) console.log(`[db] Boot sweep: marked ${swept} in-flight game(s) as finished`);

// Seed one sample quiz on the very first boot so /library isn't empty for the
// first visitor. Idempotent: only seeds when the library has zero entries.
// Real curated content gets imported via scripts/import-library-quiz.ts later.
try {
  if (countLibraryQuizzes() === 0) {
    insertLibraryQuiz({
      slug: 'sample-ethiopia-geography',
      title: 'Ethiopia geography — sample',
      subject: 'Geography',
      grade: 9,
      language: 'en',
      description: 'A taste of the library. Five quick Ethiopia-themed questions.',
      defaultThinkTime: 5,
      defaultAnswerTime: 20,
      defaultShuffleAnswers: true,
      questions: [
        {
          text: 'What is the capital of Ethiopia?',
          options: ['Mekele', 'Addis Ababa', 'Hawassa', 'Dire Dawa'],
          correctAnswer: 1,
          explanation: 'Addis Ababa has been the capital since Emperor Menelik II founded it in 1886.',
        },
        {
          text: 'Which Ethiopian lake is the source of the Blue Nile?',
          options: ['Lake Tana', 'Lake Abaya', 'Lake Turkana', 'Lake Chamo'],
          correctAnswer: 0,
          explanation: 'The Blue Nile flows out of Lake Tana in the northern highlands.',
        },
        {
          text: 'What is the highest mountain in Ethiopia?',
          options: ['Mount Batu', 'Mount Guna', 'Ras Dashen', 'Mount Choke'],
          correctAnswer: 2,
          explanation: 'Ras Dashen in the Simien range reaches 4,550 m.',
        },
        {
          text: 'The Great Rift Valley runs through Ethiopia in which general direction?',
          options: ['East to west', 'Northeast to southwest', 'North to south', 'Circular around the centre'],
          correctAnswer: 1,
          explanation: 'The Rift cuts diagonally from the Red Sea down toward the Kenyan border.',
        },
        {
          text: 'Which region is home to the Danakil Depression, one of the hottest places on Earth?',
          options: ['Oromia', 'Amhara', 'Afar', 'Tigray'],
          correctAnswer: 2,
          explanation: 'The Danakil sits in the Afar Region — temperatures regularly exceed 45°C.',
        },
      ],
    });
    console.log('[db] Seeded sample library quiz');
  }
} catch (e) {
  console.error('[db] Library seed error (non-fatal):', e);
}

// Retention: delete games finished more than 366 days ago — runs every 24h
const RETENTION_DAYS = 366;
setInterval(() => {
  try {
    const removed = deleteOldGames(RETENTION_DAYS);
    if (removed > 0) console.log(`[db] Retention sweep: deleted ${removed} game(s) older than ${RETENTION_DAYS} days`);
  } catch (e) {
    console.error('[db] Retention sweep error:', e);
  }
}, 24 * 60 * 60 * 1000);

// Rate-limit observability: log per-limiter breach counts every 60s. Quiet when
// no breaches — this only fires under load or attack, so non-empty output is a signal.
setInterval(logRateLimitSummary, 60_000);

app.prepare().then(() => {
  const httpServer = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  const io = new SocketIOServer(httpServer, {
    path: SOCKET_PATH,
    addTrailingSlash: false,
    // 512 KB cap — generous for a ~100-question quiz import, blocks 100MB DoS payloads
    maxHttpBufferSize: 512 * 1024,
    // Socket.io v4 ships with WebSocket compression OFF. Our payloads are highly
    // repetitive JSON (player rosters, leaderboards), which deflates roughly 40x —
    // a 200-player leaderboard packet measured 136 KB raw vs 3.1 KB deflated. On a
    // shared classroom uplink in Ethiopia, bytes are latency, so this is the single
    // cheapest win available. threshold:1024 leaves the small hot-path frames
    // (answeringPhase, per-answer acks) uncompressed so we don't burn CPU on them.
    perMessageDeflate: { threshold: 1024 },
    // On a short drop (3G handover, tab backgrounded) the client comes back with the SAME
    // socket.id, rooms restored, and the room events it missed are replayed. The client
    // still re-validates on every reconnect (see /game/[id]) because 'disconnect' already
    // fired server-side and marked the player offline.
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: true,
    },
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  console.log('[server] Socket.io CORS allow-list:', allowedOrigins);

  // Initialize the modular GameServer
  const gameServer = new GameServer(io);

  // Graceful shutdown handling
  process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    gameServer.shutdown();
    closeDb();
    httpServer.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    gameServer.shutdown();
    closeDb();
    httpServer.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  });

  httpServer
    .once('error', (err) => {
      console.error('Server error:', err);
      process.exit(1);
    })
    .listen(port, () => {
      console.log(`Ready on http://${hostname}:${port}`);
      console.log('Game server initialized with modular architecture');
    });
});
