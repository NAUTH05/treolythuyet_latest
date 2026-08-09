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

function vnDateDDMMYYYY(d = new Date()) {
  const parts = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).split('-');
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

export default function LogPanel({ logs: liveLogs = [], onClear }) {
  const boxRef = useRef(null);
  const [folders, setFolders] = useState([]);
  const [selectedDate, setSelectedDate] = useState(() => vnDateDDMMYYYY());
  const [dateLogs, setDateLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  // Bộ lọc
  const [filterAccount, setFilterAccount] = useState('');
  const [filterLevel, setFilterLevel] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const todayStr = useMemo(() => vnDateDDMMYYYY(), []);
  const isTodaySelected = selectedDate === todayStr;

  // Tải danh sách thư mục ngày từ backend
  const loadFolders = useCallback(async () => {
    try {
      const list = await api.fetchLogFolders();
      if (Array.isArray(list)) {
        setFolders(list);
        // Nếu ngày đang chọn không có trong list và chưa có folder nào, giữ nguyên todayStr
        if (!selectedDate && list.length > 0) {
          setSelectedDate(list[0].date);
        }
      }
    } catch (e) {
      console.error('Không thể tải danh sách folder log:', e.message);
    }
  }, [selectedDate]);

  // Tải logs theo ngày đã chọn
  const loadLogsForDate = useCallback(async (date) => {
    if (!date) return;
    setLoading(true);
    try {
      const res = await api.fetchLogsByDate(date);
      if (res && Array.isArray(res.logs)) {
        setDateLogs(res.logs);
      } else {
        setDateLogs([]);
      }
    } catch (e) {
      console.error(`Không thể tải log ngày ${date}:`, e.message);
      setDateLogs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  useEffect(() => {
    loadLogsForDate(selectedDate);
  }, [selectedDate, loadLogsForDate]);

  // Tổng hợp danh sách log để hiển thị
  // Nếu đang chọn ngày hôm nay: ưu tiên hợp nhất `liveLogs` với `dateLogs`
  const currentLogs = useMemo(() => {
    if (isTodaySelected) {
      if (liveLogs.length > 0) {
        // Map theo unique key
        const map = new Map();
        [...dateLogs, ...liveLogs].forEach(item => {
          const key = `${item.timestamp}_${item.account}_${item.msg}`;
          map.set(key, item);
        });
        return Array.from(map.values());
      }
      return dateLogs;
    }
    return dateLogs;
  }, [isTodaySelected, liveLogs, dateLogs]);

  // Trích xuất danh sách tài khoản xuất hiện trong log hiện tại
  const accountList = useMemo(
    () => [...new Set(currentLogs.map(l => l.account).filter(Boolean))].sort(),
    [currentLogs]
  );

  // Đếm theo từng cấp độ log
  const levelCounts = useMemo(() => {
    const counts = { error: 0, warn: 0, success: 0, info: 0 };
    currentLogs.forEach(l => {
      const lvl = l.level || 'info';
      if (counts[lvl] !== undefined) counts[lvl]++;
    });
    return counts;
  }, [currentLogs]);

  // Filter logs theo tiêu chí
  const filteredLogs = useMemo(() => {
    return currentLogs.filter(l => {
      if (filterAccount && l.account !== filterAccount) return false;
      if (filterLevel && l.level !== filterLevel) return false;
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const msg = (l.msg || '').toLowerCase();
        const acc = (l.account || '').toLowerCase();
        if (!msg.includes(query) && !acc.includes(query)) return false;
      }
      return true;
    });
  }, [currentLogs, filterAccount, filterLevel, searchQuery]);

  // Auto scroll xuống cuối nếu bật
  useEffect(() => {
    if (autoScroll && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [filteredLogs, autoScroll]);

  // Xóa folder log của ngày đang chọn
  const handleDeleteCurrentFolder = async () => {
    if (!window.confirm(`Bạn có chắc chắn muốn xóa toàn bộ log của ngày ${selectedDate}?`)) return;
    try {
      await api.deleteLogFolder(selectedDate);
      if (onClear && isTodaySelected) onClear();
      setDateLogs([]);
      await loadFolders();
    } catch (e) {
      alert('Không thể xóa folder log: ' + e.message);
    }
  };

  // Export file log
  const handleExport = (type = 'txt') => {
    if (filteredLogs.length === 0) return;
    let content = '';
    let mime = 'text/plain';
    let ext = 'txt';

    if (type === 'json') {
      content = JSON.stringify(filteredLogs, null, 2);
      mime = 'application/json';
      ext = 'json';
    } else {
      content = filteredLogs
        .map(l => `[${l.timestamp}] [${l.account || 'system'}] [${(l.level || 'info').toUpperCase()}] ${l.msg}`)
        .join('\n');
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs_${selectedDate}_${new Date().getTime()}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card log-container-advanced">
      {/* Header bar tổng quan */}
      <div className="card-header log-header-bar">
        <div className="log-header-title">
          <span>📁 Thư mục Logs</span>
          <span className="log-badge-count">{folders.length} ngày</span>
        </div>

        {/* Action quick buttons */}
        <div className="log-header-actions">
          <button
            className="btn btn-sm btn-outline"
            onClick={() => { loadFolders(); loadLogsForDate(selectedDate); }}
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
        {/* CỘT TRÁI: Thư mục theo ngày DD-MM-YYYY */}
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

        {/* CỘT PHẢI: Nội dung log & Bộ lọc */}
        <main className="log-main-content">
          {/* Thanh Filter Đầy Đủ */}
          <div className="log-filter-toolbar">
            {/* Đổi nhanh thư mục date trong dropdown */}
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

            {/* Lọc theo tài khoản */}
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

            {/* Lọc theo Trạng thái / Level */}
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

            {/* Tìm kiếm từ khóa */}
            <div className="filter-group search-input-group">
              <input
                type="text"
                placeholder="🔍 Tìm từ khóa / nội dung log..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="input-sm"
              />
            </div>

            {/* Reset Filter */}
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

            {/* Auto scroll toggle */}
            <label className="checkbox-auto-scroll" title="Tự động cuộn xuống khi có log mới">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={e => setAutoScroll(e.target.checked)}
              />
              Tự cuộn
            </label>
          </div>

          {/* Log Display Box */}
          <div className="log-body-container">
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
                filteredLogs.map((entry, i) => (
                  <div key={i} className="log-line">
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

            {/* Footer tóm tắt số lượng */}
            <div className="log-status-footer">
              <span>Hiển thị <strong>{filteredLogs.length}</strong> / <strong>{currentLogs.length}</strong> dòng log</span>
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
