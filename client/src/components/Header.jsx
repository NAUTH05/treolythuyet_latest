export default function Header({ connected, onStopAll }) {
  return (
    <div className="header">
      <h1>🚗 Treo Học Lý Thuyết - Dashboard</h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--text2)' }}>
          <span className={`status-dot ${connected ? '' : 'disconnected'}`} />
          {connected ? 'Kết nối OK' : 'Mất kết nối'}
        </span>
        <button className="btn btn-danger btn-sm" onClick={onStopAll}>
          ⏹ Dừng tất cả
        </button>
      </div>
    </div>
  );
}
