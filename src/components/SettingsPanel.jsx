import { useEffect, useState } from 'react';
import * as api from '../api';
import { initFirebaseClient, syncDocClient } from '../firebaseClient';

export default function SettingsPanel({ toast }) {
  // Password state
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passLoading, setPassLoading] = useState(false);

  // Firebase state
  const [firebaseConfig, setFirebaseConfig] = useState({
    apiKey: '',
    authDomain: '',
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: '',
  });
  const [fbLoading, setFbLoading] = useState(false);
  const [fbConnected, setFbConnected] = useState(false);

  // Load existing Firebase config
  useEffect(() => {
    api.fetchFirebaseConfig()
      .then(data => {
        if (data && data.config) {
          setFirebaseConfig(data.config);
          setFbConnected(!!data.connected);
          if (data.config.projectId && data.config.apiKey) {
            initFirebaseClient(data.config);
          }
        }
      })
      .catch(() => {});
  }, []);

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast('Mật khẩu mới xác nhận không khớp', 'error');
      return;
    }
    setPassLoading(true);
    try {
      const data = await api.changePassword(oldPassword, newPassword);
      if (data.ok) {
        // Server đã thu hồi mọi token → buộc đăng nhập lại bằng mật khẩu mới
        toast('Đã đổi mật khẩu — vui lòng đăng nhập lại', 'success');
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

  const handleSaveFirebase = async (e) => {
    e.preventDefault();
    setFbLoading(true);
    try {
      // 1. Initialize client-side Firebase
      initFirebaseClient(firebaseConfig);
      await syncDocClient('system_settings', 'config_info', {
        status: 'connected',
        updatedBy: 'client',
      });

      // 2. Save on server & trigger server-side sync
      const data = await api.saveFirebaseConfig(firebaseConfig);
      if (data.ok) {
        setFbConnected(!!data.connected);
        toast('Đã lưu cấu hình và đồng bộ Firebase thành công', 'success');
      } else {
        toast(data.error || 'Lỗi kết nối Firebase', 'error');
      }
    } catch {
      toast('Lỗi lưu Firebase', 'error');
    } finally {
      setFbLoading(false);
    }
  };

  return (
    <div className="two-col-grid">
      {/* Admin Password Management */}
      <div className="card">
        <div className="card-header">Bảo mật mật khẩu Admin</div>
        <div className="card-body">
          <form onSubmit={handleChangePassword}>
            <div className="form-group">
              <label>Mật khẩu Admin hiện tại</label>
              <input
                type="password"
                placeholder="Nhập mật khẩu cũ..."
                value={oldPassword}
                onChange={e => setOldPassword(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>Mật khẩu Admin mới</label>
              <input
                type="password"
                placeholder="Nhập mật khẩu mới..."
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>Xác nhận mật khẩu mới</label>
              <input
                type="password"
                placeholder="Nhập lại mật khẩu mới..."
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                required
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={passLoading}>
              {passLoading ? 'Đang lưu...' : 'Đổi mật khẩu Admin'}
            </button>
          </form>
        </div>
      </div>

      {/* Firebase Configuration & Tutorial */}
      <div className="card">
        <div className="card-header" style={{ justifyContent: 'space-between' }}>
          <span>Cấu hình Firebase Database</span>
          <span className={`session-badge ${fbConnected ? 'badge-completed' : 'badge-idle'}`}>
            {fbConnected ? 'Đã kết nối' : 'Chưa kết nối'}
          </span>
        </div>
        <div className="card-body">
          <form onSubmit={handleSaveFirebase}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label>API Key (apiKey)</label>
                <input
                  type="text"
                  placeholder="AIzaSy..."
                  value={firebaseConfig.apiKey}
                  onChange={e => setFirebaseConfig({ ...firebaseConfig, apiKey: e.target.value })}
                  required
                />
              </div>

              <div className="form-group">
                <label>Auth Domain (authDomain)</label>
                <input
                  type="text"
                  placeholder="project-id.firebaseapp.com"
                  value={firebaseConfig.authDomain}
                  onChange={e => setFirebaseConfig({ ...firebaseConfig, authDomain: e.target.value })}
                  required
                />
              </div>

              <div className="form-group">
                <label>Project ID (projectId)</label>
                <input
                  type="text"
                  placeholder="project-id"
                  value={firebaseConfig.projectId}
                  onChange={e => setFirebaseConfig({ ...firebaseConfig, projectId: e.target.value })}
                  required
                />
              </div>

              <div className="form-group">
                <label>Storage Bucket (storageBucket)</label>
                <input
                  type="text"
                  placeholder="project-id.appspot.com"
                  value={firebaseConfig.storageBucket}
                  onChange={e => setFirebaseConfig({ ...firebaseConfig, storageBucket: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>Messaging Sender ID</label>
                <input
                  type="text"
                  placeholder="1234567890..."
                  value={firebaseConfig.messagingSenderId}
                  onChange={e => setFirebaseConfig({ ...firebaseConfig, messagingSenderId: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>App ID (appId)</label>
                <input
                  type="text"
                  placeholder="1:123456:web:abcd..."
                  value={firebaseConfig.appId}
                  onChange={e => setFirebaseConfig({ ...firebaseConfig, appId: e.target.value })}
                  required
                />
              </div>
            </div>

            <button type="submit" className="btn btn-primary" disabled={fbLoading}>
              {fbLoading ? 'Đang lưu & test...' : 'Lưu cấu hình Firebase'}
            </button>
          </form>

          {/* Tutorial step by step */}
          <div className="tutorial">
            <h4>Hướng dẫn lấy tham số & mở quyền Firestore Database</h4>
            <ol>
              <li>Truy cập <b>console.firebase.google.com</b> → bấm <b>Add Project</b> tạo project mới.</li>
              <li>Tại trang chủ dự án, bấm biểu tượng Web <b>&lt;/&gt;</b> (Add app) để lấy mã Config.</li>
              <li>Vào menu <b>Build</b> → <b>Firestore Database</b> → bấm <b>Create Database</b>.</li>
              <li><b>Rất quan trọng</b>: Vào tab <b>Rules</b> của Firestore Database, sửa <code>allow read, write: if false;</code> thành <code>allow read, write: if true;</code> rồi bấm <b>Publish</b> thì mới cho phép tạo Data Collections!</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
