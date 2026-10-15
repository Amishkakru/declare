// Panels that sit on the cloth: the lobby, the round result and the final standings.

import {
  store, me, seatName, isHost, act,
} from './state.js';
import {
  $, esc, renderIfChanged, copyText, toast,
} from './util.js';

export const inviteLink = () => `${location.origin}/?room=${store.snap?.room ?? ''}`;

const ROUNDS = [3, 5, 8, 10];
const PENALTIES = [0, 10, 20];

export function mountPanels() {
  const root = $('#panel');
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const d = b.dataset;
    if (d.set) {
      const value = d.set === 'timers' ? d.value === 'on' : Number(d.value);
      act({ t: 'settings', [d.set]: value });
    } else if (d.do === 'bot') act({ t: 'addBot', seat: Number(d.seat) });
    else if (d.do === 'free') act({ t: 'removeSeat', seat: Number(d.seat) });
    else if (d.do === 'start') act({ t: 'start', fillBots: true });
    else if (d.do === 'next') act({ t: 'next' });
    else if (d.do === 'rematch') act({ t: 'rematch' });
    else if (d.do === 'copy') {
      copyText(inviteLink(), $('#inviteField')).then((done) => toast(done ? 'Invite link copied.' : 'Copy the link from the box.'));
    }
  });
}

function segmented(key, options, current, label, format = String) {
  const host = isHost();
  return `<div class="setting"><span>${label}</span><div class="seg" role="group" aria-label="${label}">
    ${options.map((o) => `<button type="button" data-set="${key}" data-value="${o}" class="${String(o) === String(current) ? 'is-on' : ''}" ${host ? '' : 'disabled'}>${format(o)}</button>`).join('')}
  </div></div>`;
}

function lobbyHtml(snap) {
  const host = isHost();
  const S = snap.settings;
  const seats = snap.seats.map((s, i) => {
    let right = '';
    if (host && s.kind === 'empty') right = `<button type="button" class="btn small" data-do="bot" data-seat="${i}">Add a bot</button>`;
    else if (host && i !== me()) right = `<button type="button" class="btn small quiet" data-do="free" data-seat="${i}">Remove</button>`;
    const label = s.kind === 'empty' ? '<em>Open seat</em>' : `<b>${esc(s.name)}</b>${i === me() ? ' (you)' : ''}${s.kind === 'bot' ? ' <small>Bot</small>' : ''}${i === snap.host ? ' <small>Host</small>' : ''}`;
    return `<li class="${s.kind === 'empty' ? 'is-open' : ''}"><span class="n num">${i + 1}</span><span class="nm">${label}</span>${right}</li>`;
  }).join('');
  const empty = snap.seats.filter((s) => s.kind === 'empty').length;
  const lan = store.info?.lan?.length ? `<p class="hint">Same Wi-Fi: ${store.info.lan.map((ip) => `<b>${esc(ip)}:${store.info.port}</b>`).join(' or ')}</p>` : '';
  return `<div class="lobby">
    <header>
      <h2>Table <span class="code num">${esc(snap.room)}</span></h2>
      <div class="invite"><input id="inviteField" readonly value="${esc(inviteLink())}" aria-label="Invite link"><button type="button" class="btn small" data-do="copy">Copy link</button></div>
      ${lan}
    </header>
    <ol class="roster">${seats}</ol>
    <div class="settings">
      ${segmented('players', [3, 4], S.players, 'Players')}
      ${segmented('rounds', ROUNDS, S.rounds, 'Rounds')}
      ${segmented('penalty', PENALTIES, S.penalty, 'False declare', (p) => (p ? `+${p}` : 'None'))}
      ${segmented('timers', ['on', 'off'], S.timers ? 'on' : 'off', 'Turn clock', (v) => (v === 'on' ? '30 s' : 'Off'))}
    </div>
    <footer>${host
    ? `<button type="button" class="btn primary big" data-do="start">${empty ? `Start with ${empty} bot${empty > 1 ? 's' : ''}` : 'Start match'}</button>`
    : `<p class="hint">Waiting for <b>${esc(seatName(snap.host))}</b> to start.</p>`}</footer>
  </div>`;
}

