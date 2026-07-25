import { useEffect, useRef, useState } from 'react';

const SIDEBAR_WIDTH_KEY = 'treohoc_sidebar_width';
const SIDEBAR_COLLAPSED_KEY = 'treohoc_sidebar_collapsed';

export default function Sidebar({ activeTab, onTabChange, connected, onStopAll, onLogout, activeSessionsCount, activeQueuesCount }) {
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  });

  const [width, setWidth] = useState(() => {
    const saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
    return saved && saved >= 200 && saved <= 400 ? saved : 240;
  });

  const isResizing = useRef(false);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed);
  }, [collapsed]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, width);
  }, [width]);

  const handleMouseDown = (e) => {
    e.preventDefault();
    isResizing.current = true;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleMouseMove = (e) => {
    if (!isResizing.current) return;
    const newWidth = e.clientX;
    if (newWidth >= 180 && newWidth <= 380) {
      setWidth(newWidth);
    }
  };

  const handleMouseUp = () => {
    isResizing.current = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };

  const navItems = [
    { id: 'dashboard', label: 'Tổng quan', icon: '◈' },
    { id: 'autoscan', label: 'Auto Scan Khóa Học', icon: '🤖' },
    { id: 'control', label: 'Điều khiển Box', icon: '▶' },
    { id: 'accounts', label: 'Tài khoản', icon: '○' },
    { id: 'queues', label: 'Hàng chờ & Phiên', icon: '≡', badge: activeQueuesCount + activeSessionsCount },
    { id: 'logs', label: 'Nhật ký hệ thống', icon: '∷' },
    { id: 'settings', label: 'Cài đặt & Firebase', icon: '◎' },
  ];

  const sidebarWidth = collapsed ? 70 : width;

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} style={{ width: sidebarWidth }}>
      {/* Brand Header */}
      <div className="sidebar-brand">
        <div className="brand-logo" style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.5px', fontFamily: 'serif' }}>TLT</div>
        {!collapsed && (
          <div className="brand-info">
            <span className="brand-title">Treo Lý Thuyết</span>
            <span className="brand-subtitle">Dashboard Pro</span>
          </div>
        )}
        <button
          className="toggle-btn"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? 'Mở rộng menu' : 'Thu gọn menu'}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      {/* Connection Status */}
      <div className="sidebar-status">
        <span className={`status-dot ${connected ? '' : 'disconnected'}`} />
        {!collapsed && (
          <span className="status-text">
            {connected ? 'Kết nối Máy chủ' : 'Mất kết nối'}
          </span>
        )}
      </div>

      {/* Nav Menu */}
      <nav className="sidebar-nav">
        {navItems.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              className={`nav-item ${isActive ? 'active' : ''}`}
              onClick={() => onTabChange(item.id)}
              title={collapsed ? item.label : undefined}
            >
              <span className="nav-icon">{item.icon}</span>
              {!collapsed && <span className="nav-label">{item.label}</span>}
              {!collapsed && item.badge > 0 && (
                <span className="nav-badge">{item.badge}</span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Bottom Actions */}
      <div className="sidebar-footer">
        <button
          className="btn btn-danger btn-sm sidebar-action-btn"
          onClick={onStopAll}
          title={collapsed ? 'Dừng tất cả' : undefined}
        >
          <span>■</span>
          {!collapsed && <span>Dừng tất cả</span>}
        </button>

        <button
          className="btn btn-outline btn-sm sidebar-action-btn"
          onClick={onLogout}
          title={collapsed ? 'Đăng xuất' : undefined}
        >
          <span>→</span>
          {!collapsed && <span>Đăng xuất</span>}
        </button>
      </div>

      {/* Resizer Handle */}
      {!collapsed && (
        <div className="sidebar-resizer" onMouseDown={handleMouseDown} title="Kéo để chỉnh độ rộng" />
      )}
    </aside>
  );
}
