const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const API = BASE;

export async function fetchAccounts() {
  const res = await fetch(`${API}/api/accounts`);
  return res.json();
}

export async function addAccount(data) {
  const res = await fetch(`${API}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function deleteAccount(index) {
  const res = await fetch(`${API}/api/accounts/${index}`, { method: 'DELETE' });
  return res.json();
}

export async function startBot(payload) {
  const res = await fetch(`${API}/api/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function stopSession(id) {
  const res = await fetch(`${API}/api/stop/${id}`, { method: 'POST' });
  return res.json();
}

export async function refreshSession(id) {
  const res = await fetch(`${API}/api/refresh/${id}`, { method: 'POST' });
  return res.json();
}

export async function stopAll() {
  const res = await fetch(`${API}/api/stop-all`, { method: 'POST' });
  return res.json();
}

export async function fetchQueues() {
  const res = await fetch(`${API}/api/queues`);
  return res.json();
}

export async function cancelQueue(queueId) {
  const res = await fetch(`${API}/api/cancel-queue/${queueId}`, { method: 'POST' });
  return res.json();
}

export async function deleteQueue(queueId) {
  const res = await fetch(`${API}/api/queues/${queueId}`, { method: 'DELETE' });
  return res.json();
}

export async function clearCompletedQueues() {
  const res = await fetch(`${API}/api/queues/clear-completed`, { method: 'POST' });
  return res.json();
}

export async function rushQueue(queueId) {
  const res = await fetch(`${API}/api/rush-queue/${queueId}`, { method: 'POST' });
  return res.json();
}

export async function addPairsToQueue(queueId, pairs) {
  const res = await fetch(`${API}/api/add-pairs/${queueId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairs }),
  });
  return res.json();
}

export async function fetchPresets() {
  const res = await fetch(`${API}/api/presets`);
  return res.json();
}

export async function savePreset(payload) {
  const res = await fetch(`${API}/api/presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function deletePreset(id) {
  const res = await fetch(`${API}/api/presets/${id}`, { method: 'DELETE' });
  return res.json();
}
