// WebSocket connection with automatic reconnect and a per-tab session.
// sessionStorage (not localStorage) so several tabs on one computer can be different players.

const KEY = 'declare.session';

export const loadSession = () => {
  try { return JSON.parse(sessionStorage.getItem(KEY)); } catch { return null; }
};
export const saveSession = (s) => {
  try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
};
export const clearSession = () => {
  try { sessionStorage.removeItem(KEY); } catch { /* storage blocked */ }
};

export function connect({ onMessage, onStatus }) {
  let ws;
  let tries = 0;
  const queue = [];

  const open = () => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${scheme}://${location.host}`);
    ws.onopen = () => {
      tries = 0;
      onStatus('open');
      while (queue.length) ws.send(JSON.stringify(queue.shift()));
    };
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch (err) { console.error('bad message', err); }
    };
    ws.onclose = (e) => {
      onStatus('closed', e.code);
      if (e.code === 4001) return; // removed from the table by the host
      setTimeout(open, Math.min(4000, 300 * 2 ** tries++));
    };
    ws.onerror = () => {};
  };
  open();

  setInterval(() => { if (ws.readyState === 1) ws.send('{"t":"ping"}'); }, 20_000);

  return {
    send(msg) {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
      else queue.push(msg);
    },
  };
}
