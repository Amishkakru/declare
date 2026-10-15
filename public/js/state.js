// Single client-side store. The server snapshot is the source of truth; `ui` holds only what belongs
// to this browser: the cards picked for a power, the declare confirmation, which panel is open.

export const store = {
  snap: null,
  session: null,
  clockOffset: 0,
  status: 'connecting',
  info: null, // { lan, port, rounds, penalties }
  send: () => {},
  ui: {
    own: null, // picked slot of mine, for a swap or a power
    other: null, // { owner, pos } picked slot of another player
    pickKey: '', // the turn and step the picks belong to; a new step clears them
    declareArmed: 0, // until when the Declare button is waiting for its second press
    ledgerOpen: false,
    tab: 'scores',
  },
};

export const act = (msg) => store.send(msg);
export const game = () => store.snap?.game ?? null;
export const me = () => store.snap?.you ?? 0;
export const players = () => store.snap?.seats.length ?? 4;
export const seatInfo = (i) => store.snap?.seats[i];
export const seatName = (i) => seatInfo(i)?.name || `Seat ${i + 1}`;
export const isHost = () => store.snap && store.snap.host === store.snap.you;
export const serverNow = () => Date.now() + store.clockOffset;

/** Seat position relative to the viewer: 0 is you, then clockwise (the next player to act is 1). */
export const rel = (seat) => (seat - me() + players()) % players();