const list = (seats) => {
  const names = seats.map((s) => `<b>${esc(seatName(s))}</b>`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
};
const signed = (v) => (v < 0 ? `−${-v}` : String(v));

function headline(R) {
  const d = R.declarer;
  if (d === null) return `The round reached its turn limit. ${list(R.winners)} ${R.winners.length > 1 ? 'share' : 'takes'} it on ${signed(R.totals[R.winners[0]])}.`;
  if (R.success) return `${list([d])} declared on ${signed(R.totals[d])} and wins the round.`;
  const w = R.winners;
  const lower = R.totals[w[0]] < R.totals[d];
  return `${list([d])} declared on ${signed(R.totals[d])}, but ${list(w)} ${lower ? 'had' : 'matched it with'} ${signed(R.totals[w[0]])}. ${list(w)} ${w.length > 1 ? 'win' : 'wins'} the round.`;
}

/** The round result, shown under the cloth so every revealed hand stays in view. */
export function resultHtml(snap, G) {
  const R = G.result;
  const h = snap.history.at(-1);
  const cols = snap.seats.map((s, i) => `<th class="${R.winners.includes(i) ? 'is-winner' : ''}">${esc(s.name)}${i === R.declarer ? '<sup title="Declared">D</sup>' : ''}</th>`).join('');
  const row = (label, f) => `<tr><th>${label}</th>${snap.seats.map((_, i) => `<td class="num ${R.winners.includes(i) ? 'is-winner' : ''}">${f(i)}</td>`).join('')}</tr>`;
  const last = snap.roundNo >= snap.rounds;
  const penalty = R.declarer !== null && !R.success && snap.settings.penalty ? ` A false declare adds ${snap.settings.penalty} to the declarer’s hand.` : '';
  return `<div class="result">
    <div class="result-text"><p class="headline">${headline(R)}</p><p class="hint">Round ${snap.roundNo} of ${snap.rounds}.${penalty}</p></div>
    <table><thead><tr><th></th>${cols}</tr></thead><tbody>
      ${row('Hand', (i) => signed(R.totals[i]))}
      ${row('Added', (i) => (h.added[i] ? `+${h.added[i]}` : '0'))}
      ${row('Total', (i) => snap.scores[i])}
    </tbody></table>
    <div class="result-go">${isHost()
    ? `<button type="button" class="btn primary big" data-do="next">${last ? 'Final standings' : `Deal round ${snap.roundNo + 1}`}</button>`
    : `<p class="hint">Waiting for <b>${esc(seatName(snap.host))}</b>.</p>`}</div>
  </div>`;
}

function overHtml(snap) {
  const st = snap.standings;
  const top = st.filter((x) => x.place === 1).map((x) => x.seat);
  const rows = st.map((x) => `<li class="${x.place === 1 ? 'is-winner' : ''}"><span class="place num">${x.place}</span><b>${esc(seatName(x.seat))}</b><span class="num">${x.score}</span></li>`).join('');
  return `<div class="over">
    <h2>${list(top)} ${top.length > 1 ? 'share the match' : 'wins the match'}</h2>
    <p class="hint">Lowest total after ${snap.rounds} rounds.</p>
    <ol class="standings">${rows}</ol>
    <footer>${isHost() ? '<button type="button" class="btn primary big" data-do="rematch">New match at this table</button>' : `<p class="hint">Waiting for <b>${esc(seatName(snap.host))}</b>.</p>`}</footer>
  </div>`;
}

export function renderPanels() {
  const snap = store.snap;
  const root = $('#panel');
  let html = '';
  let kind = '';
  if (snap.stage === 'lobby') { kind = 'lobby'; html = lobbyHtml(snap); } else if (snap.stage === 'over') { kind = 'over'; html = overHtml(snap); }
  root.hidden = !html;
  root.dataset.kind = kind;
  $('#cloth').classList.toggle('has-panel', Boolean(html));
  renderIfChanged(root, html, (n) => { n.innerHTML = html; });
}
