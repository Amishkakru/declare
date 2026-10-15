# Declare

A memory card game for 3 or 4 players. Everyone holds four cards face down and cannot see them. Draw, swap, use power cards to look and trade, throw matching cards onto the pile, and declare when you think your total is the lowest.

Play in a browser on any device. Empty seats can be filled with bots.

## Run it locally

```
npm install
npm start
```

Open http://localhost:3000, create a table and share the four-letter code. Players on the same Wi-Fi can use the LAN address printed in the terminal. Each browser tab is its own player, so you can test with several tabs.

`npm test` runs the rules, server and hosting tests. `npm run simulate -- 2000 4` plays 2000 bot rounds and prints summary numbers.

## Rules as built

**Cards.** Full deck plus two jokers (54 cards). Joker −1, black king 0, ace 1, 2 to 10 face value, jack, queen and red king 10.

**Turn.** Start of your turn: draw from the deck, or declare. The discard pile is never drawn from. With the drawn card you either:
- swap it for one of your cards (the old card goes face up on the pile; its power does not apply), or
- discard it, and if it is a power card, optionally use the power.

**Powers** (only when the drawn card is discarded directly, always optional):

| Card | Power |
|---|---|
| 7, 8 | Look at one of your cards |
| 9, 10 | Look at one card of another player |
| J | Blind swap one of your cards with another player's |
| Q | Look at one of your cards, then optionally make a blind swap |
| K | Look at one of yours and one of another player's, then optionally swap that pair |

A look shows the card for three seconds. After that it exists only in the player's memory; the server stops sending it.

**Matching.** Whenever a card lands on the pile, a short window opens (about 3 seconds). Anyone may throw one of their own cards of the same rank. The first correct match stays on the pile and closes the window; only one match per card. A wrong rank goes back to its place, face up to everyone for a moment, and the thrower takes one penalty card from the deck. One try per player per card.

**Declaring.** Instant reveal. The declarer wins only with a strictly lower total than everyone else. Otherwise the declarer loses, and every other player on the lowest total wins.

**Match scoring.** Cumulative over the chosen number of rounds; lowest total wins. Round winners add 0; everyone else adds their hand total. A losing declarer also adds the false-declare penalty.

## Decisions I made that were not in the brief

These are set in the lobby where possible, so they can be changed per table.

- **False-declare penalty:** +10 by default; the host can set None, +10 or +20.
- **Rounds:** 5 by default; 3, 5, 8 or 10.
- **Turn clock:** 30 seconds per step by default, or off. Two timeouts in a row put a player on autopilot; "I'm back" takes them off. Autopilot never declares for a person.
- **Penalty cards** fill the first empty position in your hand, otherwise a new position. Card positions never move, because remembering where a card is is the game.
- **Deck runs out:** the discard pile, less its top card, is shuffled into a new deck. Cards turned back into the deck are forgotten by everyone, bots included.
- **First player** rotates each round.
- **Safety net:** a round that reaches 150 turns is revealed with no declarer, lowest total winning. Real tables will not get near it; it exists so a table can never hang.

## Bots

Bots remember exactly what their seat has seen, track cards through public swaps, and forget cards that go back into the deck. They match only cards they know, swap high known cards for low ones, and declare when their known total is low enough against what they can estimate about the others. In simulation a round takes about 6 turns per player.

## Put it online

The server is a single Node process holding tables in memory, so run exactly one instance.

**Render** (what Kaat uses): push this folder to its own GitHub repository, then in Render choose New > Blueprint and pick the repository. `render.yaml` sets everything up. The free plan sleeps after 15 idle minutes and takes about a minute to wake.

**Anything that runs containers:** `docker build -t declare . && docker run -p 3000:3000 declare`.

The server reads `PORT`, trusts the platform proxy for client addresses, refuses WebSockets from other websites (add your own domains to `ALLOWED_ORIGINS`, comma separated, if you front it with another domain), and rate-limits table creation, wrong codes, connections and message floods. Health check: `/healthz`.

## Layout

```
engine/   rules (round.js), bots (bots.js), card values and powers (cards.js, shared with the browser)
server/   HTTP + WebSocket server (index.js), tables and timers (room.js), internet hardening (guard.js)
public/   the browser client
test/     node:test suites
scripts/  bot simulation
```
