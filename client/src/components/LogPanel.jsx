import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api';

const LEVEL_CLASS = {
  info: 'log-info',
  success: 'log-success',
  warn: 'log-warn',
  error: 'log-error',
};

const LEVEL_LABELS = {
  info: 'Thông tin',
  success: 'Thành công',
  warn: 'Cảnh báo',
  error: 'Lỗi',
};

const PAGE_SIZE = 200;      // mỗi lần tải
const MAX_RENDER = 2000;    // trần số dòng giữ trong DOM sau khi trộn realtime

function vnDateDDMMYYYY(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(d);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.day}-${values.month}-${values.year}`;
}

function normalizeLogDate(value) {
  const text = String(value || '').trim();
  if (/^\d{2}-\d{2}-\d{4}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-');
    return `${day}-${month}-${year}`;
  }
  return '';
}

// Khóa ổn định để trộn realtime + lịch sử mà không trùng (khớp logQuery.logEntryKey).
function logKey(entry) {
  if (entry && entry.id) return String(entry.id);
  const e = entry || {};
  return `${e.date || ''}|${e.timestamp || ''}|${e.account || 'system'}|${e.level || 'info'}|${e.msg || ''}`;
}

export default function LogPanel({ logs: liveLogs = [], onClear }) {
  const boxRef = useRef(null);
  const [folders, setFolders] = useState([]);
  const [selectedDate, setSelectedDate] = useState(() => vnDateDDMMYYYY());
  // loadedLogs giữ thứ tự thời gian (cũ → mới). Trang mới (cũ hơn) được chèn lên đầu.
  const [loadedLogs, setLoadedLogs] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  // Bộ lọc
  const [filterAccount, setFilterAccount] = useState('');
  const [filterLevel, setFilterLevel] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // Không memo hóa: ngày VN phải tự đổi khi qua nửa đêm mà không cần F5 lại trang.
  const todayStr = vnDateDDMMYYYY();
  const isTodaySelected = selectedDate === todayStr;

  const loadDates = useCallback(async () => {
    try {
      const list = await api.fetchLogDates();
      if (Array.isArray(list)) setFolders(list);
    } catch (e) {
      console.error('Không thể tải danh sách ngày log:', e.message);
    }
  }, []);

  // Tải trang ĐẦU (mới nhất) cho ngày + bộ lọc hiện tại.
  const loadFirstPage = useCallback(async (date, account, level) => {
    if (!date) return;
    setLoading(true);
    try {
      const res = await api.fetchLogHistory({ date, account, level, limit: PAGE_SIZE });
      const rows = res && Array.isArray(res.logs) ? res.logs : [];
      setLoadedLogs(rows.slice().reverse());
      setNextCursor(res ? res.nextCursor : null);
      setHasMore(Boolean(res && res.hasMore));
      setTotal(res && Number.isFinite(res.total) ? res.total : rows.length);
    } catch (e) {
      console.error(`Không thể tải log ngày ${date}:`, e.message);
      setLoadedLogs([]);
      setNextCursor(null);
      setHasMore(false);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  // Tải thêm trang CŨ hơn và chèn lên đầu danh sách thời gian.
  const loadMore = useCallback(async () => {
    if (!hasMore || nextCursor == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.fetchLogHistory({
        date: selectedDate,
        account: filterAccount,
        level: filterLevel,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      const rows = res && Array.isArray(res.logs) ? res.logs : [];
      setLoadedLogs(prev => [...rows.slice().reverse(), ...prev]);
      setNextCursor(res ? res.nextCursor : null);
      setHasMore(Boolean(res && res.hasMore));
    } catch (e) {
      console.error('Không thể tải thêm log:', e.message);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, nextCursor, loadingMore, selectedDate, filterAccount, filterLevel]);

  useEffect(() => {
    loadDates();
  }, [loadDates]);

  // Ngày hoặc bộ lọc đổi → tải lại trang đầu (lọc CHẠY Ở SERVER, không lọc ở React).
  useEffect(() => {
    loadFirstPage(selectedDate, filterAccount, filterLevel);
  }, [selectedDate, filterAccount, filterLevel, loadFirstPage]);

  // Trộn realtime (chỉ khi xem hôm nay) với lịch sử, dedupe theo id/khóa.
  const currentLogs = useMemo(() => {
    if (!isTodaySelected || liveLogs.length === 0) return loadedLogs;
    const map = new Map();
    for (const entry of loadedLogs) map.set(logKey(entry), entry);
    for (const entry of liveLogs) {
      const itemDate = normalizeLogDate(entry && entry.date);
      if (itemDate && itemDate !== todayStr) continue;
      map.set(logKey(entry), entry);
    }
    const merged = [...map.values()];
    return merged.length > MAX_RENDER ? merged.slice(-MAX_RENDER) : merged;
  }, [isTodaySelected, liveLogs, loadedLogs, todayStr]);

  // Danh sách tài khoản: ưu tiên metadata server cho ngày đang chọn.
  const accountList = useMemo(() => {
    const fromMeta = folders.find(f => f.date === selectedDate)?.accounts;
    if (Array.isArray(fromMeta) && fromMeta.length > 0) return [...fromMeta].sort();
    return [...new Set(currentLogs.map(l => l.account).filter(Boolean))].sort();
  }, [folders, selectedDate, currentLogs]);

  const levelCounts = useMemo(() => {
    const counts = { error: 0, warn: 0, success: 0, info: 0 };
    currentLogs.forEach(l => {
      const lvl = l.level || 'info';
      if (counts[lvl] !== undefined) counts[lvl]++;
    });
    return counts;
  }, [currentLogs]);

  // Chỉ tìm kiếm từ khóa trên các dòng đã tải (giới hạn trong bộ nhớ).
  const filteredLogs = useMemo(() => {
    if (!searchQuery) return currentLogs;
    const query = searchQuery.toLowerCase();
    return currentLogs.filter(l => {
      const msg = (l.msg || '').toLowerCase();
      const acc = (l.account || '').toLowerCase();
      return msg.includes(query) || acc.includes(query);
    });
  }, [currentLogs, searchQuery]);

  useEffect(() => {
    if (autoScroll && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [filteredLogs, autoScroll]);

  const handleDeleteCurrentFolder = async () => {
    if (!window.confirm(`Bạn có chắc chắn muốn xóa toàn bộ log của ngày ${selectedDate}?`)) return;
    try {
      await api.deleteLogFolder(selectedDate);
      if (onClear && isTodaySelected) onClear();
      setLoadedLogs([]);
      setNextCursor(null);
      setHasMore(false);
      setTotal(0);
      await loadDates();
    } catch (e) {
      alert('Không thể xóa folder log: ' + e.message);
    }
  };

  // Export lấy dữ liệu TƯỜNG MINH từ server (trả toàn bộ ngày) rồi áp từ khóa.
  const handleExport = async (type = 'txt') => {
    try {
      const data = await api.fetchLogExport({
        date: selectedDate,
        account: filterAccount,
        level: filterLevel,
      });
      let rows = data && Array.isArray(data.logs) ? data.logs : [];
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        rows = rows.filter(l => (l.msg || '').toLowerCase().includes(q) || (l.account || '').toLowerCase().includes(q));
      }
      if (rows.length === 0) return;

      let content = '';
      let mime = 'text/plain';
      let ext = 'txt';
      if (type === 'json') {
        content = JSON.stringify(rows, null, 2);
        mime = 'application/json';
        ext = 'json';
      } else {
        content = rows
          .map(l => l.level === 'separator'
            ? l.msg
            : `[${l.timestamp}] [${l.account || 'system'}] [${(l.level || 'info').toUpperCase()}] ${l.msg}`)
          .join('\n');
      }
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `logs_${selectedDate}_${new Date().getTime()}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Không thể export log: ' + e.message);
    }
  };

  return (
    <div className="card log-container-advanced">
      <div className="card-header log-header-bar">
        <div className="log-header-title">
          <span>📁 Thư mục Logs</span>
          <span className="log-badge-count">{folders.length} ngày</span>
        </div>

        <div className="log-header-actions">
          <button
            className="btn btn-sm btn-outline"
            onClick={() => { loadDates(); loadFirstPage(selectedDate, filterAccount, filterLevel); }}
            title="Làm mới danh sách"
          >
            🔄 Làm mới
          </button>

          <button
            className="btn btn-sm btn-outline"
            onClick={() => handleExport('txt')}
            disabled={filteredLogs.length === 0}
            title="Xuất file văn bản TXT"
          >
            📥 Export TXT
          </button>

          <button
            className="btn btn-sm btn-outline"
            onClick={() => handleExport('json')}
            disabled={filteredLogs.length === 0}
            title="Xuất dữ liệu JSON"
          >
            📥 Export JSON
          </button>

          <button
            className="btn btn-sm btn-danger-ghost"
            onClick={handleDeleteCurrentFolder}
            title="Xóa folder log ngày này"
          >
            🗑️ Xóa ngày này
          </button>
        </div>
      </div>

      <div className="log-workspace">
        <aside className="log-folder-sidebar">
          <div className="log-folder-header">
            <span>Danh sách ngày</span>
          </div>

          <div className="log-folder-list">
            {folders.map(f => {
              const active = f.date === selectedDate;
              return (
                <button
                  key={f.date}
                  className={`log-folder-item ${active ? 'active' : ''} ${f.isToday ? 'is-today' : ''}`}
                  onClick={() => setSelectedDate(f.date)}
                >
                  <span className="folder-icon">{active ? '📂' : '📁'}</span>
                  <span className="folder-name">{f.date}</span>
                  {f.isToday && <span className="folder-tag-today">Hôm nay</span>}
                  <span className="folder-count">{f.count}</span>
                </button>
              );
            })}

            {folders.length === 0 && (
              <div className="empty" style={{ padding: '16px 8px', fontSize: 12 }}>
                Chưa có thư mục log
              </div>
            )}
          </div>
        </aside>

        <main className="log-main-content">
          <div className="log-filter-toolbar">
            <div className="filter-group">
              <label>Ngày:</label>
              <select
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)}
                className="select-sm"
              >
                {folders.map(f => (
                  <option key={f.date} value={f.date}>
                    {f.date} {f.isToday ? '(Hôm nay)' : ''} — {f.count} dòng
                  </option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <label>Tài khoản:</label>
              <select
                value={filterAccount}
                onChange={e => setFilterAccount(e.target.value)}
                className="select-sm"
              >
                <option value="">Tất cả ({accountList.length})</option>
                {accountList.map(a => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <label>Trạng thái:</label>
              <select
                value={filterLevel}
                onChange={e => setFilterLevel(e.target.value)}
                className="select-sm"
              >
                <option value="">Tất cả ({currentLogs.length})</option>
                <option value="error">❌ Lỗi ({levelCounts.error})</option>
                <option value="warn">⚠️ Cảnh báo ({levelCounts.warn})</option>
                <option value="success">✅ Thành công ({levelCounts.success})</option>
                <option value="info">ℹ️ Thông tin ({levelCounts.info})</option>
              </select>
            </div>

            <div className="filter-group search-input-group">
              <input
                type="text"
                placeholder="🔍 Tìm trong các dòng đã tải..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="input-sm"
              />
            </div>

            {(filterAccount || filterLevel || searchQuery) && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setFilterAccount('');
                  setFilterLevel('');
                  setSearchQuery('');
                }}
                title="Reset tất cả bộ lọc"
              >
                Clear lọc
              </button>
            )}

            <label className="checkbox-auto-scroll" title="Tự động cuộn xuống khi có log mới">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={e => setAutoScroll(e.target.checked)}
              />
              Tự cuộn
            </label>
          </div>

          <div className="log-body-container">
            {hasMore && (
              <div style={{ textAlign: 'center', padding: '6px 0' }}>
                <button className="btn btn-sm btn-outline" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Đang tải...' : '↑ Tải thêm (cũ hơn)'}
                </button>
              </div>
            )}

            <div className="log-box-advanced" ref={boxRef}>
              {loading ? (
                <div className="empty" style={{ padding: '30px 0' }}>
                  ⏳ Đang tải dữ liệu log ngày {selectedDate}...
                </div>
              ) : filteredLogs.length === 0 ? (
                <div className="empty" style={{ padding: '30px 0' }}>
                  Chưa có log phù hợp bộ lọc ngày {selectedDate}
                </div>
              ) : (
                filteredLogs.map((entry, i) => entry.level === 'separator' ? (
                  <div key={logKey(entry) + i} className="log-session-separator" aria-label={`Bắt đầu session ${entry.account || ''}`}>
                    {entry.msg}
                  </div>
                ) : (
                  <div key={logKey(entry) + i} className="log-line">
                    <span className="log-time">{entry.timestamp}</span>{' '}
                    <span className="log-account">[{entry.account || 'system'}]</span>{' '}
                    <span className={`log-level-tag ${entry.level || 'info'}`}>
                      {LEVEL_LABELS[entry.level] || 'INFO'}
                    </span>{' '}
                    <span className={LEVEL_CLASS[entry.level] || 'log-info'}>{entry.msg}</span>
                  </div>
                ))
              )}
            </div>

            <div className="log-status-footer">
              <span>
                Hiển thị <strong>{filteredLogs.length}</strong> / <strong>{total}</strong> dòng
                {hasMore ? ' (còn dữ liệu cũ hơn)' : ''}
              </span>
              {isTodaySelected && (
                <span className="live-pulse" title="Đang nhận log trực tiếp từ Socket.io">
                  🔴 Live Stream
                </span>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
