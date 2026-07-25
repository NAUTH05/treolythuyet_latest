import { useEffect, useMemo, useRef, useState } from 'react';

const LEVEL_CLASS = {
  info: 'log-info',
  success: 'log-success',
  warn: 'log-warn',
  error: 'log-error',
};

export default function LogPanel({ logs, onClear }) {
  const boxRef = useRef(null);
  const [filterAccount, setFilterAccount] = useState('');
  const [filterLevel, setFilterLevel] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // Derive unique account names from logs
  const accountList = useMemo(
    () => [...new Set(logs.map(l => l.account).filter(Boolean))].sort(),
    [logs]
  );

  const filteredLogs = useMemo(() => {
    return logs.filter(l => {
      // Account filter
      if (filterAccount && l.account !== filterAccount) return false;
      // Level filter
      if (filterLevel && l.level !== filterLevel) return false;
      // Search text filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const msg = (l.msg || '').toLowerCase();
        const acc = (l.account || '').toLowerCase();
        if (!msg.includes(query) && !acc.includes(query)) return false;
      }
      return true;
    });
  }, [logs, filterAccount, filterLevel, searchQuery]);

  useEffect(() => {
    if (boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [filteredLogs]);

  return (
    <div className="card log-container">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span>📜 Nhật ký hệ thống</span>

        {/* Filter Controls Bar */}
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Search Input */}
          <input
            type="text"
            placeholder="🔍 Tìm từ khóa..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{
              padding: '4px 10px',
              background: 'var(--surface2)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              color: 'var(--text)',
              fontSize: '11px',
              outline: 'none',
              width: '130px',
            }}
          />

          {/* Level / Status Filter */}
          <select
            value={filterLevel}
            onChange={e => setFilterLevel(e.target.value)}
            style={{
              padding: '4px 10px',
              background: 'var(--surface2)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              color: 'var(--text)',
              fontSize: '11px',
              cursor: 'pointer',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          >
            <option value="">Tất cả trạng thái</option>
            <option value="error">❌ Lỗi (Error)</option>
            <option value="warn">⚠️ Cảnh báo (Warn)</option>
            <option value="success">✅ Thành công (Success)</option>
            <option value="info">ℹ️ Thông tin (Info)</option>
          </select>

          {/* Account Filter */}
          <select
            value={filterAccount}
            onChange={e => setFilterAccount(e.target.value)}
            style={{
              padding: '4px 10px',
              background: 'var(--surface2)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              color: 'var(--text)',
              fontSize: '11px',
              cursor: 'pointer',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          >
            <option value="">Tất cả tài khoản</option>
            {accountList.map(a => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>

          {(filterAccount || filterLevel || searchQuery) && (
            <button
              className="btn btn-sm btn-outline"
              onClick={() => {
                setFilterAccount('');
                setFilterLevel('');
                setSearchQuery('');
              }}
              style={{ fontSize: 10, padding: '3px 8px' }}
              title="Reset bộ lọc"
            >
              🔄 Reset
            </button>
          )}

          <button className="btn btn-sm btn-outline" onClick={onClear}>Xóa log</button>
        </div>
      </div>

      <div className="card-body" style={{ padding: 12 }}>
        <div className="log-box" ref={boxRef}>
          {filteredLogs.length === 0 ? (
            <div style={{ color: 'var(--text2)', textAlign: 'center', padding: '20px 0', fontSize: 12 }}>
              Chưa có log phù hợp bộ lọc
            </div>
          ) : (
            filteredLogs.map((entry, i) => (
              <div key={i} className="log-line">
                <span className="log-time">{entry.timestamp}</span>{' '}
                <span className="log-account">[{entry.account}]</span>{' '}
                <span className={LEVEL_CLASS[entry.level] || 'log-info'}>{entry.msg}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
