// A table: 3 or 4 seats, a match, turn clocks, the matching window, bot autopilot and per-seat snapshots.
// The server is the only place the real cards exist; a client only ever gets `round.view(seat)`,
// and a private look stays in that view for a few seconds before it is gone for good.

import crypto from 'node:crypto';
import {
  Match, MIN_PLAYERS, MAX_PLAYERS, ROUND_CHOICES, PENALTY_CHOICES,
} from '../engine/round.js';
import { decide, applyAction } from '../engine/bots.js';

export const DEFAULT_SETTINGS = {
  players: 4, rounds: 5, penalty: 10, timers: true,
};

const BOT_NAMES = ['Mira', 'Dev', 'Zoya', 'Kabir', 'Anaya', 'Rohan', 'Tara', 'Veer', 'Isha', 'Neel'];

// `reveal` is how long a private look stays face up. `match` is the window for throwing a matching card.
export const REAL_TIMING = {
  botMin: 900,
  botMax: 1700,
  botMatchMin: 1300,
  botMatchMax: 2600,
  match: 3200,
  reveal: 3000,
  limits: { turn: 30_000, decide: 30_000, power: 30_000 },
};
export const FAST_TIMING = {
  botMin: 5,
  botMax: 15,
  botMatchMin: 5,
  botMatchMax: 20,
  match: 60,
  reveal: 200,
  limits: { turn: 400, decide: 400, power: 400 },
};

const AWAY_AFTER = 2; // consecutive timeouts before a seat is put on autopilot
const clean = (s) => String(s ?? '').replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, 16);
const int = (x) => (Number.isInteger(x) ? x : -1);

export class Room {
  constructor(code, { timing = REAL_TIMING } = {}) {
    this.code = code;
    this.timing = timing;
    this.settings = { ...DEFAULT_SETTINGS };
    this.seats = Array.from({ length: this.settings.players }, () => ({ kind: 'empty' }));
    this.stage = 'lobby'; // lobby | round | between | over
    this.match = null;
    this.log = [];
    this.cursor = 0;
    this.window = null; // { key, at, ms, bots: { seat: at } } for the open matching window
    this.deadline = null;
    this.timers = [];
    this.version = 0;
    this.lastSeen = Date.now();
  }

  // ------------------------------------------------------------ seats

  isAuto(i) {
    const s = this.seats[i];
    return s.kind === 'bot' || (s.kind === 'human' && (!s.connected || s.afk >= AWAY_AFTER));
  }

  humansOnline() {
    return this.seats.some((s) => s.kind === 'human' && s.connected);
  }

  /** The first connected human runs the table. */
  hostSeat() {
    const online = this.seats.findIndex((s) => s.kind === 'human' && s.connected);
    if (online >= 0) return online;
    const any = this.seats.findIndex((s) => s.kind === 'human');
    return any >= 0 ? any : 0;
  }

  uniqueName(base, except = -1) {
    const taken = new Set(this.seats.map((s, i) => (i === except || s.kind === 'empty' ? null : s.name.toLowerCase())));
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    return name;
  }

  join(ws, { name, token } = {}) {
    this.lastSeen = Date.now();
    const known = token ? this.seats.findIndex((s) => s.kind === 'human' && s.token === token) : -1;
    if (known >= 0) {
      const seat = this.seats[known];
      if (!this.humansOnline()) this.rearmClocks(); // the table was held while everyone was away
      if (seat.ws && seat.ws !== ws) { try { seat.ws.close(4000, 'replaced'); } catch { /* already closed */ } }
      seat.ws = ws;
      seat.connected = true;
      seat.afk = 0;
      if (this.stage !== 'lobby') this.push({ type: 'back', seat: known });
      this.afterChange();
      return { seat: known, token: seat.token };
    }
    if (this.stage !== 'lobby') return { error: 'started', msg: 'This table has already started. Ask the host to begin a new match.' };
    let i = this.seats.findIndex((s) => s.kind === 'empty');
    if (i < 0) i = this.seats.findIndex((s) => s.kind === 'bot'); // a person takes a bot's chair
    if (i < 0) return { error: 'full', msg: `All ${this.seats.length} seats are taken.` };
    const newToken = crypto.randomUUID();
    this.seats[i] = {
      kind: 'human',
      name: this.uniqueName(clean(name) || `Player ${i + 1}`, i),
      token: newToken,
      ws,
      connected: true,
      afk: 0,
    };
    this.afterChange();
    return { seat: i, token: newToken };
  }

