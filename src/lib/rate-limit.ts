/**
 * In-memory token-bucket rate limiter.
 *
 * Single Node process, no Redis. Bucket state lives in a Map per limiter.
 * Tokens refill lazily on each consume() call — no per-bucket setInterval.
 *
 * Why token bucket vs fixed window: legitimate classrooms produce a burst
 * (200 students join in 30s) followed by quiet. Attackers produce sustained
 * high rate. Bucket capacity tolerates the burst; refill rate caps the sustained.
 *
 * Why layered keys (ip + ip:pin etc.): one classroom = one IP = many students,
 * so per-IP alone is wrong. A bot scanning 1000 PINs from one IP shows up in
 * per-IP; real students all hit the same (ip,pin) so a tight per-(ip,pin) limit
 * with a loose per-ip limit separates the two cases.
 */

interface BucketConfig {
  capacity: number;       // burst size (and initial token count)
  refillIntervalMs: number; // ms required to gain one token
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private cfg: BucketConfig) {
    this.tokens = cfg.capacity;
    this.lastRefill = Date.now();
  }

  consume(cost = 1): boolean {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.cfg.capacity, this.tokens + elapsed / this.cfg.refillIntervalMs);
      this.lastRefill = now;
    }
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }
}

// Cap to bound memory growth from unique attacker IPs. At ~80 bytes/entry this is ~4 MB.
const MAX_BUCKETS_PER_LIMITER = 50_000;
// Throttle per-key warn logs so a sustained attack doesn't spam stdout.
const PER_KEY_LOG_COOLDOWN_MS = 60_000;

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private firstBreachLogged = new Map<string, number>();
  private breachCount = 0;

  constructor(public readonly name: string, private cfg: BucketConfig) {}

  consume(key: string, cost = 1): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= MAX_BUCKETS_PER_LIMITER) {
        // Drop the oldest entry. Map iteration order = insertion order, so this is
        // a crude LRU that evicts the longest-lived bucket. Good enough for safety
        // cap — attackers can't bloat memory beyond MAX_BUCKETS_PER_LIMITER.
        const k = this.buckets.keys().next().value;
        if (k !== undefined) this.buckets.delete(k);
      }
      bucket = new TokenBucket(this.cfg);
      this.buckets.set(key, bucket);
    }
    const allowed = bucket.consume(cost);
    if (!allowed) {
      this.breachCount++;
      const lastLog = this.firstBreachLogged.get(key) ?? 0;
      if (Date.now() - lastLog > PER_KEY_LOG_COOLDOWN_MS) {
        // Truncate key to avoid logging full UUIDs / tokens
        console.warn(`[rate-limit] BLOCK limiter=${this.name} key=${key.slice(0, 40)}`);
        this.firstBreachLogged.set(key, Date.now());
      }
    }
    return allowed;
  }

  reportAndReset(): { name: string; breaches: number; bucketCount: number } {
    const r = { name: this.name, breaches: this.breachCount, bucketCount: this.buckets.size };
    this.breachCount = 0;
    return r;
  }
}

// ===== Named limiters =====
// Numbers come from the rate-limiting deep-dive — calibrated for an Ethiopian
// classroom (200 students on one school IP) plus normal host workflows.

// joinGame: capacity 250 absorbs the "teacher says 'Join now!'" instant of 200 students
// pressing Enter; 5/s sustained refill keeps trickle-in classrooms healthy AND caps
// PIN enumeration to ~18k/hr per IP. The per-(IP, PIN) cap the audit suggested was
// wrong for shared-NAT classrooms — every student would share the bucket since they
// all join the same PIN from the same school IP.
export const joinGameIpLimiter    = new RateLimiter('joinGame.ip',     { capacity: 250, refillIntervalMs: 200 });

// createGame: 5 per IP / min — accounts have already been gated to signed-in hosts elsewhere.
export const createGameIpLimiter  = new RateLimiter('createGame.ip',   { capacity: 5,  refillIntervalMs: 60_000 });

