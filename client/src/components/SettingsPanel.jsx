import { useEffect, useState } from 'react';
import * as api from '../api';

export default function SettingsPanel({ toast }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passLoading, setPassLoading] = useState(false);
  const [fbLoading, setFbLoading] = useState(false);
  const [firebaseStatus, setFirebaseStatus] = useState({ connected: false, admin: {} });

  const loadFirebaseStatus = () => api.fetchFirebaseConfig()
    .then(data => setFirebaseStatus(data || { connected: false, admin: {} }))
    .catch(() => setFirebaseStatus({ connected: false, admin: {} }));

  useEffect(() => { loadFirebaseStatus(); }, []);

  const handleChangePassword = async (event) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      toast('Mật khẩu mới xác nhận không khớp', 'error');
      return;
    }
    setPassLoading(true);
    try {
      const data = await api.changePassword(oldPassword, newPassword);
      if (data.ok) {
        toast('Đã đổi mật khẩu - vui lòng đăng nhập lại', 'success');
        sessionStorage.removeItem('treohoc_admin_token');
        setTimeout(() => window.location.reload(), 800);
      } else {
        toast(data.error || 'Lỗi đổi mật khẩu', 'error');
      }
    } catch {
      toast('Lỗi kết nối máy chủ', 'error');
    } finally {
      setPassLoading(false);
    }
  };

  const handleVerifyFirebase = async () => {
    setFbLoading(true);
    try {
      const data = await api.saveFirebaseConfig();
      setFirebaseStatus(data || { connected: false, admin: {} });
      if (data.ok) {
        toast(data.restartRequired
          ? 'Admin SDK đã xác minh; cần khởi động lại máy chủ để khôi phục Queue và Auto-Scan an toàn'
          : 'Firebase Admin SDK đã kết nối và đồng bộ', 'success');
      } else {
        toast(data.error || 'Không thể xác minh Firebase Admin SDK', 'error');
      }
    } catch (error) {
      toast(error.message || 'Không thể xác minh Firebase Admin SDK', 'error');
    } finally {
      setFbLoading(false);
      loadFirebaseStatus();
    }
  };

  const admin = firebaseStatus.admin || {};
  const connected = Boolean(firebaseStatus.connected);

  return (
    <div className="two-col-grid">
      <div className="card">
        <div className="card-header">Bảo mật mật khẩu Admin</div>
        <div className="card-body">
          <form onSubmit={handleChangePassword}>
            <div className="form-group">
              <label>Mật khẩu Admin hiện tại</label>
              <input type="password" value={oldPassword} onChange={e => setOldPassword(e.target.value)} required />
            </div>
            <div className="form-group">
              <label>Mật khẩu Admin mới</label>
              <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required />
            </div>
            <div className="form-group">
              <label>Xác nhận mật khẩu mới</label>
              <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required />
            </div>
            <button type="submit" className="btn btn-primary" disabled={passLoading}>
              {passLoading ? 'Đang lưu...' : 'Đổi mật khẩu Admin'}
            </button>
          </form>
        </div>
      </div>

      <div className="card">
        <div className="card-header" style={{ justifyContent: 'space-between' }}>
          <span>Firebase Admin SDK</span>
          <span className={`session-badge ${connected ? 'badge-completed' : 'badge-idle'}`}>
            {connected ? 'Đã xác minh' : 'Chưa kết nối'}
          </span>
        </div>
        <div className="card-body">
          <div className="form-group">
            <label>Project ID</label>
            <input type="text" value={admin.projectId || 'Chưa cấu hình'} readOnly />
          </div>
          <div className="form-group">
            <label>Nguồn xác thực</label>
            <input type="text" value={admin.credentialSource || 'Chưa cấu hình trên máy chủ'} readOnly />
          </div>
          <div className="form-group">
            <label>Trạng thái</label>
            <input type="text" value={admin.lastError || admin.configurationStatus || 'unknown'} readOnly />
          </div>
          <button type="button" className="btn btn-primary" disabled={fbLoading} onClick={handleVerifyFirebase}>
            {fbLoading ? 'Đang kiểm tra...' : 'Kiểm tra và đồng bộ Admin SDK'}
          </button>
        </div>
      </div>
    </div>
  );
}
