import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createDeclareServer } from '../server/index.js';

const TIMEOUT = 15_000;

async function boot() {
  const app = createDeclareServer({ port: 0, host: '127.0.0.1', fast: true });
  const port = await app.listen();
  return { app, url: `ws://127.0.0.1:${port}` };
}

/**
 * A protocol client. With `play: true` it plays its own seat simply: draw, discard, skip any power,
 * and declare once the round is a few turns old.
 */
function client(url, { play = false, declareAfter = 8 } = {}) {
  const ws = new WebSocket(url);
  const c = {
    ws,
    state: null,
    joined: null,
    errors: [],
    states: [],
    waiters: [],
    send: (m) => ws.send(JSON.stringify(m)),
    open: new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    close: () => ws.close(),
    until(pred, label = 'condition') {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), TIMEOUT);
        const check = () => {
          if (c.state && pred(c.state)) {
            clearTimeout(t);
            c.waiters = c.waiters.filter((w) => w !== check);
            resolve(c.state);
          }
        };
        c.waiters.push(check);
        check();
      });
    },
  };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'joined') c.joined = m;
    if (m.t === 'error') c.errors.push(m);
    if (m.t === 'state') {
      c.state = m.s;
      c.version = m.v;
      c.states.push(m.s);
      if (play) c.think();
      [...c.waiters].forEach((w) => w());
    }
  });
  c.think = () => {
    const g = c.state.game;
    if (!g || c.state.stage !== 'round' || g.turn !== c.state.you) return;
    const key = `${g.turns}:${g.phase}:${g.power?.step ?? ''}`;
    if (key === c.lastSent) return;
    c.lastSent = key;
    if (g.phase === 'turn') c.send(g.turns >= declareAfter ? { t: 'declare' } : { t: 'draw' });
    else if (g.phase === 'decide') c.send({ t: 'discard' });
    else if (g.phase === 'power') c.send({ t: 'power', a: 'skip' });
  };
  return c;
}

async function seated(url, name, opts) {
  const c = client(url, opts);
  await c.open;
  return c;
}

test('a host with bots plays a whole match to the final standings', async () => {
  const { app, url } = await boot();
  try {
    const host = await seated(url, 'Asha', { play: true });
    host.send({ t: 'create', name: 'Asha' });
    await host.until((s) => s.stage === 'lobby', 'lobby');
    host.send({ t: 'settings', rounds: 3, penalty: 20 });
    await host.until((s) => s.settings.rounds === 3 && s.settings.penalty === 20, 'settings');
    host.send({ t: 'start', fillBots: true });
    for (let r = 1; r <= 3; r++) {
      await host.until((s) => s.stage === 'between' && s.roundNo === r, `round ${r} to end`);
      const s = host.state;
      assert.equal(s.history.length, r);
      assert.equal(s.game.result.hands.length, 4, 'every hand is face up at the end');
      host.send({ t: 'next' });
    }
    const over = await host.until((s) => s.stage === 'over', 'match over');
    assert.equal(over.standings.length, 4);
    assert.equal(over.scores.reduce((a, b) => a + b, 0), over.history.reduce((a, h) => a + h.added.reduce((x, y) => x + y, 0), 0));
    assert.deepEqual(host.errors, []);
    host.send({ t: 'rematch' });
    await host.until((s) => s.stage === 'lobby' && !s.game, 'back to the lobby');
  } finally {
    await app.close();
  }
});

test('three-player tables, seat limits and refusing to drop a chair someone is sitting in', async () => {
  const { app, url } = await boot();
  try {
    const a = await seated(url, 'A');
    a.send({ t: 'create', name: 'A' });
    await a.until((s) => s.stage === 'lobby');
    const code = a.state.room;
    const b = await seated(url, 'B');
    const c = await seated(url, 'C');
    const d = await seated(url, 'D');
    b.send({ t: 'join', room: code, name: 'B' });
    c.send({ t: 'join', room: code, name: 'C' });
    d.send({ t: 'join', room: code, name: 'D' });
    await a.until((s) => s.seats.filter((x) => x.kind === 'human').length === 4, 'four people');
    const e = await seated(url, 'E');
    e.send({ t: 'join', room: code, name: 'E' });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(e.errors.at(-1)?.code, 'full');

    a.send({ t: 'settings', players: 3 });
    await new Promise((r) => setTimeout(r, 80));
    assert.match(a.errors.at(-1)?.msg ?? '', /Seat 4 has a player/);
    a.send({ t: 'removeSeat', seat: 3 });
    await a.until((s) => s.seats[3].kind === 'empty');
    a.send({ t: 'settings', players: 3 });
    await a.until((s) => s.seats.length === 3 && s.settings.players === 3, 'three seats');
    a.send({ t: 'start' });
    const s = await a.until((x) => x.stage === 'round', 'round');
    assert.equal(s.game.players, 3);
    assert.equal(s.game.slots.length, 3);
    [a, b, c, d, e].forEach((x) => x.close());
  } finally {
    await app.close();
  }
});

