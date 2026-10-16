// Bot-only rounds, to check the rules always finish and the numbers look sane.
// `npm run simulate -- 2000 4` plays 2000 rounds with 4 players.

import { Round } from '../engine/round.js';
import { decide, applyAction } from '../engine/bots.js';
import { mulberry32 } from '../engine/cards.js';

/** Play one round to the end with bots in every seat. Returns the finished round. */
export function playRound({
  players, seed, first = 0, onStep = () => {},
}) {
  const rng = mulberry32(seed);
  const round = new Round({
    players, first, rng, preview: 1,
  });
  round.startPlay();
  let guard = 0;
  while (round.phase !== 'done') {
    onStep(round);
    if (++guard > 20_000) throw new Error(`round did not finish (seed ${seed})`);
    if (round.phase === 'match') {
      // Everyone gets one look at the pile, in a random order, as if racing to throw.
      const order = Array.from({ length: players }, (_, s) => s).sort(() => rng() - 0.5);
      for (const s of order) {
        if (round.phase !== 'match') break;
        const a = decide(round.botView(s));
        if (a) {
          const res = applyAction(round, s, a);
          if (!res.ok) throw new Error(`bot match failed: ${res.error} (seed ${seed})`);
        }
      }
      if (round.phase === 'match') round.closeMatch();
      continue;
    }
    const seat = round.currentActor();
    const a = decide(round.botView(seat));
    const res = applyAction(round, seat, a);
    if (!res.ok) throw new Error(`bot move failed in ${round.phase}: ${res.error} ${JSON.stringify(a)} (seed ${seed})`);
  }
  return round;
}

if (process.argv[1]?.endsWith('simulate.js')) {
  const n = Number(process.argv[2] ?? 1000);
  const players = Number(process.argv[3] ?? 4);
  let turns = 0; let declaredOk = 0; let stalled = 0; let matches = 0; let wrong = 0; let winTotal = 0;
  for (let i = 0; i < n; i++) {
    const r = playRound({ players, seed: i + 1, first: i % players });
    turns += r.turns;
    if (r.result.declarer === null) stalled++;
    else if (r.result.success) declaredOk++;
    matches += r.events.filter((e) => e.type === 'match' && e.ok).length;
    wrong += r.events.filter((e) => e.type === 'match' && !e.ok).length;
    winTotal += Math.min(...r.result.totals);
  }
  console.log(`${n} rounds, ${players} players`);
  console.log(`  average turns per round   ${(turns / n).toFixed(1)}`);
  console.log(`  declares that won         ${((declaredOk / n) * 100).toFixed(1)}%`);
  console.log(`  rounds stopped by cap     ${stalled}`);
  console.log(`  matches per round         ${(matches / n).toFixed(2)} (wrong ${wrong})`);
  console.log(`  average winning total     ${(winTotal / n).toFixed(2)}`);
}