// submitAnswer: 8 burst, ~2/sec sustained, keyed per player. Even fast clickers stay well under.
export const submitAnswerLimiter  = new RateLimiter('submitAnswer',    { capacity: 8,  refillIntervalMs: 500 });

// validateGame: same shape as joinGame. Every player calls this once per /game/[id] load AND
// once per socket reconnect, and a whole classroom (or an Ethio Telecom CGNAT block) shares
// one IP. The old 30-burst / 0.5-per-s bucket locked the 31st student out for minutes.
export const validateGameLimiter  = new RateLimiter('validateGame.ip', { capacity: 250, refillIntervalMs: 200 });

// downloadGameLogs: rare host action, low limit.
export const downloadLogsLimiter  = new RateLimiter('downloadLogs.ip', { capacity: 5,  refillIntervalMs: 30_000 });

// Host events combined (startGame, nextQuestion, showLeaderboard, endGame, toggleDyslexiaSupport).
// Hosts click these once per question; 30/sec covers heavy debugging and keyboard mashing.
export const hostEventLimiter     = new RateLimiter('hostEvents.hostId', { capacity: 30, refillIntervalMs: 1000 });

// Connection-level: throttle new socket opens per IP.
//
// WAS capacity 30 / refill 2000ms, whose comment claimed "30 / 10s ... without hurting
// a class opening tabs in unison". That was wrong twice over: 1 token per 2000ms is
// 0.5/s (30 per MINUTE, not per 10s), and this gate sits IN FRONT of joinGameIpLimiter,
// so the capacity-250 classroom allowance below could never be reached. A 200-student
// class behind one school IP or Ethio Telecom CGNAT is a single bucket key
// (getSocketIp reads cf-connecting-ip), so 30 students connected and the other 170
// were disconnect(true)'d and admitted at 0.5/s — roughly 340s for the class to get in,
// while socket.io-client (reconnectionAttempts: Infinity) retried every 1-5s throughout.
//
// Now sized to match joinGameIpLimiter's classroom reasoning: absorb the whole
// "everyone opens the link at once" burst, then sustain 5/s for trickle-in and
// reconnects. Still bounds a botnet to 5 new sockets/s per IP.
export const connectionLimiter    = new RateLimiter('connection.ip',   { capacity: 300, refillIntervalMs: 200 });

// AI question generation: 30/min per signed-in user, 10/min per IP as a backstop.
// gpt-4o-mini at ~$0.001/req → $1.80/hr ceiling per user worst-case.
export const aiGenUserLimiter     = new RateLimiter('aiGen.user',      { capacity: 30, refillIntervalMs: 2000 });
export const aiGenIpLimiter       = new RateLimiter('aiGen.ip',        { capacity: 10, refillIntervalMs: 6000 });

// TSV download: 20/sec per user. Generous — these are rare manual clicks.
export const tsvDownloadLimiter   = new RateLimiter('tsvDownload.user', { capacity: 20, refillIntervalMs: 1000 });

const ALL_LIMITERS = [
  joinGameIpLimiter, createGameIpLimiter,
  submitAnswerLimiter, validateGameLimiter, downloadLogsLimiter,
  hostEventLimiter, connectionLimiter,
  aiGenUserLimiter, aiGenIpLimiter, tsvDownloadLimiter,
];

/**
 * Periodic summary log — call from server.ts setInterval(... , 60_000).
 * Quiet when nothing is being blocked; otherwise one line listing breach counts.
 */
export function logRateLimitSummary(): void {
  const reports = ALL_LIMITERS.map((l) => l.reportAndReset());
  const interesting = reports.filter((r) => r.breaches > 0);
  if (interesting.length === 0) return;
  const summary = interesting.map((r) => `${r.name}=${r.breaches}`).join(' ');
  console.log(`[rate-limit] breaches in last 60s: ${summary}`);
}