  detach(ws) {
    const i = this.seats.findIndex((s) => s.kind === 'human' && s.ws === ws);
    if (i < 0) return;
    this.seats[i].ws = null;
    this.seats[i].connected = false;
    this.lastSeen = Date.now();
    if (this.stage !== 'lobby') this.push({ type: 'away', seat: i });
    this.afterChange();
  }

  setPlayers(n) {
    if (n === this.seats.length) return null;
    if (n > this.seats.length) {
      while (this.seats.length < n) this.seats.push({ kind: 'empty' });
      return null;
    }
    // Shrinking: the chairs that go away must not hold a person. Bots simply leave.
    if (this.seats.slice(n).some((s) => s.kind === 'human')) {
      return `Seat ${n + 1} has a player in it. Remove them first to play with ${n}.`;
    }
    this.seats.length = n;
    return null;
  }

  // ----------------------------------------------------------- dispatch

  /** Handle a message from the human at `seat`. Returns an error string or null. */
  handle(seat, msg) {
    this.lastSeen = Date.now();
    const me = this.seats[seat];
    const host = seat === this.hostSeat();
    switch (msg.t) {
      case 'settings': {
        if (!host || this.stage !== 'lobby') return 'Only the host can change settings, before the match starts.';
        if (ROUND_CHOICES.includes(msg.rounds)) this.settings.rounds = msg.rounds;
        if (PENALTY_CHOICES.includes(msg.penalty)) this.settings.penalty = msg.penalty;
        if (typeof msg.timers === 'boolean') this.settings.timers = msg.timers;
        if (Number.isInteger(msg.players) && msg.players >= MIN_PLAYERS && msg.players <= MAX_PLAYERS) {
          const err = this.setPlayers(msg.players);
          if (err) return err;
          this.settings.players = this.seats.length;
        }
        break;
      }
      case 'addBot': {
        if (!host || this.stage !== 'lobby') return 'Only the host can seat bots, before the match starts.';
        const i = Number.isInteger(msg.seat) ? msg.seat : this.seats.findIndex((s) => s.kind === 'empty');
        if (i < 0 || i >= this.seats.length || this.seats[i].kind !== 'empty') return 'That seat is not empty.';
        this.seatBot(i);
        break;
      }
      case 'removeSeat': {
        if (!host || this.stage !== 'lobby') return 'Only the host can free a seat, before the match starts.';
        const i = msg.seat;
        if (!Number.isInteger(i) || i < 0 || i >= this.seats.length || this.seats[i].kind === 'empty') return 'That seat is already empty.';
        if (i === seat) return 'You cannot remove yourself.';
        const s = this.seats[i];
        if (s.kind === 'human' && s.ws) { try { s.ws.close(4001, 'removed'); } catch { /* closed */ } }
        this.seats[i] = { kind: 'empty' };
        break;
      }
      case 'start': {
        if (!host) return 'Only the host can start the match.';
        if (this.stage !== 'lobby') return 'The match has already started.';
        if (!msg.fillBots && this.seats.some((s) => s.kind === 'empty')) return 'Fill every seat, or start with bots in the empty ones.';
        this.seats.forEach((s, i) => { if (s.kind === 'empty') this.seatBot(i); });
        this.match = new Match({ players: this.seats.length, rounds: this.settings.rounds, penalty: this.settings.penalty });
        this.beginRound();
        break;
      }
      case 'next': {
        if (!host) return 'Only the host can continue.';
        if (this.stage !== 'between') return 'The round is not over yet.';
        if (this.match.finished) this.stage = 'over';
        else this.beginRound();
        break;
      }
      case 'rematch': {
        if (!host) return 'Only the host can reset the table.';
        if (this.stage !== 'over') return 'The match is not over.';
        this.match = null;
        this.log = [];
        this.stage = 'lobby';
        break;
      }
      case 'resume': {
        me.afk = 0;
        break;
      }
      case 'declare': case 'draw': case 'swap': case 'discard': case 'power': case 'match': {
        if (this.stage !== 'round') return 'There is no round in play.';
        if (msg.t !== 'match') me.afk = 0;
        const res = this.apply(seat, this.toAction(msg));
        return res.ok ? null : res.error;
      }
      default:
        return 'Unknown action.';
    }
    this.afterChange();
    return null;
  }

