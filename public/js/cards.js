// Card rendering. Values and powers come from the shared engine module, so the client can never
// disagree with the server about what a card is worth or what it does.

import {
  rankOf, suitOf, valueOf, powerOf, isJoker, isRedCard, SUIT_NAME, SUIT_SYMBOL, POWER_NAME,
} from '/engine/cards.js';

export {
  rankOf, suitOf, valueOf, powerOf, isJoker, POWER_NAME,
};

const RANK_NAME = {
  A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack',
};

export const cardName = (card) => (isJoker(card)
  ? 'Joker'
  : `${RANK_NAME[rankOf(card)] ?? rankOf(card)} of ${SUIT_NAME[suitOf(card)].toLowerCase()}`);

export const suitSvg = (suit, cls = '') => `<svg class="suit ${cls}" viewBox="0 0 100 100" aria-hidden="true"><use href="#s-${suit}"/></svg>`;

const signed = (v) => (v < 0 ? `−${-v}` : String(v));

/** A small inline chip for prose, e.g. in the log. */
export function mini(card) {
  if (isJoker(card)) return '<span class="mini is-joker">Joker</span>';
  return `<span class="mini ${isRedCard(card) ? 'is-red' : ''}">${rankOf(card)}${suitSvg(suitOf(card))}</span>`;
}

/** Face-up card markup. */
export function faceHtml(card) {
  const pts = valueOf(card);
  const badge = `<span class="card-pts ${pts <= 0 ? 'is-low' : ''}">${signed(pts)}</span>`;
  if (isJoker(card)) {
    return `<span class="face is-joker" aria-label="Joker, minus 1 point">
      <span class="card-index"><b>★</b></span>
      <span class="card-joker"><i>Joker</i><svg viewBox="0 0 100 100" aria-hidden="true"><use href="#s-star"/></svg></span>
      ${badge}</span>`;
  }
  const rank = rankOf(card);
  const suit = suitOf(card);
  const court = rank === 'J' || rank === 'Q' || rank === 'K';
  return `<span class="face ${isRedCard(card) ? 'is-red' : ''}" aria-label="${cardName(card)}, ${pts} points">
    <span class="card-index"><b>${rank}</b>${suitSvg(suit)}</span>
    <span class="card-index card-index-end"><b>${rank}</b>${suitSvg(suit)}</span>
    ${court
    ? `<span class="card-court"><i>${rank}</i>${suitSvg(suit)}</span>`
    : `<span class="card-pip ${rank === 'A' ? 'is-ace' : ''}">${suitSvg(suit)}</span>`}
    ${badge}</span>`;
}

/** The printed back every hidden card shows. */
export const backHtml = () => '<span class="back" aria-hidden="true"></span>';

/** A complete card: `card` null means face down. */
export function cardHtml(card, { cls = '', label = '' } = {}) {
  return `<span class="card ${card ? 'is-up' : 'is-down'} ${cls}"${label ? ` aria-label="${label}"` : ''}>${card ? faceHtml(card) : backHtml()}</span>`;
}

/** One-line description of what a power card lets you do. */
export const powerText = (card) => {
  const p = powerOf(card);
  return p ? POWER_NAME[p] : null;
};
