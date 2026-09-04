'use strict';

// ---------------------------------------------------------------------------
// Protectiile care fac addonul sigur pe multe dispozitive:
//   Semaphore   — nu depasim niciodata numarul de conexiuni permise de furnizor
//   dedupe      — 30 de dispozitive care cer acelasi lucru = o singura cerere
//   RateLimiter — un dispozitiv nu poate inunda serverul
// ---------------------------------------------------------------------------

class Semaphore {
  constructor(max) {
    this.max = Math.max(1, Number(max) || 1);
    this.active = 0;
    this.queue = [];
    this.peak = 0;
    this.waited = 0;
  }
  setMax(max) { this.max = Math.max(1, Number(max) || 1); this._drain(); }
  _drain() {
    while (this.active < this.max && this.queue.length) {
      const next = this.queue.shift();
      this.active++;
      if (this.active > this.peak) this.peak = this.active;
      next();
    }
  }
  async run(fn) {
    if (this.active >= this.max) {
      this.waited++;
      await new Promise(resolve => this.queue.push(resolve));
    } else {
      this.active++;
      if (this.active > this.peak) this.peak = this.active;
    }
    try { return await fn(); }
    finally { this.active--; this._drain(); }
  }
  stare() { return { max: this.max, active: this.active, asteapta: this.queue.length, varf: this.peak, amanate: this.waited }; }
}

// Cererile identice pornite simultan primesc acelasi rezultat, o singura data.
const inFlight = new Map();
let dedupeHits = 0;

function dedupe(key, fn) {
  const existing = inFlight.get(key);
  if (existing) { dedupeHits++; return existing; }
  const p = (async () => fn())().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

class RateLimiter {
  constructor(limit = 120, windowMs = 60000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.buckets = new Map();
    this.blocked = 0;
  }
  check(key) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || now - b.start >= this.windowMs) { b = { start: now, count: 0 }; this.buckets.set(key, b); }
    b.count++;
    if (this.buckets.size > 500) {
      for (const [k, v] of this.buckets) if (now - v.start >= this.windowMs) this.buckets.delete(k);
    }
    if (b.count > this.limit) { this.blocked++; return { ok: false, retryAfter: Math.ceil((b.start + this.windowMs - now) / 1000) }; }
    return { ok: true, remaining: this.limit - b.count };
  }
  stare() { return { limita: this.limit, fereastraMs: this.windowMs, chei: this.buckets.size, respinse: this.blocked }; }
}

module.exports = { Semaphore, dedupe, RateLimiter, dedupeStats: () => ({ inFlight: inFlight.size, reutilizate: dedupeHits }) };
