// Rules engine for one round of Declare, and the match that strings rounds together.
// Pure logic, no timers and no I/O: the server owns time (the matching window, turn clocks) and asks
// this module what is legal. Every method returns { ok: true } or { ok: false, error }.
//
// A round, in phases:
//   turn    the player to act either declares or draws from the deck
//   decide  they hold the drawn card: swap it into one of their slots, or discard it
//   power   the discarded card has a power, and they are using it (or skipping it)
//   match   the discard pile has a new top card; anyone may throw down one card of the same rank
//   done    someone declared; every card is face up and the round is scored

import {
  makeDeck, shuffle, valueOf, powerOf, rankOf, isCard,
} from './cards.js';

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 4;
export const HAND_SIZE = 4;
export const MAX_TURNS = 150; // a safety net only: a round this long ends with a reveal and no declarer

const ok = { ok: true };
const fail = (error) => ({ ok: false, error });

export class Round {
  /**
   * @param {object} o
   * @param {number} o.players 3 or 4
   * @param {number} [o.first] seat that takes the first turn
   * @param {() => number} [o.rng]
   * @param {() => number} [o.now] clock used to stamp private looks, so the server can expire them
   * @param {string[]} [o.deck] a fixed deck order for tests (top of the deck is the end of the array)
   */
  constructor({ players, first = 0, rng = Math.random, now = Date.now, deck = null }) {
    if (players < MIN_PLAYERS || players > MAX_PLAYERS) throw new Error('Declare is for 3 or 4 players');
    this.n = players;
    this.rng = rng;
    this.now = now;
    this.deck = deck ? [...deck] : shuffle(makeDeck(), rng);
    this.discard = [];
    this.hands = Array.from({ length: players }, () => []);
    for (let k = 0; k < HAND_SIZE; k++) {
      for (let s = 0; s < players; s++) this.hands[s].push(this.deck.pop());
    }
    // What each seat has seen and can still track. Cards only ever move in public (swaps are announced),
    // so knowing a card's identity is enough: its position is always the engine's own.
    this.knows = Array.from({ length: players }, () => new Set());
    this.reveals = []; // private looks: { id, seat, owner, pos, card, at }
    this.events = [];
    this.turn = first;
    this.phase = 'turn';
    this.drawn = null;
    this.power = null; // { kind, card, step, pick }
    this.match = null; // { top, tried: number[], by }
    this.turns = 0;
    this.result = null;
    this.events.push({ type: 'deal', first });
  }

  // ------------------------------------------------------------ helpers

  currentActor() {
    return this.phase === 'turn' || this.phase === 'decide' || this.phase === 'power' ? this.turn : null;
  }

  top() { return this.discard.at(-1) ?? null; }

  slotOk(owner, pos) {
    return Number.isInteger(owner) && owner >= 0 && owner < this.n
      && Number.isInteger(pos) && pos >= 0 && pos < this.hands[owner].length
      && this.hands[owner][pos] !== null;
  }

  filled(seat) { return this.hands[seat].flatMap((c, pos) => (c === null ? [] : [pos])); }

  opponentsWithCards(seat) {
    return Array.from({ length: this.n }, (_, s) => s).filter((s) => s !== seat && this.filled(s).length);
  }

  /** Take the top of the deck, first turning the discard pile over (keeping its top card) if the deck is out. */
  takeFromDeck() {
    if (!this.deck.length) {
      if (this.discard.length < 2) return null;
      const keep = this.discard.pop();
      const back = this.discard;
      this.discard = [keep];
      this.deck = shuffle(back, this.rng);
      for (const k of this.knows) back.forEach((c) => k.delete(c)); // face down again: nobody knows them
      this.events.push({ type: 'reshuffle', count: this.deck.length });
    }
    return this.deck.pop();
  }

  lookAt(seat, owner, pos) {
    const card = this.hands[owner][pos];
    this.knows[seat].add(card);
    this.reveals.push({
      id: this.reveals.length, seat, owner, pos, card, at: this.now(),
    });
  }

  swapSlots(a, ap, b, bp) {
    const t = this.hands[a][ap];
    this.hands[a][ap] = this.hands[b][bp];
    this.hands[b][bp] = t;
  }

  revealToAll(card) { this.knows.forEach((k) => k.add(card)); }

  // ------------------------------------------------------------ actions

