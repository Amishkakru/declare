// The strip under the cloth: what you can do right now, and the buttons to do it.
// It also decides what tapping a card means at this moment (swap here, look, pick, throw a match).

import {
  store, game, me, seatName, act, serverNow,
} from './state.js';
import { $, esc, renderIfChanged } from './util.js';
import { mini, valueOf, powerText } from './cards.js';
import { resultHtml } from './panels.js';

const ARM_MS = 4000;

function pickKey(G) {
  return `${store.snap.roundNo}:${G.turns}:${G.phase}:${G.power?.step ?? ''}`;
}

/** Clear picks that belonged to an earlier step. */
export function syncPicks() {
  const G = game();
  const key = G ? pickKey(G) : '';
  if (key !== store.ui.pickKey) {
    store.ui.pickKey = key;
    store.ui.own = null;
    store.ui.other = null;
  }
}

/** What a tap on this card does right now, or null. */
export function slotAction(owner, pos) {
  const G = game();
  if (!G || store.snap.stage !== 'round' || !G.slots[owner]?.[pos]) return null;
  const mine = owner === me();
  if (G.phase === 'match') return mine && !G.match.tried.includes(me()) ? 'match' : null;
  if (G.turn !== me()) return null;
  if (G.phase === 'decide') return mine ? 'swap' : null;
  if (G.phase !== 'power') return null;
  const P = G.power;
  switch (P.kind) {
    case 'peekOwn': return mine ? 'look' : null;
    case 'peekOther': return mine ? null : 'look';
    case 'blindSwap': return 'pick';
    case 'queen': return P.step === 1 ? (mine ? 'look' : null) : 'pick';
    case 'king': return P.step === 1 ? 'pick' : null;
    default: return null;
  }
}

export function onSlot(owner, pos) {
  const action = slotAction(owner, pos);
  if (!action) return;
  const ui = store.ui;
  if (action === 'match') { act({ t: 'match', pos }); return; }
  if (action === 'swap') {
    if (ui.own === pos) act({ t: 'swap', pos });
    else ui.own = pos;
  } else if (action === 'look') {
    act(owner === me() ? { t: 'power', a: 'peek', pos } : {
      t: 'power', a: 'peek', owner, pos,
    });
  } else if (owner === me()) {
    ui.own = ui.own === pos ? null : pos;
  } else {
    ui.other = ui.other?.owner === owner && ui.other.pos === pos ? null : { owner, pos };
  }
  render();
}

function onClick(e) {
  const b = e.target.closest('button[data-do]');
  if (!b || b.disabled) return;
  const ui = store.ui;
  switch (b.dataset.do) {
    case 'draw': act({ t: 'draw' }); break;
    case 'declare':
      if (serverNow() < ui.declareArmed) { ui.declareArmed = 0; act({ t: 'declare' }); } else { ui.declareArmed = serverNow() + ARM_MS; }
      break;
    case 'cancelDeclare': ui.declareArmed = 0; break;
    case 'swapIn': if (ui.own !== null) act({ t: 'swap', pos: ui.own }); break;
    case 'discard': act({ t: 'discard' }); break;
    case 'skip': act({ t: 'power', a: 'skip' }); break;
    case 'trade':
      if (ui.own !== null && ui.other) {
        act({
          t: 'power', a: 'swap', pos: ui.own, owner: ui.other.owner, opos: ui.other.pos,
        });
      }
      break;
    case 'kingLook':
      if (ui.own !== null && ui.other) {
        act({
          t: 'power', a: 'peek', pos: ui.own, owner: ui.other.owner, opos: ui.other.pos,
        });
      }
      break;
    case 'kingSwap': act({ t: 'power', a: 'swap' }); break;
    case 'resume': act({ t: 'resume' }); break;
    case 'next': act({ t: 'next' }); break;
    default:
  }
  render();
}

export function mountTray(rerender) {
  $('#tray').addEventListener('click', onClick);
  render = rerender;
}

let render = () => {};

const btn = (label, doIt, { primary = false, disabled = false, cls = '' } = {}) => `<button type="button" class="btn ${primary ? 'primary' : ''} ${cls}" data-do="${doIt}" ${disabled ? 'disabled' : ''}>${label}</button>`;

const name = (s) => `<b>${esc(seatName(s))}</b>`;
const pts = (card) => {
  const v = valueOf(card);
  return v === 1 ? '1 point' : `${v < 0 ? '−1' : v} points`;
};

