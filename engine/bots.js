// Bot decisions. `decide(view)` takes a Round#botView and returns one action or null.
// Bots remember exactly what their seat has seen, so they play the same memory game as everyone else.
//
// Actions: { type: 'declare' } | { type: 'draw' } | { type: 'swapIn', pos } | { type: 'discard' }
//        | { type: 'power', t, pos?, owner?, opos? } | { type: 'match', pos }

import { valueOf, rankOf, MEAN_VALUE } from './cards.js';

const OPP_UNKNOWN = 4.5; // cards an opponent kept are usually lower than average

function slotsOf(v, seat) {
  return v.slots[seat].flatMap((present, pos) => (present ? [{ pos, card: v.known[seat][pos] }] : []));
}

function estimate(v, seat, unknownValue) {
  return slotsOf(v, seat).reduce((sum, s) => sum + (s.card ? valueOf(s.card) : unknownValue), 0);
}

const opponents = (v) => Array.from({ length: v.players }, (_, s) => s).filter((s) => s !== v.you);

/** Highest known card of mine (the best one to get rid of). */
function worstKnown(v) {
  let best = null;
  for (const s of slotsOf(v, v.you)) {
    if (s.card && (!best || valueOf(s.card) > valueOf(best.card))) best = s;
  }
  return best;
}

/** Lowest known card held by an opponent (the best one to take). */
function bestOpponentKnown(v) {
  let best = null;
  for (const owner of opponents(v)) {
    for (const s of slotsOf(v, owner)) {
      if (s.card && (!best || valueOf(s.card) < valueOf(best.card))) best = { owner, ...s };
    }
  }
  return best;
}

/** An unknown opponent card, preferring the player who looks closest to winning. */
function unknownOpponentSlot(v) {
  const order = opponents(v).sort((a, b) => estimate(v, a, OPP_UNKNOWN) - estimate(v, b, OPP_UNKNOWN));
  for (const owner of order) {
    const s = slotsOf(v, owner).find((x) => !x.card);
    if (s) return { owner, pos: s.pos };
  }
  return null;
}

function anyOpponentSlot(v) {
  for (const owner of opponents(v)) {
    const s = slotsOf(v, owner)[0];
    if (s) return { owner, pos: s.pos };
  }
  return null;
}

/** The trade a swap power should make, or null when no trade helps. */
function swapPlan(v) {
  const mine = worstKnown(v);
  if (!mine) return null;
  const mv = valueOf(mine.card);
  const theirs = bestOpponentKnown(v);
  if (theirs && mv - valueOf(theirs.card) >= 2) return { pos: mine.pos, owner: theirs.owner, opos: theirs.pos };
  if (mv >= 8) {
    const blind = unknownOpponentSlot(v);
    if (blind) return { pos: mine.pos, owner: blind.owner, opos: blind.pos };
  }
  return null;
}

function powerWorth(v, kind) {
  const unknownMine = slotsOf(v, v.you).filter((s) => !s.card).length;
  switch (kind) {
    case 'peekOwn': return unknownMine ? 1.6 : 0;
    case 'peekOther': return unknownOpponentSlot(v) ? 0.6 : 0;
    case 'blindSwap': return swapPlan(v) ? 2 : 0;
    case 'queen': return (unknownMine ? 1.6 : 0) + (swapPlan(v) ? 1 : 0);
    case 'king': return 2.2;
    default: return 0;
  }
}

function powerFor(kind) {
  switch (kind) {
    case '7': case '8': return 'peekOwn';
    case '9': case '10': return 'peekOther';
    case 'J': return 'blindSwap';
    case 'Q': return 'queen';
    case 'K': return 'king';
    default: return null;
  }
}

function onTurn(v) {
  const mine = slotsOf(v, v.you);
  const unknownMine = mine.filter((s) => !s.card).length;
  const myEst = estimate(v, v.you, MEAN_VALUE);
  const rivals = opponents(v).map((s) => estimate(v, s, OPP_UNKNOWN));
  const rival = Math.min(...rivals);
  const sure = unknownMine === 0;
  if (sure && myEst <= 7 && myEst + 1 < rival) return { type: 'declare' };
  if (!sure && unknownMine <= 1 && myEst <= 4 && myEst + 3 < rival) return { type: 'declare' };
  if (v.turns > 18 * v.players && myEst < rival) return { type: 'declare' };
  if (v.turns > 30 * v.players) return { type: 'declare' };
  return { type: 'draw' };
}

