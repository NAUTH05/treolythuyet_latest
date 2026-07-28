export default function DashboardOverview({ accounts, sessions, queues, autoScans, onNavigate }) {
  const accountCount = accounts.length;

  const activeSessionsList = Object.values(sessions || {}).filter(
    s => s.status === 'running' || s.status === 'logging-in'
  );

  const activeQueuesList = Object.values(queues || {}).filter(
    q => q.status === 'running' || q.status === 'waiting' || q.status === 'paused'
  );

  const completedQueuesList = Object.values(queues || {}).filter(
    q => q.status === 'completed'
  );

  const activeAutoScansList = Object.values(autoScans || {}).filter(
    s => s.status === 'logging-in' || s.status === 'scanning' || s.status === 'studying'
  );

  return (
    <div className="overview-container">
      <div className="overview-welcome">
        <h2>Tổng quan hệ thống</h2>
        <p>Theo dõi nhanh tiến độ treo bài học, các phiên đang hoạt động và danh sách tài khoản.</p>
      </div>

      <div className="overview-grid">
        <div className="stat-card" onClick={() => onNavigate('accounts')} style={{ cursor: 'pointer' }}>
          <div className="stat-card-header">
            <span className="stat-card-title">Tài khoản hợp lệ</span>
            <span className="stat-card-icon">○</span>
          </div>
          <div className="stat-card-value">{accountCount}</div>
          <div className="stat-card-desc">Tài khoản lái xe đã sẵn sàng</div>
        </div>

        <div className="stat-card" onClick={() => onNavigate('queues')} style={{ cursor: 'pointer' }}>
          <div className="stat-card-header">
            <span className="stat-card-title">Phiên đang treo</span>
            <span className="stat-card-icon">◉</span>
          </div>
          <div className="stat-card-value" style={{ color: 'var(--accent)' }}>
            {activeSessionsList.length}
          </div>
          <div className="stat-card-desc">Browser đang chạy tự động</div>
        </div>

        <div className="stat-card" onClick={() => onNavigate('autoscan')} style={{ cursor: 'pointer' }}>
          <div className="stat-card-header">
            <span className="stat-card-title">Auto-Scan đang chạy</span>
            <span className="stat-card-icon">⟳</span>
          </div>
          <div className="stat-card-value" style={{ color: 'var(--accent)' }}>
            {activeAutoScansList.length}
          </div>
          <div className="stat-card-desc">Phiên quét & treo khóa học tự động</div>
        </div>

        <div className="stat-card" onClick={() => onNavigate('queues')} style={{ cursor: 'pointer' }}>
          <div className="stat-card-header">
            <span className="stat-card-title">Hàng chờ đang chạy</span>
            <span className="stat-card-icon">≡</span>
          </div>
          <div className="stat-card-value" style={{ color: 'var(--warning)' }}>
            {activeQueuesList.length}
          </div>
          <div className="stat-card-desc">Queue box chờ xử lý tiếp theo</div>
        </div>

        <div className="stat-card">
          <div className="stat-card-header">
            <span className="stat-card-title">Queue hoàn thành</span>
            <span className="stat-card-icon">✓</span>
          </div>
          <div className="stat-card-value" style={{ color: 'var(--success)' }}>
            {completedQueuesList.length}
          </div>
          <div className="stat-card-desc">Đã treo đủ giờ thành công</div>
        </div>
      </div>

      {/* Quick Action Grid */}
      <div className="card">
        <div className="card-header">Thao tác nhanh</div>
        <div className="card-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => onNavigate('control')}>
            Bắt đầu treo Box bài mới
          </button>
          <button className="btn btn-outline" onClick={() => onNavigate('autoscan')}>
            Auto-Scan khóa học
          </button>
          <button className="btn btn-outline" onClick={() => onNavigate('accounts')}>
            Thêm tài khoản mới
          </button>
          <button className="btn btn-outline" onClick={() => onNavigate('queues')}>
            Xem tiến độ hàng chờ
          </button>
          <button className="btn btn-outline" onClick={() => onNavigate('logs')}>
            Xem Logs
          </button>
          <button className="btn btn-outline" onClick={() => onNavigate('settings')}>
            Cấu hình Firebase & Mật khẩu
          </button>
        </div>
      </div>
    </div>
  );
}
