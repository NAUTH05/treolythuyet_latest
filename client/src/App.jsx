import { useCallback, useEffect, useState } from 'react';
import * as api from './api';
import AccountPanel from './components/AccountPanel';
import AdminAuthModal from './components/AdminAuthModal';
import ControlPanel from './components/ControlPanel';
import DashboardOverview from './components/DashboardOverview';
import LogPanel from './components/LogPanel';
import SessionList from './components/SessionList';
import SettingsPanel from './components/SettingsPanel';
import Sidebar from './components/Sidebar';
import ToastContainer from './components/ToastContainer';
import { useSocket } from './hooks/useSocket';
import { useToast } from './hooks/useToast';

const ADMIN_TOKEN_KEY = 'treohoc_admin_token';

function App() {
  const { connected, sessions, queues, logs, setLogs } = useSocket();
  const { toasts, toast } = useToast();
  const [accounts, setAccounts] = useState([]);
  const [activeTab, setActiveTab] = useState('dashboard');

  // Admin auth state
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(() => {
    return !!sessionStorage.getItem(ADMIN_TOKEN_KEY);
  });

  const handleAdminVerify = (token) => {
    sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    setIsAdminAuthenticated(true);
    toast('Đăng nhập Admin thành công', 'success');
  };

  const handleLogout = () => {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    setIsAdminAuthenticated(false);
    toast('Đã đăng xuất Admin', 'info');
  };

  const loadAccounts = useCallback(async () => {
    if (!isAdminAuthenticated) return;
    try {
      const data = await api.fetchAccounts();
      setAccounts(data);
    } catch {
      toast('Không thể tải danh sách tài khoản', 'error');
    }
  }, [isAdminAuthenticated, toast]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  const handleStart = async (payload) => {
    try {
      const data = await api.startBot(payload);
      if (data.ok) {
        toast(`Đã khởi động ${data.started.length} phiên`, 'success');
        setActiveTab('queues');
      } else {
        toast(data.error, 'error');
      }
    } catch (err) {
      toast(`Lỗi kết nối: ${err.message}`, 'error');
    }
  };

  const handleStopAll = async () => {
    if (!window.confirm('Dừng tất cả phiên?')) return;
    await api.stopAll();
    toast('Đã dừng tất cả phiên', 'info');
  };

  const activeSessionsCount = Object.values(sessions || {}).filter(
    s => s.status === 'running' || s.status === 'logging-in'
  ).length;

  const activeQueuesCount = Object.values(queues || {}).filter(
    q => q.status === 'running' || q.status === 'waiting'
  ).length;

  return (
    <>
      {/* Admin Lock Overlay */}
      {!isAdminAuthenticated && (
        <AdminAuthModal onVerify={handleAdminVerify} />
      )}

      <div className="app-layout">
        {/* Left Resizable & Collapsible Sidebar */}
        <Sidebar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          connected={connected}
          onStopAll={handleStopAll}
          onLogout={handleLogout}
          activeSessionsCount={activeSessionsCount}
          activeQueuesCount={activeQueuesCount}
        />

        {/* Main Content View Container */}
        <main className="main-content">
          <header className="top-header">
            <div className="top-header-title">
              {activeTab === 'dashboard' && 'Tổng quan hệ thống'}
              {activeTab === 'control' && 'Bảng điều khiển Box bài học'}
              {activeTab === 'accounts' && 'Quản lý danh sách tài khoản'}
              {activeTab === 'queues' && 'Tiến độ Hàng chờ & Các phiên đang chạy'}
              {activeTab === 'logs' && 'Nhật ký hoạt động hệ thống'}
              {activeTab === 'settings' && 'Cấu hình hệ thống & Firebase'}
            </div>

            <div className="top-header-actions">
              <span className={`status-badge ${connected ? 'connected' : 'disconnected'}`}>
                {connected ? 'Online' : 'Offline'}
              </span>
            </div>
          </header>

          <div className="tab-content">
            {activeTab === 'dashboard' && (
              <DashboardOverview
                accounts={accounts}
                sessions={sessions}
                queues={queues}
                onNavigate={setActiveTab}
              />
            )}

            {activeTab === 'control' && (
              <ControlPanel accounts={accounts} onStart={handleStart} />
            )}

            {activeTab === 'accounts' && (
              <AccountPanel accounts={accounts} onRefresh={loadAccounts} toast={toast} />
            )}

            {activeTab === 'queues' && (
              <SessionList sessions={sessions} queues={queues} toast={toast} />
            )}

            {activeTab === 'logs' && (
              <LogPanel logs={logs} onClear={() => setLogs([])} />
            )}

            {activeTab === 'settings' && (
              <SettingsPanel toast={toast} />
            )}
          </div>
        </main>

        <ToastContainer toasts={toasts} />
      </div>
    </>
  );
}

export default App;
