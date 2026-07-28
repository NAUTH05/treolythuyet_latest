import { useState } from 'react';
import * as api from '../api';

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
    const res = await api.addAccount({ name: name || email, email, password });
    if (res && res.error) {
      toast(res.error, 'error');
    } else {
      toast('Đã thêm tài khoản', 'success');
      setShowModal(false);
      setName(''); setEmail(''); setPassword('');
      onRefresh();
    }
  };

  const handleDelete = async (index) => {
    if (!window.confirm('Xóa tài khoản này?')) return;
    await api.deleteAccount(index);
    toast('Đã xóa tài khoản', 'info');
    onRefresh();
  };

  return (
    <>
      <div className="card">
        <div className="card-header">
          Tài khoản
          <span className="count-pill">{accounts.length}</span>
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
            <h3 className="modal-title" style={{ marginBottom: 20 }}>Thêm tài khoản</h3>
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
