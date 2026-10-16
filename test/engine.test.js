import test from 'node:test';
import assert from 'node:assert/strict';
import {
  valueOf, powerOf, makeDeck, MEAN_VALUE,
} from '../engine/cards.js';
import { Round, Match } from '../engine/round.js';
import { decide } from '../engine/bots.js';
import { playRound } from '../scripts/simulate.js';

/**
 * Build a deck that deals `hands` (one array of 4 per seat) and then draws `draws` in order.
 * Every other card sits underneath, in a fixed order.
 */
function stacked(hands, draws = []) {
  const order = [];
  for (let k = 0; k < 4; k++) hands.forEach((h) => order.push(h[k]));
  order.push(...draws);
  const used = new Set(order);
  assert.equal(used.size, order.length, 'a card is used twice in the test deck');
  const rest = makeDeck().filter((c) => !used.has(c));
  return [...rest, ...order.reverse()];
}

const H = [
  ['AS', '2S', '3S', '4S'],
  ['AH', '2H', '3H', '4H'],
  ['AC', '2C', '3C', '4C'],
];
const make = (draws, hands = H) => new Round({ players: hands.length, deck: stacked(hands, draws), now: () => 1000 });

test('card values and powers follow the table rules', () => {
  assert.equal(valueOf('AS'), 1);
  assert.equal(valueOf('7H'), 7);
  assert.equal(valueOf('10D'), 10);
  assert.equal(valueOf('JC'), 10);
  assert.equal(valueOf('QH'), 10);
  assert.equal(valueOf('KH'), 10);
  assert.equal(valueOf('KD'), 10);
  assert.equal(valueOf('KS'), 0);
  assert.equal(valueOf('KC'), 0);
  assert.equal(valueOf('X1'), -1);
  assert.equal(valueOf('X2'), -1);
  assert.equal(makeDeck().length, 54);
  assert.equal(powerOf('7S'), 'peekOwn');
  assert.equal(powerOf('8D'), 'peekOwn');
  assert.equal(powerOf('9H'), 'peekOther');
  assert.equal(powerOf('10C'), 'peekOther');
  assert.equal(powerOf('JD'), 'blindSwap');
  assert.equal(powerOf('QS'), 'queen');
  assert.equal(powerOf('KS'), 'king');
  assert.equal(powerOf('6H'), null);
  assert.equal(powerOf('X1'), null);
  assert.ok(MEAN_VALUE > 5 && MEAN_VALUE < 7);
});

test('deal gives four hidden cards each and the views never show them', () => {
  const r = new Round({ players: 4 });
  assert.equal(r.deck.length, 54 - 16);
  r.hands.forEach((h) => assert.equal(h.length, 4));
  for (let s = 0; s < 4; s++) {
    const json = JSON.stringify(r.view(s));
    r.hands.flat().forEach((c) => assert.ok(!json.includes(`"${c}"`), `view leaks ${c}`));
  }
});

test('draw then swap: the old card goes face up, power does not fire, the matching window opens', () => {
  const r = make(['7D']);
  assert.ok(r.draw(0).ok);
  assert.equal(r.view(0).drawn, '7D');
  assert.equal(r.view(1).drawn, null);
  assert.equal(r.view(1).holding, true);
  assert.ok(r.swapIn(0, 2).ok);
  assert.equal(r.hands[0][2], '7D');
  assert.equal(r.top(), '3S');
  assert.equal(r.phase, 'match');
  assert.equal(r.power, null);
  assert.ok(r.closeMatch().ok);
  assert.equal(r.turn, 1);
  assert.equal(r.phase, 'turn');
});

test('discarding a plain card ends the turn; discarding a 7 lets you look at one of yours', () => {
  const r = make(['6D', '7D']);
  r.draw(0);
  r.discardDrawn(0);
  assert.equal(r.phase, 'match');
  r.closeMatch();
  r.draw(1);
  r.discardDrawn(1);
  assert.equal(r.phase, 'power');
  assert.equal(r.power.kind, 'peekOwn');
  assert.equal(r.usePower(1, { t: 'peek', owner: 0, pos: 0 }).ok, true, 'owner is ignored for own peeks');
  const v = r.view(1);
  assert.equal(v.reveals.length, 1);
  assert.deepEqual([v.reveals[0].owner, v.reveals[0].pos, v.reveals[0].card], [1, 0, 'AH']);
  assert.equal(r.view(0).reveals.length, 0, 'nobody else sees the look');
});

test('9 and 10 look at another player, never at your own card', () => {
  const r = make(['9D']);
  r.draw(0);
  r.discardDrawn(0);
  assert.equal(r.usePower(0, { t: 'peek', owner: 0, pos: 1 }).ok, false);
  assert.ok(r.usePower(0, { t: 'peek', owner: 2, pos: 3 }).ok);
  assert.equal(r.view(0).reveals[0].card, '4C');
});

