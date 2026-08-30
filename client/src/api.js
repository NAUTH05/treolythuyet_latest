const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const API = BASE;

const ADMIN_TOKEN_KEY = 'treohoc_admin_token';

function getToken() {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
}

// Header xác thực gắn vào mọi request; `extra` để thêm Content-Type khi có body
function authHeaders(extra = {}) {
  const token = getToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

// Token hết hạn / bị thu hồi → xóa và buộc hiện lại màn đăng nhập
function handle401(res) {
  if (res.status === 401) {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    window.location.reload();
  }
  return res;
}

async function apiGet(pathStr) {
  const res = handle401(await fetch(`${API}${pathStr}`, { headers: authHeaders() }));
  return res.json();
}

async function apiSend(pathStr, method, body) {
  const opts = { method, headers: authHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = handle401(await fetch(`${API}${pathStr}`, opts));
  return res.json();
}

// ── Tài khoản ──
export const fetchAccounts = () => apiGet('/api/accounts');
export const addAccount = (data) => apiSend('/api/accounts', 'POST', data);
export const deleteAccount = (index) => apiSend(`/api/accounts/${index}`, 'DELETE');

// ── Queue thủ công ──
export const startBot = (payload) => apiSend('/api/start', 'POST', payload);
export const stopSession = (id) => apiSend(`/api/stop/${id}`, 'POST');
export const refreshSession = (id) => apiSend(`/api/refresh/${id}`, 'POST');
export const stopAll = () => apiSend('/api/stop-all', 'POST');
export const fetchQueues = () => apiGet('/api/queues');
export const cancelQueue = (queueId) => apiSend(`/api/cancel-queue/${queueId}`, 'POST');
export const deleteQueue = (queueId) => apiSend(`/api/queues/${queueId}`, 'DELETE');
export const clearCompletedQueues = () => apiSend('/api/queues/clear-completed', 'POST');
export const rushQueue = (queueId) => apiSend(`/api/rush-queue/${queueId}`, 'POST');
export const addPairsToQueue = (queueId, pairs) => apiSend(`/api/add-pairs/${queueId}`, 'POST', { pairs });

// ── Auto-Scan ──
export const startAutoScan = (payload) => apiSend('/api/auto-scan/start', 'POST', payload);
export const stopAutoScan = (id) => apiSend(`/api/auto-scan/stop/${id}`, 'POST');
export const pauseAutoScan = (id) => apiSend(`/api/auto-scan/pause/${id}`, 'POST');
export const resumeAutoScan = (id) => apiSend(`/api/auto-scan/resume/${id}`, 'POST');
export const setAutoScanDailyMinutes = (id, minutes) => apiSend(`/api/auto-scan/set-daily-minutes/${id}`, 'POST', { minutes });
export const removeAutoScan = (id) => apiSend(`/api/auto-scan/sessions/${id}`, 'DELETE');
export const clearCompletedAutoScans = () => apiSend('/api/auto-scan/clear-completed', 'POST');
export const fetchAutoPresets = () => apiGet('/api/auto-presets');
export const saveAutoPreset = (payload) => apiSend('/api/auto-presets', 'POST', payload);
export const deleteAutoPreset = (id) => apiSend(`/api/auto-presets/${id}`, 'DELETE');

// ── Preset Queue thủ công ──
export const fetchPresets = () => apiGet('/api/presets');
export const savePreset = (payload) => apiSend('/api/presets', 'POST', payload);
export const deletePreset = (id) => apiSend(`/api/presets/${id}`, 'DELETE');

// ── Admin / Firebase ──
export const changePassword = (oldPassword, newPassword) =>
  apiSend('/api/admin/change-password', 'POST', { oldPassword, newPassword });
export const fetchFirebaseConfig = () => apiGet('/api/admin/firebase-config');
export const saveFirebaseConfig = () => apiSend('/api/admin/firebase-config', 'POST');

// ── Logs ──
export const fetchLogFolders = () => apiGet('/api/logs/folders');
export const fetchLogsByDate = (date) => apiGet(`/api/logs/by-date?date=${encodeURIComponent(date)}`);
export const deleteLogFolder = (date) => apiSend(`/api/logs/by-date?date=${encodeURIComponent(date)}`, 'DELETE');

// Đăng xuất — thu hồi token trên server rồi xóa client (không reload ở đây, App xử lý)
export async function logout() {
  try {
    await fetch(`${API}/api/admin/logout`, { method: 'POST', headers: authHeaders() });
  } catch { /* ignore */ }
  sessionStorage.removeItem(ADMIN_TOKEN_KEY);
}
