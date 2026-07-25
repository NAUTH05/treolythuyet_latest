import { useState, useEffect } from 'react';
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
    databaseURL: '',
  });
  const [fbLoading, setFbLoading] = useState(false);
  const [fbConnected, setFbConnected] = useState(false);

  // Load existing Firebase config
  useEffect(() => {
    fetch('/lythuyet/api/admin/firebase-config')
      .then(res => res.json())
      .then(data => {
        if (data.config) {
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
      toast('❌ Mật khẩu mới xác nhận không khớp', 'error');
      return;
    }
    setPassLoading(true);
    try {
      const res = await fetch('/lythuyet/api/admin/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const data = await res.json();
      if (data.ok) {
        toast('✅ Đã đổi mật khẩu Admin thành công', 'success');
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        toast(`❌ ${data.error || 'Lỗi đổi mật khẩu'}`, 'error');
      }
    } catch {
      toast('❌ Lỗi kết nối máy chủ', 'error');
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
      const res = await fetch('/lythuyet/api/admin/firebase-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: firebaseConfig }),
      });
      const data = await res.json();
      if (data.ok) {
        setFbConnected(!!data.connected);
        toast('🔥 Đã lưu cấu hình và đồng bộ Firebase thành công!', 'success');
      } else {
        toast(`❌ ${data.error || 'Lỗi kết nối Firebase'}`, 'error');
      }
    } catch {
      toast('❌ Lỗi lưu Firebase', 'error');
    } finally {
      setFbLoading(false);
    }
  };

  return (
    <div className="settings-container" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
      {/* Admin Password Management */}
      <div className="card">
        <div className="card-header">🔑 Bảo Mật Mật Khẩu Admin</div>
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
              {passLoading ? '⏳ Đang lưu...' : '💾 Đổi Mật Khẩu Admin'}
            </button>
          </form>
        </div>
      </div>

      {/* Firebase Configuration & Tutorial */}
      <div className="card">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>🔥 Cấu Hình Firebase Database</span>
          <span className={`session-badge ${fbConnected ? 'badge-completed' : 'badge-idle'}`}>
            {fbConnected ? '✅ Đã kết nối Firebase' : '⚪ Chưa kết nối'}
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

            <div className="form-group">
              <label>Database URL (tùy chọn - nếu dùng Realtime DB)</label>
              <input
                type="url"
                placeholder="https://project-id-default-rtdb.firebaseio.com"
                value={firebaseConfig.databaseURL}
                onChange={e => setFirebaseConfig({ ...firebaseConfig, databaseURL: e.target.value })}
              />
            </div>

            <button type="submit" className="btn btn-primary" disabled={fbLoading}>
              {fbLoading ? '⏳ Đang lưu & test...' : '🔥 Lưu Cấu Hình Firebase'}
            </button>
          </form>

          {/* Tutorial step by step */}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text2)' }}>
            <h4 style={{ color: 'var(--primary)', marginBottom: 8, fontSize: 13 }}>📖 Hướng dẫn lấy tham số & Mở quyền Firestore Database:</h4>
            <ol style={{ paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
              <li>Truy cập <b>console.firebase.google.com</b> $\rightarrow$ Bấm <b>Add Project</b> tạo project mới.</li>
              <li>Tại trang chủ dự án, bấm biểu tượng Web <b>&lt;/&gt;</b> (Add app) để lấy mã Config.</li>
              <li>Vào menu <b>Build</b> $\rightarrow$ <b>Firestore Database</b> $\rightarrow$ Bấm <b>Create Database</b>.</li>
              <li><b>Rất quan trọng</b>: Vào tab <b>Rules</b> của Firestore Database, sửa <code>allow read, write: if false;</code> thành <code>allow read, write: if true;</code> rồi bấm <b>Publish</b> thì mới cho phép tạo Data Collections!</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
