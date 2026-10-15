// Small DOM helpers shared by every view module.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const touchOnly = () => matchMedia('(hover: none)').matches;

/** Skip a re-render when the inputs are unchanged. Keeps focus, hover and animations intact. */
const signatures = new WeakMap();
export function renderIfChanged(node, signature, render) {
  const sig = typeof signature === 'string' ? signature : JSON.stringify(signature);
  if (signatures.get(node) === sig) return false;
  signatures.set(node, sig);
  render(node);
  return true;
}

let toastTimer;
export function toast(message, { kind = 'info', ms = 3200 } = {}) {
  const root = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast is-${kind}`;
  t.textContent = message;
  root.replaceChildren(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

export const initial = (name) => (String(name).trim()[0] ?? '?').toUpperCase();

export function copyText(text, fallbackInput) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false);
  if (fallbackInput) {
    fallbackInput.select();
    try { return Promise.resolve(document.execCommand('copy')); } catch { /* fall through */ }
  }
  return Promise.resolve(false);
}
