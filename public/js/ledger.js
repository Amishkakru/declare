// Right-hand ledger: running scores by round, and a plain account of every public move.

import {
  store, game, me, seatName,
} from './state.js';
import { $, esc, renderIfChanged } from './util.js';
import { mini } from './cards.js';

export function mountLedger() {
  $('#ledger').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.tab) { store.ui.tab = t.dataset.tab; renderLedger(); }
    if (t.dataset.act === 'close') {
      store.ui.ledgerOpen = false;
      $('#app').classList.remove('ledger-open');
    }
  });
}

const who = (s) => `<b>${esc(s === me() ? 'You' : seatName(s))}</b>`;
const whose = (seat, owner) => {
  if (owner === seat) return seat === me() ? 'your' : 'their';
  return owner === me() ? 'your' : `${esc(seatName(owner))}’s`;
};
const signed = (v) => (v < 0 ? `−${-v}` : String(v));

function describe(e) {
  switch (e.type) {
    case 'deal': return { html: `Cards dealt. ${who(e.first)} ${e.first === me() ? 'play' : 'plays'} first`, cls: 'note' };
    case 'draw': return { html: `${who(e.seat)} drew a card`, cls: 'quiet' };
    case 'swap': return { html: `${who(e.seat)} kept the draw in card ${e.pos + 1} and discarded ${mini(e.card)}` };
    case 'discard': return { html: `${who(e.seat)} discarded ${mini(e.card)}${e.power ? ' and took its power' : ''}` };
    case 'peek': return { html: `${who(e.seat)} looked at ${whose(e.seat, e.owner)} card ${e.pos + 1}` };
    case 'kingPeek': return { html: `${who(e.seat)} looked at ${whose(e.seat, e.seat)} card ${e.pos + 1} and ${whose(e.seat, e.owner)} card ${e.opos + 1}` };
    case 'trade': return {
      html: `${who(e.seat)} swapped ${whose(e.seat, e.from ?? e.seat)} card ${e.pos + 1} with ${whose(e.seat, e.owner)} card ${e.opos + 1}${e.power === 'king' ? '' : ', unseen'}`,
      cls: 'key',
    };
    case 'skip':
      if (e.step === 2) return { html: `${who(e.seat)} kept the cards where they were`, cls: 'quiet' };
      return { html: `${who(e.seat)} did not use the power`, cls: 'quiet' };
    case 'match': {
      const from = `${whose(e.seat, e.owner ?? e.seat)} card ${e.pos + 1}`;
      return e.ok
        ? { html: `${who(e.seat)} matched ${mini(e.top)} with ${mini(e.card)} from ${from}`, cls: 'key' }
        : { html: `${who(e.seat)} threw ${mini(e.card)} from ${from} on ${mini(e.top)}: wrong rank, one penalty card`, cls: 'warn' };
    }
    case 'give': return { html: `${who(e.seat)} gave card ${e.pos + 1} to ${who(e.owner)}`, cls: 'key' };
    case 'preview': return { html: 'Everyone looked at their own bottom two cards', cls: 'note' };
    case 'start': return { html: `Play starts with ${who(e.seat)}`, cls: 'note' };
    case 'reshuffle': return { html: 'The deck ran out. The discard pile, less its top card, became the new deck', cls: 'note' };
    case 'declare': return { html: `${who(e.seat)} declared`, cls: 'key' };
    case 'stalled': return { html: 'The round reached its turn limit and was revealed', cls: 'note' };
    case 'end': {
      const w = e.winners.map((s) => esc(seatName(s))).join(' and ');
      return { html: `<b>${w}</b> ${e.winners.length > 1 ? 'win' : 'wins'} on ${signed(e.totals[e.winners[0]])}`, cls: 'key' };
    }
    case 'timeout': return { html: `${who(e.seat)} ran out of time and was played for`, cls: 'note' };
    case 'autopilot': return { html: `${who(e.seat)} ${e.seat === me() ? 'are' : 'is'} on autopilot`, cls: 'note' };
    case 'away': return { html: `${who(e.seat)} disconnected`, cls: 'note' };
    case 'back': return { html: `${who(e.seat)} reconnected`, cls: 'note' };
    default: return null;
  }
}

function scoresHtml(snap) {
  if (!snap.history?.length && !snap.scores) return '<p class="empty">Scores appear after the first round.</p>';
  const seats = snap.seats.map((s, i) => `<th class="${i === me() ? 'is-me' : ''}">${esc(s.name)}</th>`).join('');
  const rows = (snap.history ?? []).map((h) => `<tr><th>Round ${h.round}</th>${h.added.map((a, i) => `<td class="num ${h.winners.includes(i) ? 'is-win' : ''}">${a}${i === h.declarer ? '<sup title="Declared">D</sup>' : ''}</td>`).join('')}</tr>`).join('');
  const lead = Math.min(...snap.scores);
  const totals = snap.scores.map((s) => `<td class="num ${s === lead ? 'is-lead' : ''}">${s}</td>`).join('');
  return `<table class="scores"><thead><tr><th></th>${seats}</tr></thead>
    <tbody>${rows || `<tr><th>Round 1</th><td colspan="${snap.seats.length}" class="pending">In play</td></tr>`}</tbody>
    <tfoot><tr><th>Total</th>${totals}</tr></tfoot></table>
    <p class="note">Lowest total wins after ${snap.rounds} rounds. Round winners add nothing; everyone else adds their hand.</p>`;
}

function logHtml(G) {
  if (!G) return '<p class="empty">Moves appear here once the round starts.</p>';
  const items = G.log.map((e) => ({ e, d: describe(e) })).filter((x) => x.d).reverse();
  return `<ol class="log">${items.map(({ d }) => `<li class="${d.cls ?? ''}">${d.html}</li>`).join('')}</ol>`;
}

export function renderLedger() {
  const snap = store.snap;
  const G = game();
  const tab = store.ui.tab;
  const sig = {
    tab, h: snap.history?.length, sc: snap.scores, log: G?.log.at(-1)?.id, r: snap.roundNo, seats: snap.seats.map((s) => s.name),
  };
  renderIfChanged($('#ledger'), sig, (n) => {
    n.innerHTML = `<div class="ledger-head">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" data-tab="scores" aria-selected="${tab === 'scores'}">Scores</button>
        <button type="button" role="tab" data-tab="log" aria-selected="${tab === 'log'}">Moves</button>
      </div>
      <button type="button" class="btn quiet small only-narrow" data-act="close">Close</button>
    </div>
    <div class="ledger-body">${tab === 'scores' ? scoresHtml(snap) : logHtml(G)}</div>`;
  });
}
