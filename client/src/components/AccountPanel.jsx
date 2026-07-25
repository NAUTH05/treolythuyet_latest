import { useState } from 'react';

export default function AccountPanel({ accounts, onRefresh, toast }) {
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleAdd = async () => {
    if (!email || !password) {
      toast('Cần nhập email và mật khẩu', 'error');
      return;
    }
    const base = import.meta.env.BASE_URL.replace(/\/$/, '');
    const res = await fetch(`${base}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || email, email, password }),
    });
    if (res.ok) {
      toast('Đã thêm tài khoản', 'success');
      setShowModal(false);
      setName(''); setEmail(''); setPassword('');
      onRefresh();
    } else {
      const err = await res.json();
      toast(err.error, 'error');
    }
  };

  const handleDelete = async (index) => {
    if (!window.confirm('Xóa tài khoản này?')) return;
    const base = import.meta.env.BASE_URL.replace(/\/$/, '');
    await fetch(`${base}/api/accounts/${index}`, { method: 'DELETE' });
    toast('Đã xóa tài khoản', 'info');
    onRefresh();
  };

  return (
    <>
      <div className="card">
        <div className="card-header" style={{ display: 'flex', alignItems: 'center' }}>
          Tài khoản
          <span style={{ marginLeft: 6, color: 'var(--text2)', fontWeight: 400 }}>({accounts.length})</span>
          <button className="btn btn-sm btn-outline" style={{ marginLeft: 'auto' }} onClick={() => setShowModal(true)}>
            + Thêm
          </button>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          {accounts.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">○</div>
              Chưa có tài khoản nào
            </div>
          ) : (
            <ul className="account-list">
              {accounts.map((a, i) => (
                <li key={a.index} className="account-item">
                  <div className="account-index">{i + 1}</div>
                  <div className="account-info">
                    <div className="account-name">{a.name}</div>
                    <div className="account-email">{a.email}</div>
                  </div>
                  <button className="btn btn-sm btn-danger account-delete" onClick={() => handleDelete(a.index)}>Xóa</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowModal(false)}>
          <div className="modal">
            <h3 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.3px', marginBottom: 20 }}>Thêm tài khoản</h3>
            <div className="form-group">
              <label>Tên hiển thị</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="VD: Nguyễn Văn A" />
            </div>
            <div className="form-group">
              <label>Email đăng nhập</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="email@example.com" />
            </div>
            <div className="form-group">
              <label>Mật khẩu</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
              />
            </div>
            <div className="btn-group">
              <button className="btn btn-primary" onClick={handleAdd}>Thêm</button>
              <button className="btn btn-outline" onClick={() => setShowModal(false)}>Hủy</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