test('a private look reaches only the player who looked, and fades out of later snapshots', async () => {
  const { app, url } = await boot();
  try {
    const a = await seated(url, 'A');
    a.send({ t: 'create', name: 'A' });
    await a.until((s) => s.stage === 'lobby');
    const b = await seated(url, 'B');
    b.send({ t: 'join', room: a.state.room, name: 'B' });
    await a.until((s) => s.seats[1].kind === 'human');
    a.send({ t: 'settings', players: 3, timers: false });
    a.send({ t: 'start', fillBots: true });
    await a.until((s) => s.stage === 'round' && s.game.turn === 0 && s.game.phase === 'turn', 'first turn');

    // Put a 7 on top of the deck so seat 0 draws it.
    const round = app.rooms.get(a.state.room).match.round;
    const i = round.deck.findIndex((c) => c.startsWith('7'));
    const seven = round.deck[i];
    [round.deck[i], round.deck[round.deck.length - 1]] = [round.deck.at(-1), round.deck[i]];
    a.send({ t: 'draw' });
    await a.until((s) => s.game.phase === 'decide' && s.game.drawn === seven, 'holding the 7');
    assert.equal(b.state.game.drawn, null, 'the other player does not see the drawn card');
    a.send({ t: 'discard' });
    await a.until((s) => s.game.phase === 'power');
    a.send({ t: 'power', a: 'peek', pos: 2 });
    const seen = await a.until((s) => s.game.reveals.length === 1, 'the look');
    assert.equal(seen.game.reveals[0].card, round.hands[0][2]);
    assert.equal(b.state.game.reveals.length, 0);
    const card = round.hands[0][2];
    assert.ok(!JSON.stringify(b.states.at(-1)).includes(`"${card}"`) || b.state.game.top === card);

    // After the reveal time, snapshots carry no trace of the card.
    await new Promise((r) => setTimeout(r, 260));
    a.send({ t: 'resume' }); // any message gives a fresh snapshot
    await a.until((s) => s.game.reveals.length === 0, 'the look to fade');
    a.close();
    b.close();
  } finally {
    await app.close();
  }
});

test('matching over the wire: anyone can throw, a wrong card costs a penalty card', async () => {
  const { app, url } = await boot();
  try {
    const a = await seated(url, 'A');
    a.send({ t: 'create', name: 'A' });
    await a.until((s) => s.stage === 'lobby');
    const b = await seated(url, 'B');
    b.send({ t: 'join', room: a.state.room, name: 'B' });
    await a.until((s) => s.seats[1].kind === 'human');
    a.send({ t: 'settings', players: 3, timers: false });
    a.send({ t: 'start', fillBots: true });
    await a.until((s) => s.stage === 'round' && s.game.phase === 'turn' && s.game.turn === 0);
    const room = app.rooms.get(a.state.room);
    room.timing = { ...room.timing, match: 4000 }; // a long window so the test can act inside it
    const round = room.match.round;
    room.seats[2] = { kind: 'bot', name: 'Quiet' };
    const rank = (c) => (c[0] === 'X' ? 'X' : c.slice(0, -1));
    a.send({ t: 'draw' });
    await a.until((s) => s.game.phase === 'decide');
    a.send({ t: 'swap', pos: 0 });
    await b.until((s) => s.game.phase === 'match', 'the window');
    const thrown = round.hands[1][0];
    const wrong = rank(thrown) !== rank(round.top());
    b.send({ t: 'match', pos: 0 });
    if (wrong) {
      const s = await b.until((x) => x.game.slots[1].length === 5, 'the penalty card');
      assert.equal(s.game.phase, 'match', 'the window stays open after a wrong throw');
      assert.ok(s.game.log.some((e) => e.type === 'penalty' && e.seat === 1));
      b.send({ t: 'match', pos: 1 });
      await new Promise((r) => setTimeout(r, 60));
      assert.match(b.errors.at(-1)?.msg ?? '', /already tried/);
    } else {
      await b.until((x) => x.game.slots[1][0] === false, 'the matched card leaving');
    }
    a.close();
    b.close();
  } finally {
    await app.close();
  }
});

test('a refreshed tab takes its seat back with the token, mid-round', async () => {
  const { app, url } = await boot();
  try {
    const a = await seated(url, 'A');
    a.send({ t: 'create', name: 'A' });
    await a.until((s) => s.stage === 'lobby');
    a.send({ t: 'settings', timers: false });
    a.send({ t: 'start', fillBots: true });
    await a.until((s) => s.stage === 'round');
    const { room, token } = a.joined;
    a.close();
    await new Promise((r) => setTimeout(r, 50));
    const again = await seated(url, 'A');
    again.send({ t: 'join', room, token });
    const s = await again.until((x) => x.stage === 'round', 'back in');
    assert.equal(s.you, 0);
    assert.equal(again.joined.seat, 0);
    again.close();
  } finally {
    await app.close();
  }
});

test('a player who keeps timing out goes on autopilot, and autopilot never declares for them', async () => {
  const { app, url } = await boot();
  try {
    const a = await seated(url, 'A');
    a.send({ t: 'create', name: 'A' });
    await a.until((s) => s.stage === 'lobby');
    a.send({ t: 'settings', players: 3, rounds: 3 });
    a.send({ t: 'start', fillBots: true });
    await a.until((s) => s.game?.log.some((e) => e.type === 'autopilot' && e.seat === 0), 'autopilot');
    await a.until((s) => s.stage === 'between', 'the round to end');
    assert.notEqual(a.state.game.result.declarer, 0);
    a.close();
  } finally {
    await app.close();
  }
});

test('bad actions are refused with a message and never crash the table', async () => {
  const { app, url } = await boot();
  try {
    const a = await seated(url, 'A');
    a.send({ t: 'create', name: 'A' });
    await a.until((s) => s.stage === 'lobby');
    a.send({ t: 'draw' });
    a.send({ t: 'settings', players: 9, rounds: 77, penalty: -5 });
    a.send({ t: 'start', fillBots: true, players: 2 });
    await a.until((s) => s.stage === 'round');
    a.send({ t: 'swap', pos: 'x' });
    a.send({ t: 'power', a: 'nuke', pos: 99, owner: -1 });
    a.send({ t: 'match', pos: 42 });
    a.send({ t: 'declare', seat: 2 });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(a.errors.length >= 4);
    assert.deepEqual(a.state.settings, {
      players: 4, rounds: 5, penalty: 10, timers: true,
    });
    a.close();
  } finally {
    await app.close();
  }
});
