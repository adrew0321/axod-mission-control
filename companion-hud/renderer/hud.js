let ws = null;
let state = null;
let PORT = null;
let TOKEN = null;
let reconnectTimer = null;

const $ = (id) => document.getElementById(id);
const panel = $('panel');
const orb = $('orb');

const PANEL_SIZE = [360, 580];
const ORB_SIZE = [130, 130];

function fmtTimer(sec) {
  const s = Math.max(0, sec | 0);
  const h = String((s / 3600) | 0).padStart(2, '0');
  const m = String(((s % 3600) / 60) | 0).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function renderApprovals(queue) {
  const list = $('apprList');
  $('apprCount').textContent = String(queue.length);
  if (queue.length === 0) {
    list.innerHTML = '<div class="empty">Nothing waiting.</div>';
    return;
  }
  list.innerHTML = '';
  for (const g of queue) {
    const item = document.createElement('div');
    item.className = 'appr-item';
    const host = g.host ? ` · ${g.host}` : '';
    item.innerHTML =
      `<div class="rsn">${escapeHtml(g.reason)}</div>` +
      `<div class="tgt">“<b>${escapeHtml(g.target || 'action')}</b>”${escapeHtml(host)}</div>` +
      `<div class="ts">requested ${fmtTime(g.requestedAt)} · waiting</div>` +
      `<div class="btns"><button class="deny">DENY</button><button class="ok">APPROVE</button></div>`;
    item.querySelector('.deny').onclick = () => send({ type: 'deny', id: g.id });
    item.querySelector('.ok').onclick = () => send({ type: 'approve', id: g.id });
    list.appendChild(item);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderIngest(ing) {
  const busy = !!ing && (ing.phase === 'bundling' || ing.phase === 'uploading');
  const btn = $('ingestBtn');
  if (btn) btn.classList.toggle('busy', busy); // dim + block while a send is running
  const el = $('ingestStatus');
  if (!el) return;
  el.classList.remove('err', 'ok');
  if (!ing || ing.phase === 'idle') { el.textContent = ''; return; }
  if (ing.phase === 'bundling') { el.textContent = 'Bundling repo…'; return; }
  if (ing.phase === 'uploading') { el.textContent = 'Uploading to AKIRA…'; return; }
  if (ing.phase === 'done') { el.classList.add('ok'); el.textContent = `Sent "${ing.projectName}" → ${ing.projectId}`; return; }
  if (ing.phase === 'error') { el.classList.add('err'); el.textContent = `Failed: ${ing.error || 'unknown error'}`; return; }
}

function render() {
  const connected = !!state?.presence?.connected;
  const queue = state?.queue ?? [];
  const pending = queue.length > 0;

  panel.classList.toggle('connected', connected);
  orb.classList.toggle('connected', connected);
  orb.classList.toggle('pending', pending);
  $('apprSec').classList.toggle('gate', pending); // magenta accent only when something is waiting

  const authed = !!state?.security?.tokenAuthed;
  $('tokenAuth').textContent = authed ? 'authenticated ✓' : 'waiting…';
  $('tokenAuth').classList.toggle('ok', authed);

  if (state) {
    const p = state.presence;
    $('connLabel').textContent = connected ? 'CONNECTED' : 'DISCONNECTED';
    $('timer').textContent = fmtTimer(p.uptimeSec);
    $('operator').textContent = p.operator;
    $('avatar').textContent = (p.operator || 'A').trim().charAt(0).toUpperCase();
    $('onlineLabel').textContent = connected ? 'Companion online' : 'Companion offline';
    $('loc').textContent = `${p.host} · ${p.task}`;
    $('transport').textContent = state.security.transport;
    $('profile').textContent = state.security.profile;
    $('domains').textContent = `${state.security.sensitiveCount} guarded`;
    renderApprovals(queue);
    renderIngest(state.ingest);
  }
}

function setMinimized(m) {
  panel.classList.toggle('hidden', m);
  orb.classList.toggle('hidden', !m);
  const [w, h] = m ? ORB_SIZE : PANEL_SIZE;
  if (window.hud) window.hud.resize(w, h);
}

$('minBtn').onclick = () => setMinimized(true);
orb.onclick = () => setMinimized(false);
$('stopBtn').onclick = () => send({ type: 'stop' });
$('ingestBtn').onclick = async () => {
  if (!window.hud || !window.hud.pickFolder) return;
  const phase = state?.ingest?.phase;
  if (phase === 'bundling' || phase === 'uploading') return; // already running — ignore the click
  const path = await window.hud.pickFolder();
  if (path) send({ type: 'ingest', path });
};

function connect() {
  if (!PORT) return; // no bridge yet — wait for a hud.onBridge push
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.onopen = () => send({ type: 'hello', token: TOKEN });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') { state = msg; render(); }
  };
  ws.onclose = () => {
    state = null;
    render();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1500);
  };
  ws.onerror = () => ws.close();
}

// Main pushes the bridge { port, token } whenever bridge.json first appears or
// changes (a Companion restart mints fresh creds). Reconnect to the latest
// creds so the HUD self-heals no matter the start order.
function applyBridge(bridge) {
  if (!bridge) return; // Companion offline — keep retrying the existing creds
  if (bridge.port === PORT && bridge.token === TOKEN) return; // unchanged
  PORT = bridge.port;
  TOKEN = bridge.token;
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null; // don't let the stale socket schedule a reconnect to old creds
    try { ws.close(); } catch {}
    ws = null;
  }
  connect();
}

if (window.hud && window.hud.onBridge) window.hud.onBridge(applyBridge);

render();
