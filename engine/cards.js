// Card model for Declare: a full 52-card deck plus two jokers.
// A card is a string: rank + suit letter ("7H", "10S", "KC"), or "X1" / "X2" for the jokers.
// This file is shared with the browser, so the client and server always agree on values and powers.

export const SUITS = ['S', 'H', 'C', 'D'];
export const SUIT_NAME = { S: 'Spades', H: 'Hearts', C: 'Clubs', D: 'Diamonds' };
export const SUIT_SYMBOL = { S: '♠', H: '♥', C: '♣', D: '♦' };
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const JOKERS = ['X1', 'X2'];

export const isJoker = (card) => typeof card === 'string' && card[0] === 'X';
export const rankOf = (card) => (isJoker(card) ? 'X' : card.slice(0, -1));
export const suitOf = (card) => (isJoker(card) ? null : card.slice(-1));
export const isRedCard = (card) => suitOf(card) === 'H' || suitOf(card) === 'D';

/** Points a card counts for at the reveal: A 1, 2-10 face value, J and Q 10, red K 10, black K 0, joker -1. */
export function valueOf(card) {
  if (isJoker(card)) return -1;
  const rank = rankOf(card);
  if (rank === 'A') return 1;
  if (rank === 'J' || rank === 'Q') return 10;
  if (rank === 'K') return isRedCard(card) ? 10 : 0;
  return Number(rank);
}

/**
 * The power a card gives when it is drawn from the deck and put straight onto the discard pile.
 *   7, 8   look at one of your own cards
 *   9, 10  look at one card of another player
 *   J      blind swap: one of your cards for one of another player's
 *   Q      look at one of your cards, then you may make a blind swap
 *   K      look at one of yours and one of another player's, then you may swap those two
 */
export function powerOf(card) {
  switch (rankOf(card)) {
    case '7': case '8': return 'peekOwn';
    case '9': case '10': return 'peekOther';
    case 'J': return 'blindSwap';
    case 'Q': return 'queen';
    case 'K': return 'king';
    default: return null;
  }
}

export const POWER_NAME = {
  peekOwn: 'Look at your card',
  peekOther: 'Look at an opponent’s card',
  blindSwap: 'Blind swap',
  queen: 'Look, then blind swap',
  king: 'Look at both, then swap',
};

export const makeDeck = () => [...SUITS.flatMap((s) => RANKS.map((r) => r + s)), ...JOKERS];
const DECK_SET = new Set(makeDeck());
export const isCard = (c) => typeof c === 'string' && DECK_SET.has(c);

/** Average value of a card you know nothing about. Bots use it to estimate hidden totals. */
export const MEAN_VALUE = makeDeck().reduce((sum, c) => sum + valueOf(c), 0) / DECK_SET.size;

export function shuffle(items, rng = Math.random) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Small seeded generator so tests and simulations are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