function myTurn(G) {
  const ui = store.ui;
  if (G.phase === 'turn') {
    const armed = serverNow() < ui.declareArmed;
    if (armed) {
      return {
        text: 'Declare now? Every card is turned over. You win only if your total is strictly the lowest; a tie or worse loses.',
        buttons: btn('Confirm declare', 'declare', { primary: true, cls: 'declare' }) + btn('Cancel', 'cancelDeclare', { cls: 'quiet' }),
        tone: 'warn',
      };
    }
    return {
      text: 'Your turn. Draw from the deck, or declare if you believe your total is the lowest.',
      buttons: btn('Draw', 'draw', { primary: true }) + btn('Declare', 'declare', { cls: 'declare' }),
    };
  }
  if (G.phase === 'decide') {
    const power = powerText(G.drawn);
    const swap = ui.own !== null ? `Swap into card ${ui.own + 1}` : 'Swap';
    return {
      text: `You drew ${mini(G.drawn)}, ${pts(G.drawn)}. Tap one of your cards to replace it, or discard the draw.${power ? ` Discarding it gives you its power: <b>${esc(power)}</b>.` : ''}`,
      buttons: btn(swap, 'swapIn', { primary: ui.own !== null, disabled: ui.own === null }) + btn(power ? 'Discard and use power' : 'Discard', 'discard', { primary: ui.own === null }),
    };
  }
  if (G.phase === 'power') {
    const P = G.power;
    const both = ui.own !== null && ui.other;
    const skip = btn('Skip power', 'skip', { cls: 'quiet' });
    switch (P.kind) {
      case 'peekOwn':
        return { text: `${mini(P.card)} Tap one of your cards to look at it.`, buttons: skip };
      case 'peekOther':
        return { text: `${mini(P.card)} Tap another player’s card to look at it.`, buttons: skip };
      case 'blindSwap':
        return {
          text: `${mini(P.card)} Blind swap: pick one of your cards and one of another player’s. Neither is shown.`,
          buttons: btn('Swap', 'trade', { primary: true, disabled: !both }) + skip,
        };
      case 'queen':
        if (P.step === 1) return { text: `${mini(P.card)} Tap one of your cards to look at it. A blind swap follows if you want one.`, buttons: skip };
        return {
          text: `${mini(P.card)} Now pick one of your cards and one of another player’s to swap, or keep your cards as they are.`,
          buttons: btn('Swap', 'trade', { primary: true, disabled: !both }) + btn('Keep my cards', 'skip', { cls: 'quiet' }),
        };
      case 'king':
        if (P.step === 1) {
          return {
            text: `${mini(P.card)} Pick one of your cards and one of another player’s. You see both, then choose whether to swap them.`,
            buttons: btn('Look at both', 'kingLook', { primary: true, disabled: !both }) + skip,
          };
        }
        return {
          text: `Your ${mini(P.pick.cards[0])} against ${name(P.pick.owner)}’s ${mini(P.pick.cards[1])}. Swap the pair, or keep them where they are.`,
          buttons: btn('Swap them', 'kingSwap', { primary: true }) + btn('Keep', 'skip', { cls: 'quiet' }),
        };
      default:
    }
  }
  return { text: '', buttons: '' };
}

function theirTurn(G) {
  const s = G.turn;
  if (G.phase === 'turn') return { text: `${name(s)} to play.` };
  if (G.phase === 'decide') return { text: `${name(s)} drew a card and is deciding.` };
  const P = G.power;
  const label = powerText(P.card);
  if (P.kind === 'king' && P.step === 2) return { text: `${name(s)} used ${mini(P.card)} to look at two cards and is deciding whether to swap them.` };
  if (P.kind === 'queen' && P.step === 2) return { text: `${name(s)} looked at a card with ${mini(P.card)} and may now make a blind swap.` };
  return { text: `${name(s)} discarded ${mini(P.card)}: ${esc(label.toLowerCase())}.` };
}

function matchTray(G) {
  const tried = G.match.tried.includes(me());
  const count = G.slots[me()].filter(Boolean).length;
  if (tried) return { text: `You have thrown for this ${mini(G.match.top)}. Waiting for the window to close.` };
  if (!count) return { text: `Matching window for ${mini(G.match.top)}.` };
  return {
    text: `Match the ${mini(G.match.top)}: tap one of your cards of the same rank to throw it. A wrong card brings a penalty card.`,
    tone: 'match',
  };
}

export function renderTray() {
  const snap = store.snap;
  const G = game();
  const root = $('#tray');
  let model = { text: '', buttons: '' };
  if (snap.stage === 'round' && G) {
    const you = snap.seats[me()];
    if (you.auto && you.connected) {
      model = { text: 'You were put on autopilot after missing your turn twice.', buttons: btn('I’m back', 'resume', { primary: true }) };
    } else if (G.phase === 'match') model = matchTray(G);
    else if (G.turn === me()) model = myTurn(G);
    else model = theirTurn(G);
  }
  if (snap.stage === 'between' && G?.result) {
    const html = resultHtml(snap, G);
    renderIfChanged(root, html, (n) => { n.dataset.tone = 'result'; n.innerHTML = html; });
    return;
  }
  const sig = { ...model, armed: serverNow() < store.ui.declareArmed };
  renderIfChanged(root, sig, (n) => {
    n.dataset.tone = model.tone ?? '';
    n.innerHTML = model.text ? `<p class="prompt">${model.text}</p><div class="actions">${model.buttons ?? ''}</div>` : '';
  });
}