test('jack is a blind swap between your card and another player’s', () => {
  const r = make(['JD']);
  r.draw(0);
  r.discardDrawn(0);
  assert.ok(r.usePower(0, {
    t: 'swap', pos: 0, owner: 1, opos: 3,
  }).ok);
  assert.equal(r.hands[0][0], '4H');
  assert.equal(r.hands[1][3], 'AS');
  assert.equal(r.view(0).reveals.length, 0, 'a blind swap shows nothing');
});

test('queen: look at one of yours, then swap or skip', () => {
  const r = make(['QD', 'QH']);
  r.draw(0);
  r.discardDrawn(0);
  assert.ok(r.usePower(0, { t: 'peek', pos: 2 }).ok);
  assert.equal(r.power.step, 2);
  assert.equal(r.view(0).reveals[0].card, '3S');
  assert.ok(r.usePower(0, {
    t: 'swap', pos: 2, owner: 2, opos: 0,
  }).ok);
  assert.equal(r.hands[0][2], 'AC');
  assert.equal(r.hands[2][0], '3S');
  r.closeMatch();
  r.draw(1);
  r.discardDrawn(1);
  r.usePower(1, { t: 'peek', pos: 0 });
  assert.ok(r.usePower(1, { t: 'skip' }).ok);
  assert.equal(r.phase, 'match');
  assert.equal(r.hands[1][0], 'AH');
});

test('king: look at both cards, then swap that pair or keep them', () => {
  const r = make(['KD', 'KS']);
  r.draw(0);
  r.discardDrawn(0);
  assert.ok(r.usePower(0, {
    t: 'peek', pos: 3, owner: 1, opos: 0,
  }).ok);
  assert.deepEqual(r.view(0).power.pick.cards, ['4S', 'AH']);
  assert.equal(r.view(1).power.pick.cards, undefined, 'only the king player sees the pair');
  assert.equal(r.view(0).reveals.length, 2);
  assert.ok(r.usePower(0, { t: 'swap' }).ok);
  assert.equal(r.hands[0][3], 'AH');
  assert.equal(r.hands[1][0], '4S');
  r.closeMatch();
  r.draw(1);
  r.discardDrawn(1);
  r.usePower(1, {
    t: 'peek', pos: 1, owner: 2, opos: 1,
  });
  assert.ok(r.usePower(1, { t: 'skip' }).ok);
  assert.equal(r.hands[1][1], '2H');
});

test('a power can be skipped outright', () => {
  const r = make(['8D']);
  r.draw(0);
  r.discardDrawn(0);
  assert.ok(r.usePower(0, { t: 'skip' }).ok);
  assert.equal(r.phase, 'match');
  assert.equal(r.view(0).reveals.length, 0);
});

test('matching: same rank leaves the card on the pile, ends the window, and only one match is allowed', () => {
  const r = make(['AD']); // seat 0 swaps AD in for 2S, so a 2 is on top
  r.draw(0);
  r.swapIn(0, 1);
  assert.equal(r.top(), '2S');
  assert.ok(r.matchCard(2, 1).ok); // 2C
  assert.equal(r.hands[2][1], null);
  assert.equal(r.top(), '2C');
  assert.equal(r.phase, 'turn');
  assert.equal(r.turn, 1);
  assert.equal(r.matchCard(1, 1).ok, false, 'the window closed after the first match');
  assert.deepEqual(r.view(2).slots[2], [true, false, true, true]);
});

test('matching: a wrong rank costs one penalty card, the window stays open, one try each', () => {
  const r = make(['5D', '9C']); // 9C is the penalty card
  r.draw(0);
  r.discardDrawn(0);
  const before = r.deck.length;
  assert.ok(r.matchCard(1, 0).ok); // AH on a 5: wrong
  assert.equal(r.hands[1].length, 5);
  assert.equal(r.hands[1][4], '9C');
  assert.equal(r.hands[1][0], 'AH', 'the wrong card goes back to its place');
  assert.equal(r.deck.length, before - 1);
  assert.equal(r.phase, 'match');
  assert.equal(r.matchCard(1, 1).ok, false, 'no second try');
  assert.ok(r.knows[2].has('AH'), 'everyone saw the wrong card');
  assert.ok(!r.knows[1].has('9C'), 'the penalty card is face down, even to its owner');
});

