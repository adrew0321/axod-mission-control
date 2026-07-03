const params = new URLSearchParams(location.search);
const PORT = params.get('port');
const TOKEN = params.get('token');

let ws = null;
let state = null;

const orb = document.getElementById('orb');

function render() {
  const connected = !!state?.presence?.connected;
  const pending = (state?.queue?.length ?? 0) > 0;
  orb.classList.toggle('connected', connected);
  orb.classList.toggle('pending', pending);
}

function connect() {
  if (!PORT) return;
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') { state = msg; render(); }
  };
  ws.onclose = () => { state = null; render(); setTimeout(connect, 1500); };
  ws.onerror = () => ws.close();
}

// send helper used by later UI
window.send = (obj) => ws && ws.readyState === 1 && ws.send(JSON.stringify(obj));

connect();
render();