function onDecide(v) {
  const dv = valueOf(v.drawn);
  const mine = slotsOf(v, v.you);
  if (!mine.length) return { type: 'discard' };
  const hi = worstKnown(v);
  const unknown = mine.filter((s) => !s.card);
  const options = [{ gain: powerWorth(v, powerFor(rankOf(v.drawn))), action: { type: 'discard' } }];
  if (hi) options.push({ gain: valueOf(hi.card) - dv, action: { type: 'swapIn', pos: hi.pos } });
  if (unknown.length) options.push({ gain: MEAN_VALUE - dv + 0.4, action: { type: 'swapIn', pos: unknown[0].pos } });
  options.sort((a, b) => b.gain - a.gain);
  return options[0].gain > 0 ? options[0].action : { type: 'discard' };
}

function onPower(v) {
  const P = v.power;
  const mine = slotsOf(v, v.you);
  const unknownMine = mine.find((s) => !s.card);
  switch (P.kind) {
    case 'peekOwn':
      return unknownMine ? { type: 'power', t: 'peek', pos: unknownMine.pos } : { type: 'power', t: 'skip' };
    case 'peekOther': {
      const s = unknownOpponentSlot(v);
      return s ? { type: 'power', t: 'peek', owner: s.owner, pos: s.pos } : { type: 'power', t: 'skip' };
    }
    case 'blindSwap': {
      const plan = swapPlan(v);
      return plan ? { type: 'power', t: 'swap', ...plan } : { type: 'power', t: 'skip' };
    }
    case 'queen': {
      if (P.step === 1) {
        const pick = unknownMine ?? worstKnown(v) ?? mine[0];
        return { type: 'power', t: 'peek', pos: pick.pos };
      }
      const plan = swapPlan(v);
      return plan ? { type: 'power', t: 'swap', ...plan } : { type: 'power', t: 'skip' };
    }
    case 'king': {
      if (P.step === 1) {
        const hi = worstKnown(v);
        const own = hi && valueOf(hi.card) >= 7 ? hi : (unknownMine ?? hi ?? mine[0]);
        const theirs = bestOpponentKnown(v);
        const target = theirs && valueOf(theirs.card) <= 3 ? theirs : (unknownOpponentSlot(v) ?? anyOpponentSlot(v));
        return {
          type: 'power', t: 'peek', pos: own.pos, owner: target.owner, opos: target.pos,
        };
      }
      const [a, b] = P.pick.cards ?? [];
      return a && b && valueOf(a) > valueOf(b) ? { type: 'power', t: 'swap' } : { type: 'power', t: 'skip' };
    }
    default:
      return { type: 'power', t: 'skip' };
  }
}

function onMatch(v) {
  if (!v.match || v.match.tried.includes(v.you)) return null;
  const rank = rankOf(v.match.top);
  const hit = slotsOf(v, v.you).find((s) => s.card && rankOf(s.card) === rank && valueOf(s.card) > 0);
  return hit ? { type: 'match', pos: hit.pos } : null;
}

export function decide(v) {
  if (v.phase === 'match') return onMatch(v);
  if (v.turn !== v.you) return null;
  if (v.phase === 'turn') return onTurn(v);
  if (v.phase === 'decide') return onDecide(v);
  if (v.phase === 'power') return onPower(v);
  return null;
}

/** Map a bot action onto the round. Shared by the server and the simulations. */
export function applyAction(round, seat, a) {
  switch (a?.type) {
    case 'declare': return round.declare(seat);
    case 'draw': return round.draw(seat);
    case 'swapIn': return round.swapIn(seat, a.pos);
    case 'discard': return round.discardDrawn(seat);
    case 'power': return round.usePower(seat, a);
    case 'match': return round.matchCard(seat, a.pos);
    default: return { ok: false, error: 'Unknown action.' };
  }
}