  /** Turn phase: end the round now and reveal everything. */
  declare(seat) {
    if (this.phase !== 'turn') return fail('You can only declare at the start of your turn, before drawing.');
    if (seat !== this.turn) return fail('It is not your turn.');
    this.events.push({ type: 'declare', seat });
    this.finish(seat);
    return ok;
  }

  draw(seat) {
    if (this.phase !== 'turn') return fail('You cannot draw now.');
    if (seat !== this.turn) return fail('It is not your turn.');
    const card = this.takeFromDeck();
    if (!card) return fail('The deck is empty.');
    this.drawn = card;
    this.knows[seat].add(card);
    this.phase = 'decide';
    this.events.push({ type: 'draw', seat });
    return ok;
  }

  /** Decide phase: put the drawn card in slot `pos`; the card that was there goes face up on the pile. */
  swapIn(seat, pos) {
    if (this.phase !== 'decide' || seat !== this.turn) return fail('You are not holding a drawn card.');
    if (!this.slotOk(seat, pos)) return fail('Pick one of your cards.');
    const old = this.hands[seat][pos];
    this.hands[seat][pos] = this.drawn;
    this.drawn = null;
    this.discard.push(old);
    this.revealToAll(old);
    this.events.push({
      type: 'swap', seat, pos, card: old,
    });
    this.endTurn();
    return ok;
  }

  /** Decide phase: put the drawn card straight on the pile. A power card then offers its power. */
  discardDrawn(seat) {
    if (this.phase !== 'decide' || seat !== this.turn) return fail('You are not holding a drawn card.');
    const card = this.drawn;
    this.drawn = null;
    this.discard.push(card);
    this.revealToAll(card);
    const kind = powerOf(card);
    const usable = kind && this.powerUsable(seat, kind);
    this.events.push({
      type: 'discard', seat, card, power: usable ? kind : null,
    });
    if (usable) {
      this.power = {
        kind, card, step: 1, pick: null,
      };
      this.phase = 'power';
    } else {
      this.endTurn();
    }
    return ok;
  }

  powerUsable(seat, kind) {
    const mine = this.filled(seat).length > 0;
    const theirs = this.opponentsWithCards(seat).length > 0;
    if (kind === 'peekOwn' || kind === 'queen') return mine;
    if (kind === 'peekOther') return theirs;
    return mine && theirs; // blindSwap, king
  }

