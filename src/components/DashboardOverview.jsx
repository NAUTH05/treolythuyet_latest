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
        <div>
          <span className="eyebrow">TRUNG TÂM ĐIỀU HÀNH</span>
          <h2>Tổng quan hệ thống</h2>
          <p>Theo dõi nhanh tiến độ treo bài học, các phiên đang hoạt động và danh sách tài khoản.</p>
        </div>
        <div className="overview-primary-actions">
          <button className="btn btn-primary" onClick={() => onNavigate('control')}>+ Treo Box mới</button>
          <button className="btn btn-outline" onClick={() => onNavigate('autoscan')}>Auto Scan</button>
        </div>
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

      <div className="overview-lower-grid">
        <div className="card">
          <div className="card-header">Bắt đầu nhanh</div>
          <div className="card-body quick-actions">
            <button className="quick-action" onClick={() => onNavigate('control')}><span className="quick-action-icon">▶</span><span><strong>Treo Box bài học</strong><small>Tạo phiên chạy thủ công</small></span><span className="quick-action-arrow">→</span></button>
            <button className="quick-action" onClick={() => onNavigate('autoscan')}><span className="quick-action-icon">⟳</span><span><strong>Auto Scan khóa học</strong><small>Quét và học theo lịch</small></span><span className="quick-action-arrow">→</span></button>
            <button className="quick-action" onClick={() => onNavigate('accounts')}><span className="quick-action-icon">○</span><span><strong>Thêm tài khoản</strong><small>Mở danh sách tài khoản</small></span><span className="quick-action-arrow">→</span></button>
          </div>
        </div>
        <div className="card overview-health-card">
          <div className="card-header">Tình trạng hệ thống</div>
          <div className="card-body">
            <div className="health-row"><span className="health-dot health-dot-success" /><span>Phiên đang chạy</span><strong>{activeSessionsList.length}</strong></div>
            <div className="health-row"><span className="health-dot health-dot-warning" /><span>Đang chờ xử lý</span><strong>{activeQueuesList.length}</strong></div>
            <div className="health-row"><span className="health-dot health-dot-info" /><span>Auto Scan hoạt động</span><strong>{activeAutoScansList.length}</strong></div>
            <button className="btn btn-ghost btn-block overview-secondary-action" onClick={() => onNavigate('queues')}>Xem tất cả tiến độ →</button>
        </div>
      </div>
    </div>
  );
}