test('a penalty card fills an earlier gap before adding a new slot', () => {
  const r = make(['AD', '3D', '9C']);
  r.draw(0);
  r.discardDrawn(0); // AD on top
  r.matchCard(1, 0); // AH matches, slot 0 empties, turn passes to seat 1
  r.draw(1);
  r.discardDrawn(1); // 3D on top
  r.matchCard(1, 1); // 2H on a 3: wrong, penalty goes into slot 0
  assert.equal(r.hands[1][0], '9C');
  assert.equal(r.hands[1].length, 4);
});

test('declare is only allowed at the start of your own turn', () => {
  const r = make(['5D']);
  assert.equal(r.declare(1).ok, false);
  r.draw(0);
  assert.equal(r.declare(0).ok, false);
});

test('declare: strictly lowest wins', () => {
  const r = make([], [['AS', '2S', 'X1', 'KS'], ['10H', '2H', '3H', '4H'], ['9C', '2C', '3C', '4C']]);
  r.declare(0);
  assert.equal(r.phase, 'done');
  assert.deepEqual(r.result.totals, [2, 19, 18]);
  assert.equal(r.result.success, true);
  assert.deepEqual(r.result.winners, [0]);
});

test('declare: a tie loses for the declarer, and every tied non-declarer wins', () => {
  const r = make([], [['AS', '2S', '3S', '4S'], ['AH', '2H', '3H', '4H'], ['AC', '2C', '3C', '4C']]);
  r.declare(0);
  assert.equal(r.result.success, false);
  assert.deepEqual(r.result.winners, [1, 2]);
});

test('declare: someone strictly lower than the declarer wins alone', () => {
  const r = make([], [['AS', '2S', '3S', '4S'], ['AH', 'KC', 'X1', 'X2'], ['5C', '6C', '3C', '4C']]);
  r.declare(0);
  assert.equal(r.result.success, false);
  assert.deepEqual(r.result.winners, [1]);
  assert.equal(r.result.totals[1], -1);
});

test('an empty deck turns the discard pile over, keeping its top card, and forgets those cards', () => {
  const r = new Round({ players: 3, deck: stacked(H), now: () => 0 });
  r.deck = ['6D']; // last card
  r.discard = ['7D', '8D', '9D'];
  r.knows.forEach((k) => ['7D', '8D'].forEach((c) => k.add(c)));
  r.draw(0);
  r.discardDrawn(0); // 6D on top
  r.closeMatch();
  r.draw(1);
  assert.equal(r.discard.length, 1);
  assert.equal(r.discard[0], '6D');
  assert.equal(r.deck.length + 1, 3);
  assert.ok(!r.knows[2].has('7D'));
  assert.ok(r.events.some((e) => e.type === 'reshuffle'));
});

test('bots remember what they looked at and can track it through public swaps', () => {
  const r = make(['8D', 'JD']);
  r.draw(0);
  r.discardDrawn(0);
  r.usePower(0, { t: 'peek', pos: 3 }); // seat 0 now knows its 4S
  r.closeMatch();
  r.draw(1);
  r.discardDrawn(1);
  r.usePower(1, {
    t: 'swap', pos: 0, owner: 0, opos: 3,
  }); // 4S moves to seat 1, slot 0
  const v = r.botView(0);
  assert.equal(v.known[1][0], '4S');
  assert.equal(v.known[0][3], null, 'seat 0 never saw the AH that arrived');
});

test('bots match known cards and never match blind', () => {
  const r = make(['3D']);
  r.draw(0);
  r.discardDrawn(0); // a 3 on top
  r.knows[2].add('3C');
  assert.deepEqual(decide(r.botView(2)), { type: 'match', pos: 2 });
  assert.equal(decide(r.botView(1)), null);
});

test('match scoring: winners add nothing, a failed declarer pays the penalty, lowest total wins', () => {
  const m = new Match({ players: 3, rounds: 2, penalty: 10 });
  m.startRound(stacked([['AS', '2S', '3S', '4S'], ['AH', '2H', '3H', '4H'], ['5C', '6C', '7C', '8C']]));
  m.round.declare(0); // 10 vs 10: declarer ties and loses
  const e = m.settle();
  assert.deepEqual(e.winners, [1]);
  assert.deepEqual(e.added, [20, 0, 26]);
  assert.deepEqual(m.scores, [20, 0, 26]);
  assert.equal(m.settle(), null, 'settling twice does nothing');
  m.startRound(stacked([['AH', '2H', '3H', '4H'], ['5C', '6C', '7C', '8C'], ['AS', '2S', 'X1', 'KS']]));
  assert.equal(m.round.turn, 1, 'first turn rotates');
  m.round.draw(1);
  m.round.discardDrawn(1);
  m.round.closeMatch();
  m.round.declare(2);
  m.settle();
  assert.deepEqual(m.scores, [30, 26, 26]);
  assert.equal(m.finished, true);
  assert.deepEqual(m.standings().map((s) => [s.seat, s.place]), [[1, 1], [2, 1], [0, 3]], 'ties share a place');
});

