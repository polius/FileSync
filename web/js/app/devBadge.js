// Shared dev badge container. Multiple ?param= overrides (sink, ice, …) each
// render a small fixed-position chip in the bottom-left, stacked vertically so
// they don't fight for the same pixel.

const CONTAINER_ID = 'filesync-dev-badges';

function getContainer() {
  let el = document.getElementById(CONTAINER_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = CONTAINER_ID;
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '12px',
    left: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    zIndex: '99999',
    // The container itself is click-transparent; each badge re-enables pointer
    // events on itself. Keeps random clicks in the corner from being swallowed.
    pointerEvents: 'none',
  });
  document.body.appendChild(el);
  return el;
}

export function addDevBadge({ label, tooltip, color = 'rgba(220, 53, 69, 0.92)', onClear }) {
  const badge = document.createElement('div');
  badge.textContent = label;
  if (tooltip) badge.title = tooltip;
  Object.assign(badge.style, {
    padding: '4px 10px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '11px',
    color: '#fff',
    background: color,
    borderRadius: '12px',
    pointerEvents: 'auto',
    cursor: onClear ? 'pointer' : 'default',
    userSelect: 'none',
  });
  if (onClear) badge.addEventListener('click', onClear);
  getContainer().appendChild(badge);
  return badge;
}
