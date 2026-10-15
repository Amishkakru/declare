// The cloth: every player's hidden cards, the deck, the discard pile and whatever is being held.
// Positions of cards never move on screen, because remembering where a card is is the whole game.

import {
  store, game, me, rel, players, seatName, seatInfo, serverNow,
} from './state.js';
import { $, esc, renderIfChanged, initial } from './util.js';
import {
  cardHtml, faceHtml, backHtml, valueOf, powerText, cardName,
} from './cards.js';
import { slotAction } from './tray.js';

const FLASH_MS = 1600;

export function mountTable(onSlot) {
  $('#cloth').addEventListener('click', (e) => {
    const b = e.target.closest('button.slot');
    if (!b || b.disabled) return;
    onSlot(Number(b.dataset.owner), Number(b.dataset.pos));
  });
}

/** Where a seat sits on the cloth, by player count and relative position. */
function placeOf(seat) {
  const r = rel(seat);
  if (r === 0) return 'me';
  if (players() === 3) return r === 1 ? 'left' : 'right';
  return ['me', 'left', 'top', 'right'][r];
}

/** Cards everyone or only you can see right now, keyed "owner:pos". */
function faceUpNow(G) {
  const up = new Map();
  const now = serverNow();
  const reveal = store.snap.timing?.reveal ?? 3000;
  for (const r of G.reveals) {
    const left = r.at + reveal - now;
    if (left > 0) up.set(`${r.owner}:${r.pos}`, { card: r.card, at: r.at, ms: reveal, mine: true });
  }
  // A wrong match puts the card back face up for the whole table for a moment.
  for (const e of G.log) {
    if (e.type === 'match' && !e.ok && now - e.at < reveal && G.slots[e.seat]?.[e.pos]) {
      up.set(`${e.seat}:${e.pos}`, { card: e.card, at: e.at, ms: reveal, mine: false });
    }
  }
  // The king's pair stays in view while its player decides.
  const P = G.power;
  if (P?.kind === 'king' && P.pick?.cards && G.turn === me()) {
    up.set(`${me()}:${P.pick.pos}`, { card: P.pick.cards[0], hold: true });
    up.set(`${P.pick.owner}:${P.pick.opos}`, { card: P.pick.cards[1], hold: true });
  }
  return up;
}

/** Short labels on cards that something just happened to, so you can follow other players' moves. */
function flashesNow(G) {
  const map = new Map();
  const now = serverNow();
  const who = (s) => (s === me() ? 'You' : seatName(s));
  let at = 0;
  const put = (owner, pos, text, kind) => map.set(`${owner}:${pos}`, { text, kind, at });
  for (const e of G.log) {
    if (now - e.at > FLASH_MS) continue;
    ({ at } = e);
    switch (e.type) {
      case 'swap': put(e.seat, e.pos, 'New card', 'swap'); break;
      case 'peek': put(e.owner, e.pos, `${who(e.seat)} looked`, 'peek'); break;
      case 'kingPeek':
        put(e.seat, e.pos, `${who(e.seat)} looked`, 'peek');
        put(e.owner, e.opos, `${who(e.seat)} looked`, 'peek');
        break;
      case 'trade':
        put(e.seat, e.pos, 'Swapped', 'trade');
        put(e.owner, e.opos, 'Swapped', 'trade');
        break;
      case 'match': if (!e.ok) put(e.seat, e.pos, 'Wrong match', 'wrong'); break;
      case 'penalty': put(e.seat, e.pos, 'Penalty card', 'wrong'); break;
      default:
    }
  }
  return map;
}

function slotHtml(owner, pos, present, ctx) {
  const key = `${owner}:${pos}`;
  if (!present) return '<span class="slot is-gap" aria-hidden="true"></span>';
  const up = ctx.result ? { card: ctx.result.hands[owner][pos], final: true } : ctx.up.get(key);
  const flash = ctx.flash.get(key);
  const action = ctx.result ? null : slotAction(owner, pos);
  const picked = (owner === me() && store.ui.own === pos)
    || (store.ui.other && store.ui.other.owner === owner && store.ui.other.pos === pos);
  const cls = [
    'slot',
    up ? 'is-up' : '',
    action ? `can-${action}` : '',
    picked ? 'is-picked' : '',
    flash ? `flash-${flash.kind}` : '',
    up?.mine ? 'is-look' : '',
  ].filter(Boolean).join(' ');
  const label = up
    ? `${cardName(up.card)}, ${valueOf(up.card)} points`
    : `${owner === me() ? 'Your' : `${seatName(owner)}’s`} card ${pos + 1}, face down`;
  const now = serverNow();
  // Animations are anchored to when the thing happened, so a redraw never replays them.
  const timer = up?.ms ? `<i class="burn" style="animation-duration:${up.ms}ms;animation-delay:${up.at - now}ms"></i>` : '';
  const flip = up?.at ? ` style="animation-delay:${up.at - now}ms"` : '';
  const inner = `<span class="card ${up ? 'is-up' : 'is-down'}"${flip}>${up ? faceHtml(up.card) : backHtml()}</span>${timer}${flash ? `<em class="flash" style="animation-delay:${flash.at - now}ms">${esc(flash.text)}</em>` : ''}`;
  if (action) {
    return `<button type="button" class="${cls}" data-owner="${owner}" data-pos="${pos}" aria-label="${label}${actionHint(action)}">${inner}</button>`;
  }
  return `<span class="${cls}" role="img" aria-label="${label}">${inner}</span>`;
}