  /**
   * Power phase. Actions, by power:
   *   peekOwn    { t: 'peek', pos }
   *   peekOther  { t: 'peek', owner, pos }
   *   blindSwap  { t: 'swap', pos, owner, opos }
   *   queen      step 1 { t: 'peek', pos }, step 2 { t: 'swap', pos, owner, opos } or { t: 'skip' }
   *   king       step 1 { t: 'peek', pos, owner, opos }, step 2 { t: 'swap' } or { t: 'skip' }
   * Any power can be given up with { t: 'skip' }.
   */
  usePower(seat, a = {}) {
    if (this.phase !== 'power' || seat !== this.turn) return fail('You have no power to use.');
    const P = this.power;
    const own = (pos) => this.slotOk(seat, pos);
    const other = (owner, pos) => owner !== seat && this.slotOk(owner, pos);

    if (a.t === 'skip') {
      this.events.push({ type: 'skip', seat, power: P.kind, step: P.step });
      this.endTurn();
      return ok;
    }

    switch (P.kind) {
      case 'peekOwn': {
        if (a.t !== 'peek' || !own(a.pos)) return fail('Pick one of your own cards to look at.');
        this.lookAt(seat, seat, a.pos);
        this.events.push({
          type: 'peek', seat, owner: seat, pos: a.pos,
        });
        this.endTurn();
        return ok;
      }
      case 'peekOther': {
        if (a.t !== 'peek' || !other(a.owner, a.pos)) return fail('Pick a card of another player to look at.');
        this.lookAt(seat, a.owner, a.pos);
        this.events.push({
          type: 'peek', seat, owner: a.owner, pos: a.pos,
        });
        this.endTurn();
        return ok;
      }
      case 'blindSwap': {
        if (a.t !== 'swap' || !own(a.pos) || !other(a.owner, a.opos)) return fail('Pick one of your cards and one of another player’s.');
        this.swapSlots(seat, a.pos, a.owner, a.opos);
        this.events.push({
          type: 'trade', seat, pos: a.pos, owner: a.owner, opos: a.opos, power: 'blindSwap',
        });
        this.endTurn();
        return ok;
      }
      case 'queen': {
        if (P.step === 1) {
          if (a.t !== 'peek' || !own(a.pos)) return fail('Pick one of your own cards to look at.');
          this.lookAt(seat, seat, a.pos);
          this.events.push({
            type: 'peek', seat, owner: seat, pos: a.pos,
          });
          P.step = 2;
          P.pick = { pos: a.pos };
          if (!this.opponentsWithCards(seat).length) this.endTurn(); // nobody to swap with
          return ok;
        }
        if (a.t !== 'swap' || !own(a.pos) || !other(a.owner, a.opos)) return fail('Pick one of your cards and one of another player’s, or skip the swap.');
        this.swapSlots(seat, a.pos, a.owner, a.opos);
        this.events.push({
          type: 'trade', seat, pos: a.pos, owner: a.owner, opos: a.opos, power: 'queen',
        });
        this.endTurn();
        return ok;
      }
      case 'king': {
        if (P.step === 1) {
          if (a.t !== 'peek' || !own(a.pos) || !other(a.owner, a.opos)) return fail('Pick one of your cards and one of another player’s to look at.');
          this.lookAt(seat, seat, a.pos);
          this.lookAt(seat, a.owner, a.opos);
          this.events.push({
            type: 'kingPeek', seat, pos: a.pos, owner: a.owner, opos: a.opos,
          });
          P.step = 2;
          P.pick = { pos: a.pos, owner: a.owner, opos: a.opos };
          return ok;
        }
        if (a.t !== 'swap') return fail('Swap the two cards, or keep them where they are.');
        const { pos, owner, opos } = P.pick;
        this.swapSlots(seat, pos, owner, opos);
        this.events.push({
          type: 'trade', seat, pos, owner, opos, power: 'king',
        });
        this.endTurn();
        return ok;
      }
      default:
        return fail('Unknown power.');
    }
  }

  endTurn() {
    this.power = null;
    this.turns += 1;
    this.phase = 'match';
    this.match = { top: this.top(), tried: [], by: null };
  }

