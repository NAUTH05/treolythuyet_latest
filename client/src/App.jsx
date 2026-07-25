import { useCallback, useEffect, useState } from 'react';
import * as api from './api';
import AccountPanel from './components/AccountPanel';
import ControlPanel from './components/ControlPanel';
import Header from './components/Header';
import LogPanel from './components/LogPanel';
import SessionList from './components/SessionList';
import ToastContainer from './components/ToastContainer';
import { useSocket } from './hooks/useSocket';
import { useToast } from './hooks/useToast';

function App() {
  const { connected, sessions, queues, logs, setLogs } = useSocket();
  const { toasts, toast } = useToast();
  const [accounts, setAccounts] = useState([]);

  const loadAccounts = useCallback(async () => {
    try {
      const data = await api.fetchAccounts();
      setAccounts(data);
    } catch {
      toast('❌ Không thể tải danh sách tài khoản', 'error');
    }
  }, [toast]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  const handleStart = async (payload) => {
    try {
      const data = await api.startBot(payload);
      if (data.ok) {
        toast(`🚀 Đã khởi động ${data.started.length} phiên`, 'success');
      } else {
        toast(`❌ ${data.error}`, 'error');
      }
    } catch (err) {
      toast(`❌ Lỗi kết nối: ${err.message}`, 'error');
    }
  };

  const handleStopAll = async () => {
    if (!window.confirm('Dừng tất cả phiên?')) return;
    await api.stopAll();
    toast('⏹ Đã dừng tất cả', 'info');
  };

  return (
    <>
      <Header connected={connected} onStopAll={handleStopAll} />
      <div className="container">
        <ControlPanel accounts={accounts} onStart={handleStart} />
        <AccountPanel accounts={accounts} onRefresh={loadAccounts} toast={toast} />
        <SessionList sessions={sessions} queues={queues} toast={toast} />
        <LogPanel logs={logs} onClear={() => setLogs([])} />
      </div>
      <ToastContainer toasts={toasts} />
    </>
  );
}

export default App;
