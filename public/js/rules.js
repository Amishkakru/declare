// The rules sheet, opened from the bar.

import { $ } from './util.js';

const RULES = `
<header><h2>How to play Declare</h2><button type="button" class="btn quiet" data-close>Close</button></header>
<div class="rules-body">
  <section>
    <h3>The aim</h3>
    <p>Hold the lowest total. You never see your own cards unless a power lets you look, so you play from memory.</p>
    <p>Three or four players, a full deck with two jokers. Everyone is dealt four cards face down, in two rows. Before play starts, each player sees their own bottom two cards for a few seconds.</p>
  </section>
  <section>
    <h3>Card values</h3>
    <table class="values">
      <tr><th>Joker</th><td>−1</td></tr>
      <tr><th>Black king</th><td>0</td></tr>
      <tr><th>Ace</th><td>1</td></tr>
      <tr><th>2 to 10</th><td>Face value</td></tr>
      <tr><th>Jack, queen, red king</th><td>10</td></tr>
    </table>
  </section>
  <section>
    <h3>Your turn</h3>
    <p>Draw the top card of the deck. You see it; nobody else does. Then either:</p>
    <ul>
      <li><b>Swap it</b> for one of your cards. The card you give up goes face up on the discard pile. Its power does not apply.</li>
      <li><b>Discard it</b>. If it is a power card, you may use the power.</li>
    </ul>
    <p>The discard pile cannot be drawn from.</p>
  </section>
  <section>
    <h3>Powers</h3>
    <table class="values">
      <tr><th>7, 8</th><td>Look at one of your cards</td></tr>
      <tr><th>9, 10</th><td>Look at one card of another player</td></tr>
      <tr><th>Jack</th><td>Blind swap one of your cards with another player’s</td></tr>
      <tr><th>Queen</th><td>Look at one of your cards, then you may make a blind swap</td></tr>
      <tr><th>King</th><td>Look at one of yours and one of another player’s, then you may swap any two cards held by two different players</td></tr>
    </table>
    <p>Every power is optional. A look shows the card for three seconds only.</p>
  </section>
  <section>
    <h3>Matching</h3>
    <p>Each time a card lands on the pile, a short window opens. Anyone may throw a card of the same rank onto it: one of their own, which leaves them a card lighter, or another player’s. Match another player’s card and you then give that player one of your cards in its place. Only the first match counts.</p>
    <p>Throw a card of the wrong rank and it goes back where it was, face up for a moment for everyone, and the thrower takes one penalty card from the deck. One try per player per card.</p>
  </section>
  <section>
    <h3>Declaring</h3>
    <p>At the start of your turn, instead of drawing, you may declare. Every card is turned over at once.</p>
    <p>You win the round only if your total is strictly the lowest. If anyone ties or beats you, you lose, and every other player on the lowest total wins.</p>
  </section>
  <section>
    <h3>Scoring a match</h3>
    <p>Round winners add nothing. Everyone else adds their hand total. A declarer who loses also adds the false-declare penalty set for the table. After the last round, the lowest total wins.</p>
  </section>
</div>`;

export function mountRules() {
  const dlg = $('#rules');
  dlg.innerHTML = RULES;
  $('#btnRules').addEventListener('click', () => dlg.showModal());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
  });
}