  /**
   * Match phase: throw one of your own cards onto the pile. Same rank as the top card and it stays there,
   * which ends the window (only one match per discard). Wrong rank and the card goes back face up for
   * everyone to see, and you take one penalty card from the deck. Each player gets one try per window.
   */
  matchCard(seat, pos) {
    if (this.phase !== 'match' || !this.match) return fail('There is nothing to match right now.');
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.n) return fail('Unknown seat.');
    if (this.match.tried.includes(seat)) return fail('You have already tried to match this card.');
    if (!this.slotOk(seat, pos)) return fail('Pick one of your own cards.');
    this.match.tried.push(seat);
    const card = this.hands[seat][pos];
    const top = this.match.top;
    this.revealToAll(card);
    if (rankOf(card) === rankOf(top)) {
      this.hands[seat][pos] = null;
      this.discard.push(card);
      this.match.by = seat;
      this.events.push({
        type: 'match', seat, pos, card, top, ok: true,
      });
      this.nextTurn();
      return ok;
    }
    this.events.push({
      type: 'match', seat, pos, card, top, ok: false,
    });
    const penalty = this.takeFromDeck();
    if (penalty) {
      const hand = this.hands[seat];
      let at = hand.indexOf(null);
      if (at < 0) { at = hand.length; hand.push(penalty); } else hand[at] = penalty;
      this.events.push({ type: 'penalty', seat, pos: at });
    }
    return ok;
  }

  /** The server calls this when the matching window runs out. */
  closeMatch() {
    if (this.phase !== 'match') return fail('No matching window is open.');
    this.nextTurn();
    return ok;
  }

  nextTurn() {
    this.match = null;
    if (this.turns >= MAX_TURNS) {
      this.events.push({ type: 'stalled', turns: this.turns });
      this.finish(null);
      return;
    }
    this.turn = (this.turn + 1) % this.n;
    this.phase = 'turn';
  }

  // ------------------------------------------------------------ scoring

  totalOf(seat) {
    return this.hands[seat].reduce((sum, c) => sum + (c === null ? 0 : valueOf(c)), 0);
  }

  /**
   * The declarer wins only with a total strictly lower than everyone else's. Otherwise the declarer loses,
   * and every other player on the lowest total wins.
   */
  finish(declarer) {
    const totals = Array.from({ length: this.n }, (_, s) => this.totalOf(s));
    const others = totals.map((t, s) => ({ t, s })).filter((x) => x.s !== declarer);
    const best = Math.min(...others.map((x) => x.t));
    let winners;
    let success = false;
    if (declarer !== null && totals[declarer] < best) {
      winners = [declarer];
      success = true;
    } else {
      winners = others.filter((x) => x.t === best).map((x) => x.s);
    }
    this.phase = 'done';
    this.drawn = null;
    this.power = null;
    this.match = null;
    this.result = {
      declarer, success, winners, totals, hands: this.hands.map((h) => [...h]),
    };
    this.events.push({
      type: 'end', declarer, success, winners, totals,
    });
  }

  // ------------------------------------------------------------ views

  /** What `seat` may see. Cards in hands are never included until the round is over. */
  view(seat) {
    const P = this.power;
    const mine = seat === this.turn;
    let power = null;
    if (P) {
      power = { kind: P.kind, card: P.card, step: P.step };
      if (P.pick) {
        power.pick = { ...P.pick };
        // The king's two cards stay in view while their owner decides whether to swap them.
        if (mine && P.kind === 'king') {
          power.pick.cards = [this.hands[seat][P.pick.pos], this.hands[P.pick.owner][P.pick.opos]];
        }
      }
    }
    return {
      phase: this.phase,
      players: this.n,
      you: seat,
      turn: this.turn,
      turns: this.turns,
      slots: this.hands.map((h) => h.map((c) => c !== null)),
      deck: this.deck.length,
      top: this.top(),
      pile: this.discard.length,
      holding: this.drawn !== null,
      drawn: mine ? this.drawn : null,
      power,
      match: this.match ? { top: this.match.top, tried: [...this.match.tried] } : null,
      reveals: this.reveals.filter((r) => r.seat === seat).slice(-6),
      result: this.result,
    };
  }

  /** The view plus everything this seat has seen and can still track. Used by bots and autopilot. */
  botView(seat) {
    const v = this.view(seat);
    v.known = this.hands.map((h) => h.map((c) => (c !== null && this.knows[seat].has(c) ? c : null)));
    return v;
  }
}

export const ROUND_CHOICES = [3, 5, 8, 10];
export const PENALTY_CHOICES = [0, 10, 20];

/**
 * A match: several rounds, scores carried over, lowest total wins.
 * Each round, winners add nothing; everyone else adds their hand total. A declarer who did not win
 * also adds the false-declare penalty.
 */
export class Match {
  constructor({
    players, rounds = 5, penalty = 10, rng = Math.random, now = Date.now,
  }) {
    this.n = players;
    this.rounds = rounds;
    this.penalty = penalty;
    this.rng = rng;
    this.now = now;
    this.scores = Array(players).fill(0);
    this.history = []; // per round: { declarer, success, winners, totals, added }
    this.roundNo = 0;
    this.round = null;
    this.finished = false;
  }

  startRound(deck = null) {
    if (this.finished) throw new Error('The match is over');
    this.roundNo += 1;
    this.round = new Round({
      players: this.n, first: (this.roundNo - 1) % this.n, rng: this.rng, now: this.now, deck,
    });
    return this.round;
  }

  settle() {
    const r = this.round?.result;
    if (!r || this.history.length >= this.roundNo) return null;
    const added = r.totals.map((t, s) => {
      if (r.winners.includes(s)) return 0;
      return t + (s === r.declarer && !r.success ? this.penalty : 0);
    });
    added.forEach((a, s) => { this.scores[s] += a; });
    const entry = { round: this.roundNo, ...r, added };
    delete entry.hands;
    this.history.push(entry);
    if (this.roundNo >= this.rounds) this.finished = true;
    return entry;
  }

  /** Seats on the lowest total, best first. Ties share a place. */
  standings() {
    const order = this.scores.map((score, seat) => ({ seat, score })).sort((a, b) => a.score - b.score);
    let place = 0;
    return order.map((x, i) => {
      if (i === 0 || x.score !== order[i - 1].score) place = i + 1;
      return { ...x, place };
    });
  }
}

export { isCard };