const actionHint = (a) => ({
  swap: ': put your drawn card here', look: ': look at this card', pick: ': pick this card', match: ': throw this card as a match',
}[a] ?? '');

function plateHtml(seat, G, snap) {
  const info = seatInfo(seat);
  const turn = G && !G.result && G.turn === seat && G.phase !== 'match';
  const dl = G?.deadline?.seat === seat ? G.deadline : null;
  const count = G ? G.slots[seat].filter(Boolean).length : 0;
  const total = G?.result ? G.result.totals[seat] : null;
  const won = G?.result?.winners.includes(seat);
  const declared = G?.result && G.result.declarer === seat;
  const status = [];
  if (info.kind === 'bot') status.push('Bot');
  else if (!info.connected) status.push('Away');
  else if (info.auto) status.push('Autopilot');
  const meta = G?.result
    ? `<span class="total num">${total < 0 ? '−' : ''}${Math.abs(total)}</span><small>${won ? 'Wins' : ''}${declared ? `${won ? ', ' : ''}declared` : ''}</small>`
    : `<small>${count} card${count === 1 ? '' : 's'}${snap.scores ? ` · ${snap.scores[seat]} pts` : ''}</small>`;
  return `<div class="plate ${turn ? 'is-turn' : ''} ${won ? 'is-winner' : ''} ${declared ? 'is-declarer' : ''}">
    <span class="token">${esc(initial(info.name || '?'))}</span>
    <span class="who"><b>${esc(seat === me() ? `${info.name} (you)` : info.name)}</b>${meta}</span>
    ${status.length ? `<span class="tag">${status.join(' ')}</span>` : ''}
    ${dl ? `<i class="clock" style="animation-duration:${dl.ms}ms;animation-delay:${dl.at - dl.ms - serverNow()}ms"></i>` : ''}
  </div>`;
}

function seatHtml(seat, G, snap, ctx) {
  const slots = G.slots[seat];
  const cols = Math.max(2, Math.ceil(slots.length / 2));
  const grid = slots.map((present, pos) => slotHtml(seat, pos, present, ctx)).join('');
  const holding = G.holding && G.turn === seat && seat !== me() && !G.result;
  return `<section class="seat at-${placeOf(seat)} ${seat === me() ? 'is-me' : ''}" aria-label="${esc(seatName(seat))}">
    ${plateHtml(seat, G, snap)}
    <div class="grid" style="--cols:${cols}">${grid}</div>
    ${holding ? `<div class="held-mini" title="${esc(seatName(seat))} is holding a drawn card">${cardHtml(null)}</div>` : ''}
  </section>`;
}

function centerHtml(G) {
  const top = G.top;
  const win = G.window && G.phase === 'match' ? G.window : null;
  const mineHeld = G.drawn && G.turn === me();
  const pileCls = win ? 'is-open' : '';
  const winBar = win ? `<i class="window" style="animation-duration:${win.ms}ms;animation-delay:${win.at - win.ms - serverNow()}ms"></i>` : '';
  return `<div class="center">
    <div class="pile deck" aria-label="Deck, ${G.deck} cards">
      <span class="stack">${cardHtml(null)}${G.deck > 1 ? cardHtml(null, { cls: 'under' }) : ''}</span>
      <small><b class="num">${G.deck}</b> in the deck</small>
    </div>
    <div class="pile discard ${pileCls}" aria-label="${top ? `Discard pile, ${cardName(top)} on top` : 'Discard pile, empty'}">
      <span class="stack">${top ? cardHtml(top, { cls: 'top' }) : '<span class="card is-empty"></span>'}${winBar}</span>
      <small>${win ? '<b>Match it</b>' : `<b class="num">${G.pile}</b> discarded`}</small>
    </div>
    ${mineHeld ? `<div class="pile held" aria-label="Your drawn card">
      <span class="stack">${cardHtml(G.drawn, { cls: 'drawn' })}</span>
      <small>Your draw${powerText(G.drawn) ? `: <b>${esc(powerText(G.drawn))}</b>` : ''}</small>
    </div>` : ''}
  </div>`;
}

export function renderTable() {
  const snap = store.snap;
  const G = game();
  const cloth = $('#cloth');
  cloth.dataset.players = String(players());
  if (!G || snap.stage === 'lobby') {
    renderIfChanged($('#seats'), 'none', (n) => { n.innerHTML = ''; });
    return;
  }
  const ctx = {
    up: faceUpNow(G), flash: G.result ? new Map() : flashesNow(G), result: G.result && snap.stage !== 'round' ? G.result : null,
  };
  const order = Array.from({ length: players() }, (_, i) => i);
  const sig = {
    G: { ...G, log: G.log.at(-1)?.id },
    up: [...ctx.up.keys()],
    fl: [...ctx.flash.entries()],
    ui: [store.ui.own, store.ui.other],
    seats: snap.seats,
    scores: snap.scores,
    stage: snap.stage,
  };
  renderIfChanged($('#seats'), sig, (n) => {
    n.innerHTML = order.map((s) => seatHtml(s, G, snap, ctx)).join('') + (ctx.result ? '' : centerHtml(G));
  });
}