test('fuzz: 600 bot rounds always finish, stay legal and never leak a hidden card', () => {
  for (let seed = 1; seed <= 600; seed++) {
    const players = seed % 2 ? 4 : 3;
    const r = playRound({
      players,
      seed,
      first: seed % players,
      onStep(round) {
        if (seed % 7) return; // inspect every view on a sample of rounds
        for (let s = 0; s < players; s++) {
          const v = round.view(s);
          const allowed = new Set([
            v.top, v.drawn, v.power?.card, v.match?.top,
            ...(v.power?.pick?.cards ?? []), ...v.reveals.map((x) => x.card),
          ]);
          const json = JSON.stringify(v);
          for (const c of round.hands.flat()) {
            if (c && !allowed.has(c)) assert.ok(!json.includes(`"${c}"`), `seat ${s} sees ${c} (seed ${seed})`);
          }
        }
      },
    });
    const cards = [...r.deck, ...r.discard, ...r.hands.flat().filter(Boolean)];
    assert.equal(cards.length, 54, `cards lost or created (seed ${seed})`);
    assert.equal(new Set(cards).size, 54);
    assert.ok(r.result.winners.length >= 1);
    r.result.winners.forEach((w) => assert.ok(Number.isInteger(w) && w >= 0 && w < players));
  }
});

test('opening look: each player sees only their own bottom two cards, then play starts', () => {
  const r = new Round({
    players: 3, deck: stacked(H), now: () => 1000, preview: 5000,
  });
  assert.equal(r.phase, 'preview');
  assert.equal(r.draw(0).ok, false, 'nobody acts during the look');
  const v = r.view(1);
  assert.deepEqual(v.reveals.map((x) => [x.owner, x.pos, x.card, x.ms]), [[1, 1, '2H', 5000], [1, 3, '4H', 5000]]);
  assert.ok(r.knows[1].has('2H') && !r.knows[1].has('AH'));
  assert.ok(!r.knows[0].has('2H'), 'other players do not see them');
  assert.ok(r.startPlay().ok);
  assert.equal(r.phase, 'turn');
  assert.equal(r.startPlay().ok, false);
});

test('king: after looking, any two cards of two different players can be swapped', () => {
  const r = make(['KD', 'KH']);
  r.draw(0);
  r.discardDrawn(0);
  r.usePower(0, {
    t: 'peek', pos: 0, owner: 1, opos: 0,
  });
  assert.equal(r.usePower(0, {
    t: 'swap', owner: 1, pos: 1, owner2: 1, pos2: 2,
  }).ok, false, 'two cards of the same player is refused');
  assert.ok(r.usePower(0, {
    t: 'swap', owner: 1, pos: 2, owner2: 2, pos2: 3,
  }).ok, 'two opponents may be swapped with each other');
  assert.equal(r.hands[1][2], '4C');
  assert.equal(r.hands[2][3], '3H');
  assert.equal(r.hands[0][0], 'AS', 'the looked cards stay put');
  r.closeMatch();
  r.draw(1);
  r.discardDrawn(1);
  r.usePower(1, {
    t: 'peek', pos: 1, owner: 2, opos: 1,
  });
  assert.ok(r.usePower(1, { t: 'swap' }).ok, 'no choice swaps the looked pair');
  assert.equal(r.hands[1][1], '2C');
});

test('matching another player’s card: it goes to the pile, then the matcher gives them a card', () => {
  const r = make(['AD']);
  r.draw(0);
  r.swapIn(0, 1); // a 2 on top
  assert.ok(r.matchCard(1, 1, 2).ok); // seat 1 throws seat 2's 2C
  assert.equal(r.top(), '2C');
  assert.equal(r.phase, 'give');
  assert.equal(r.currentActor(), 1);
  assert.equal(r.matchCard(0, 1).ok, false, 'the window closed');
  assert.equal(r.giveCard(0, 0).ok, false, 'only the matcher gives');
  assert.ok(r.giveCard(1, 3).ok);
  assert.equal(r.hands[2][1], '4H', 'the gift fills the gap');
  assert.equal(r.hands[1][3], null);
  assert.equal(r.phase, 'turn');
  assert.equal(r.turn, 1);
});

test('a wrong throw of another player’s card costs the thrower a penalty card', () => {
  const r = make(['5D', '9C']);
  r.draw(0);
  r.discardDrawn(0);
  assert.ok(r.matchCard(1, 0, 2).ok); // AC on a 5
  assert.equal(r.hands[2][0], 'AC', 'the card goes back');
  assert.equal(r.hands[1].length, 5);
  assert.equal(r.hands[1][4], '9C');
  assert.equal(r.phase, 'match');
});