  /** Turn a wire message into an engine action. Only whitelisted fields get through. */
  toAction(msg) {
    switch (msg.t) {
      case 'declare': return { type: 'declare' };
      case 'draw': return { type: 'draw' };
      case 'swap': return { type: 'swapIn', pos: int(msg.pos) };
      case 'discard': return { type: 'discard' };
      case 'match': return { type: 'match', pos: int(msg.pos) };
      case 'power': {
        const t = ['peek', 'swap', 'skip'].includes(msg.a) ? msg.a : '';
        return {
          type: 'power', t, pos: int(msg.pos), owner: int(msg.owner), opos: int(msg.opos),
        };
      }
      default: return { type: '' };
    }
  }

  seatBot(i) {
    const used = new Set(this.seats.map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${i + 1}`;
    this.seats[i] = { kind: 'bot', name };
  }

  beginRound() {
    this.match.startRound();
    this.stage = 'round';
    this.log = [];
    this.cursor = 0;
    this.window = null;
    this.pullEvents();
  }

  // -------------------------------------------------------------- engine

  apply(seat, action) {
    const res = applyAction(this.match.round, seat, action);
    if (res.ok) this.afterEngine();
    return res;
  }

  push(event) {
    this.log.push({ id: this.log.length, at: Date.now(), ...event });
  }

  pullEvents() {
    const round = this.match.round;
    const fresh = round.events.slice(this.cursor);
    this.cursor = round.events.length;
    for (const e of fresh) this.push(e);
    return fresh;
  }

  afterEngine() {
    const round = this.match.round;
    this.pullEvents();
    if (round.phase === 'match' && this.window?.key !== round.turns) this.openWindow(round);
    if (round.phase !== 'match') this.window = null;
    if (round.phase === 'done') {
      this.match.settle();
      this.stage = 'between';
    }
    this.afterChange();
  }

  /** A new card is on the pile: give everyone the same window, and decide now when each bot would throw. */
  openWindow(round) {
    const now = Date.now();
    const { match, botMatchMin, botMatchMax } = this.timing;
    const bots = {};
    this.seats.forEach((_, s) => {
      if (this.isAuto(s) && decide(round.botView(s))) {
        bots[s] = now + botMatchMin + Math.random() * Math.min(botMatchMax - botMatchMin, match - botMatchMin);
      }
    });
    this.window = {
      key: round.turns, at: now + match, ms: match, bots,
    };
  }

  // ------------------------------------------------------ scheduling + io

  afterChange() {
    this.schedule();
    this.broadcast();
  }

  /** Clocks are wall-clock deadlines, so give them their full time back after the table was held. */
  rearmClocks() {
    const now = Date.now();
    if (this.window) {
      const shift = now + this.window.ms - this.window.at;
      this.window.at += shift;
      Object.keys(this.window.bots).forEach((s) => { this.window.bots[s] += shift; });
    }
  }

  after(ms, fn) {
    this.timers.push(setTimeout(fn, Math.max(0, ms)));
  }

  clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  /** Set the timers for whatever happens next. Called after every change, so it starts from scratch each time. */
  schedule() {
    this.clearTimers();
    this.deadline = null;
    if (this.stage !== 'round') return;
    if (!this.humansOnline()) return; // nobody is watching: hold the table
    const round = this.match.round;
    const now = Date.now();

    if (round.phase === 'match' && this.window) {
      this.after(this.window.at - now, () => this.closeWindow());
      for (const [s, at] of Object.entries(this.window.bots)) {
        const seat = Number(s);
        if (!round.match.tried.includes(seat)) this.after(at - now, () => this.autopilot(seat, false));
      }
      return;
    }

    const actor = round.currentActor();
    if (actor === null) return;
    const { botMin, botMax, limits } = this.timing;
    if (this.isAuto(actor)) {
      this.after(botMin + Math.random() * (botMax - botMin), () => this.autopilot(actor, false));
    } else if (this.settings.timers) {
      const ms = limits[round.phase];
      this.deadline = { seat: actor, at: now + ms, ms };
      this.after(ms, () => this.autopilot(actor, true));
    }
  }

  closeWindow() {
    if (this.stage !== 'round') return;
    const round = this.match.round;
    if (round.phase === 'match') {
      round.closeMatch();
      this.afterEngine();
    } else {
      this.afterChange();
    }
  }

  autopilot(seat, timedOut) {
    if (this.stage !== 'round') return;
    const round = this.match.round;
    if (round.phase === 'match') {
      const a = decide(round.botView(seat));
      if (a?.type === 'match') this.apply(seat, a);
      return;
    }
    if (round.currentActor() !== seat) { this.afterChange(); return; }
    const s = this.seats[seat];
    if (timedOut) {
      s.afk = (s.afk ?? 0) + 1;
      this.push({ type: 'timeout', seat });
      if (s.afk === AWAY_AFTER) this.push({ type: 'autopilot', seat });
    }
    let a = null;
    try { a = decide(round.botView(seat)); } catch (err) { console.error('autopilot error:', err); }
    // A person on autopilot is never declared for: ending the round is their call.
    if (a?.type === 'declare' && s.kind === 'human') a = { type: 'draw' };
    let res = a ? this.apply(seat, a) : { ok: false, error: 'no decision' };
    if (!res.ok) {
      console.error(`autopilot fell back (${res.error})`);
      res = this.apply(seat, this.safeMove(round));
      if (!res.ok) this.afterChange();
    }
  }

  /** Last-resort legal move so a bug in a bot can never stall a table. */
  safeMove(round) {
    if (round.phase === 'turn') return { type: 'draw' };
    if (round.phase === 'decide') return { type: 'discard' };
    return { type: 'power', t: 'skip' };
  }

  snapshotFor(i) {
    const now = Date.now();
    const snap = {
      now,
      room: this.code,
      you: i,
      host: this.hostSeat(),
      settings: { ...this.settings },
      stage: this.stage,
      timing: { reveal: this.timing.reveal },
      seats: this.seats.map((s, idx) => ({
        kind: s.kind,
        name: s.name ?? '',
        connected: s.kind === 'human' ? s.connected : s.kind === 'bot',
        auto: s.kind === 'empty' ? false : this.isAuto(idx),
      })),
      game: null,
    };
    if (this.match) {
      const m = this.match;
      snap.scores = [...m.scores];
      snap.history = m.history;
      snap.roundNo = m.roundNo;
      snap.rounds = m.rounds;
      snap.standings = m.standings();
    }
    if (this.match?.round && this.stage !== 'lobby') {
      const v = this.match.round.view(i);
      // A private look is face up for a few seconds, then it exists only in the player's memory.
      v.reveals = v.reveals.filter((r) => now - r.at < this.timing.reveal);
      snap.game = {
        ...v,
        deadline: this.deadline,
        window: this.window ? { at: this.window.at, ms: this.window.ms } : null,
        log: this.log.slice(-150),
      };
    }
    return snap;
  }

  broadcast() {
    this.version += 1;
    this.seats.forEach((s, i) => {
      if (s.kind !== 'human' || !s.ws || s.ws.readyState !== 1) return;
      s.ws.send(JSON.stringify({ t: 'state', v: this.version, s: this.snapshotFor(i) }));
    });
  }

  dispose() {
    this.clearTimers();
  }
}
