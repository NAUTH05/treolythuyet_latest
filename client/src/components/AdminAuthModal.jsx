import { useState } from 'react';

export default function AdminAuthModal({ onVerify }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!password) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (data.ok && data.token) {
        onVerify(data.token);
      } else {
        setError(data.error || 'Mật khẩu Admin không chính xác');
      }
    } catch {
      setError('Lỗi kết nối máy chủ');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="admin-lock-overlay">
      <div className="admin-lock-card">
        <div className="admin-lock-header">
          <div className="admin-lock-icon">◉</div>
          <h2>Xác Thực Admin</h2>
          <p>Nhập mật khẩu Admin để truy cập hệ thống Treo Học Lý Thuyết.</p>
        </div>

        <form onSubmit={handleSubmit} className="admin-lock-form">
          {error && <div className="admin-lock-error">{error}</div>}

          <div className="form-group">
            <label>Mật khẩu Admin</label>
            <input
              type="password"
              placeholder="Nhập mật khẩu..."
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </div>

          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {loading ? 'Đang kiểm tra...' : 'Đăng Nhập'}
          </button>
        </form>

        <div className="admin-lock-footer">
          <span>Gợi ý mặc định: <code>admin123</code> (Có thể đổi trong Cài đặt)</span>
        </div>
      </div>
    </div>
  );
}
