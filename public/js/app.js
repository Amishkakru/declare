// Wires the connection to the views. Every server message is a full snapshot of what this seat may see.

import {
  store, game, me, seatName, isHost,
} from './state.js';
import { $, toast, esc } from './util.js';
import { connect, loadSession, saveSession, clearSession } from './net.js';
import { mountTable, renderTable } from './table.js';
import {
  mountTray, renderTray, onSlot, syncPicks,
} from './tray.js';
import { mountPanels, renderPanels, inviteLink } from './panels.js';
import { mountLedger, renderLedger } from './ledger.js';
import { mountEntry, showError, setBusy } from './entry.js';
import { mountRules } from './rules.js';

const app = $('#app');
let pendingName = '';
let lastLogId = -1;
let lastRound = -1;

store.session = loadSession();

const net = connect({
  onMessage,
  onStatus(status, code) {
    store.status = status;
    $('#conn').hidden = status === 'open';
    if (status === 'open') {
      // After a reconnect or a page refresh, take the same seat back.
      if (store.session) net.send({ t: 'join', room: store.session.room, token: store.session.token, name: store.session.name });
    } else if (code === 4001) {
      leaveTable('The host removed you from the table.');
    }
  },
});
store.send = net.send;

fetch('/api/info').then((r) => r.json()).then((info) => { store.info = info; if (store.snap) render(); }).catch(() => {});

function onMessage(m) {
  switch (m.t) {
    case 'joined':
      store.session = {
        room: m.room, token: m.token, seat: m.seat, name: pendingName || store.session?.name || '',
      };
      saveSession(store.session);
      history.replaceState(null, '', `/?room=${m.room}`);
      break;
    case 'state':
      store.clockOffset = m.s.now - Date.now();
      store.snap = m.s;
      setBusy(false);
      render();
      break;
    case 'error':
      if (!store.snap) {
        setBusy(false);
        if (m.code === 'noroom' || m.code === 'started' || m.code === 'full') {
          clearSession();
          store.session = null;
        }
        showError(m.msg);
      } else {
        toast(m.msg, { kind: 'warn' });
      }
      break;
    default:
  }
}

function leaveTable(message) {
  clearSession();
  store.session = null;
  store.snap = null;
  history.replaceState(null, '', '/');
  app.dataset.view = 'entry';
  showError(message);
}

function render() {
  const snap = store.snap;
  if (!snap) return;
  app.dataset.view = snap.stage === 'lobby' ? 'lobby' : 'game';
  app.dataset.stage = snap.stage;
  if (snap.roundNo !== lastRound) { lastRound = snap.roundNo ?? -1; lastLogId = -1; }
  syncPicks();

  const room = $('#barRoom');
  room.hidden = false;
  room.innerHTML = `<span>Table</span> <b>${esc(snap.room)}</b>`;
  $('#barRound').textContent = snap.roundNo && snap.stage !== 'lobby' ? `Round ${snap.roundNo} of ${snap.rounds}` : '';
  const G = game();
  const myMove = G && snap.stage === 'round' && ((G.turn === me() && G.phase !== 'match') || (G.phase === 'match' && !G.match.tried.includes(me())));
  document.title = `${myMove && G.phase !== 'match' ? 'Your turn. ' : ''}Declare ${snap.room}`;

  announce(G);
  renderTable();
  renderTray();
  renderPanels();
  renderLedger();
}

/** Notices about things that happened to you, from the move log. */
function announce(G) {
  if (!G) return;
  const fresh = G.log.filter((e) => e.id > lastLogId);
  if (lastLogId >= 0) {
    for (const e of fresh) {
      if (e.type === 'match' && e.seat === me()) {
        const others = (e.owner ?? e.seat) !== me();
        toast(e.ok ? (others ? 'Matched. Now give them one of your cards.' : 'Matched. One card fewer.') : 'Wrong rank. A penalty card was added face down.', { kind: e.ok ? 'info' : 'warn' });
      } else if (e.type === 'reshuffle') {
        toast('The deck ran out. The discard pile was shuffled into a new deck.');
      }
    }
  }
  lastLogId = G.log.at(-1)?.id ?? lastLogId;
}

// ---------------------------------------------------------------- startup

mountTable(onSlot);
mountTray(render);
mountPanels();
mountLedger();
mountRules();
mountEntry({
  onCreate(name) {
    pendingName = name;
    setBusy(true);
    net.send({ t: 'create', name });
  },
  onJoin(name, room) {
    pendingName = name;
    setBusy(true);
    net.send({ t: 'join', room, name });
  },
});

// Resuming a refreshed tab: show a quiet "rejoining" state instead of the form.
if (store.session) {
  setBusy(true);
  app.dataset.view = 'entry';
}

$('#btnLedger').addEventListener('click', () => {
  store.ui.ledgerOpen = !store.ui.ledgerOpen;
  app.classList.toggle('ledger-open', store.ui.ledgerOpen);
});

// Looks fade, flashes clear and the declare confirmation expires on their own, so redraw on a short tick.
// Every view skips work when nothing it shows has changed.
setInterval(() => { if (store.snap) render(); }, 200);

// Handy for debugging in the console and for the browser tests.
window.declare = {
  store, game, seatName, isHost, inviteLink,
};
