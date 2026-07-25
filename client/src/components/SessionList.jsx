import { useState, useMemo } from 'react';
import * as api from '../api';

const BADGE_CLASS = {
  running: 'badge-running',
  'logging-in': 'badge-logging-in',
  completed: 'badge-completed',
  error: 'badge-error',
};

const STATUS_TEXT = {
  idle: 'Chờ',
  'logging-in': 'Đang login',
  running: 'Đang chạy',
  completed: 'Hoàn thành',
  error: 'Lỗi',
};

function SessionCard({ session, toast }) {
  const progress = (session.progress || 0).toFixed(1);
  const badgeClass = BADGE_CLASS[session.status] || 'badge-idle';
  const statusText = STATUS_TEXT[session.status] || session.status;

  const handleStop = async () => {
    await api.stopSession(session.id);
    toast('Đã gửi lệnh dừng phiên', 'info');
  };

  const handleRefresh = async () => {
    await api.refreshSession(session.id);
    toast('Đã gửi lệnh F5', 'info');
  };

  return (
    <div className="session-card">
      <div className="progress-bg" style={{ width: `${progress}%` }} />

      <div className="session-header">
        <span className="session-name">{session.account}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={`session-badge ${badgeClass}`}>{statusText}</span>
          {session.status === 'running' && (
            <button className="btn btn-sm btn-outline" onClick={handleRefresh}>F5</button>
          )}
          {(session.status === 'running' || session.status === 'logging-in') && (
            <button className="btn btn-sm btn-danger" onClick={handleStop}>■</button>
          )}
        </div>
      </div>

      <div className="progress-bar">
        <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
      </div>

      <div className="session-stats">
        <div className="stat">
          <div className="stat-value">{progress}%</div>
          <div className="stat-label">Tiến độ</div>
        </div>
        <div className="stat">
          <div className="stat-value">{session.elapsed || '0h 0m 0s'}</div>
          <div className="stat-label">Đã treo</div>
        </div>
        <div className="stat">
          <div className="stat-value">{session.remaining || '-'}</div>
          <div className="stat-label">Còn lại</div>
        </div>
        <div className="stat">
          <div className="stat-value">{session.refreshCount || 0}</div>
          <div className="stat-label">Refresh</div>
        </div>
      </div>

      {session.error && (
        <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>{session.error}</div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text2)', wordBreak: 'break-all', marginTop: 4 }}>
        Bài {(session.currentLessonIndex || 0) + 1}/{session.totalLessons || 1}: {session.currentUrl || ''}
      </div>
    </div>
  );
}

const QUEUE_STATUS = {
  running: { text: 'Đang chạy', color: '#2e7fc1', badge: 'badge-running' },
  waiting: { text: 'Đang chờ', color: '#a0660a', badge: 'badge-logging-in' },
  completed: { text: 'Hoàn thành', color: '#1a6640', badge: 'badge-completed' },
  cancelled: { text: 'Đã hủy', color: '#888', badge: 'badge-idle' },
  error: { text: 'Lỗi', color: '#b83232', badge: 'badge-error' },
};

function formatCompletedAt(isoStr, status) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  const timeStr = d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
  if (status === 'completed') return { icon: '✅', label: 'Hoàn thành lúc', time: timeStr, color: '#66bb6a' };
  if (status === 'cancelled') return { icon: '✕', label: 'Đã hủy lúc', time: timeStr, color: '#999' };
  if (status === 'error') return { icon: '❌', label: 'Lỗi lúc', time: timeStr, color: '#e74c3c' };
  return null;
}

function QueueCard({ queue, onCancel, onRush, onAddPairs }) {
  const info = QUEUE_STATUS[queue.status] || QUEUE_STATUS.running;
  const isActive = queue.status === 'running' || queue.status === 'waiting';

  return (
    <div style={{
      border: `1px solid ${info.color}33`,
      borderRadius: 10,
      padding: 14,
      marginBottom: 10,
      background: `${info.color}08`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>📋 {queue.account}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span className={`session-badge ${info.badge}`}>{info.text}</span>
          {queue.status === 'waiting' && (
            <button className="btn btn-sm" style={{ background: '#f0ad4e', color: '#000', fontWeight: 600 }} onClick={() => onRush(queue.id)}>⚡ Đôn</button>
          )}
          <button className="btn btn-sm btn-outline" onClick={() => onAddPairs(queue.id)}>➕ Thêm</button>
          <button className="btn btn-sm btn-danger" onClick={() => onCancel(queue.id)}>✕ Hủy</button>
        </div>
      </div>

      <div style={{ fontSize: 13, marginBottom: 8, color: 'var(--text2)' }}>
        Box <strong style={{ color: 'var(--text)' }}>{queue.currentPairIndex + 1}</strong> / {queue.totalPairs}
        {(queue.randomStartMin != null && queue.randomStartMax != null && queue.randomStartMax > queue.randomStartMin) && (
          <span style={{ marginLeft: 8, fontSize: 11, color: '#a78bfa' }}>🎲 +{queue.randomStartMin}–{queue.randomStartMax}m</span>
        )}
      </div>

      <div style={{ fontSize: 12, color: 'var(--text2)', borderLeft: '2px solid var(--border)', paddingLeft: 10 }}>
        {queue.pairs.map((pair, i) => {
          const isCurrent = i === queue.currentPairIndex;
          const isDone = i < queue.currentPairIndex;
          const icon = isDone ? '✅' : isCurrent ? '▶️' : '⏳';
          const name1 = (pair.urls ? pair.urls[0]?.url : pair.url1 || '')?.split('/').pop() || '?';
          const url2 = pair.urls ? pair.urls[1]?.url : pair.url2;
          const name2 = url2?.split('/').pop();
          return (
            <div key={i} style={{ padding: '3px 0', color: isCurrent ? 'var(--primary)' : isDone ? '#66bb6a' : 'var(--text2)', fontWeight: isCurrent ? 600 : 400 }}>
              {icon} Box {i + 1}: {name1} {name2 ? `+ ${name2}` : ''}
              {pair.scheduledDateTime && (
                <span style={{ marginLeft: 8, fontSize: 11, color: '#f0ad4e' }}>
                  📅 Hẹn {new Date(pair.scheduledDateTime).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddPairsModal({ queueId, onClose, onSubmit }) {
  const [pairs, setPairs] = useState([{ url1: '', url2: '' }]);

  const updatePair = (i, field, val) => {
    setPairs(prev => {
      const next = [...prev];
      next[i] = { ...next[i], [field]: val };
      return next;
    });
  };

  const addPair = () => setPairs(prev => [...prev, { url1: '', url2: '' }]);
  const removePair = (i) => setPairs(prev => prev.filter((_, idx) => idx !== i));

  const handleSubmit = () => {
    const valid = pairs.filter(p => p.url1?.trim()).map(p => ({
      urls: [{ url: p.url1.trim() }, ...(p.url2?.trim() ? [{ url: p.url2.trim() }] : [])]
    }));
    if (valid.length === 0) return;
    onSubmit(queueId, valid);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" style={{ width: '90%', maxWidth: 500, padding: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 14 }}>➕ Thêm Box Bài Học VÀO HÀNG CHỜ</div>

        {pairs.map((p, i) => (
          <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
              <span>Box {i + 1}</span>
              {pairs.length > 1 && <button className="btn btn-sm btn-danger" onClick={() => removePair(i)}>✕</button>}
            </div>
            <input type="url" placeholder="URL bài 1 *" value={p.url1} onChange={e => updatePair(i, 'url1', e.target.value)} style={{ width: '100%', marginBottom: 6 }} />
            <input type="url" placeholder="URL bài 2 (tùy chọn)" value={p.url2} onChange={e => updatePair(i, 'url2', e.target.value)} style={{ width: '100%' }} />
          </div>
        ))}

        <button className="btn btn-outline" style={{ width: '100%', marginBottom: 12 }} onClick={addPair}>+ Thêm một cặp nữa</button>

        <div className="btn-group">
          <button className="btn btn-primary" onClick={handleSubmit}
            disabled={!pairs.some(p => p.url1?.trim())}>Lưu vào hàng chờ</button>
          <button className="btn btn-outline" onClick={onClose}>Hủy</button>
        </div>
      </div>
    </div>
  );
}

export default function SessionList({ sessions, queues, toast }) {
  const sessionEntries = Object.values(sessions || {});
  const queueEntries = Object.values(queues || {});

  const [filterAccount, setFilterAccount] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [addPairsId, setAddPairsId] = useState(null);

  // Extract list of all account names across sessions & queues
  const allAccounts = useMemo(() => {
    const set = new Set();
    sessionEntries.forEach(s => s.account && set.add(s.account));
    queueEntries.forEach(q => q.account && set.add(q.account));
    return [...set].sort();
  }, [sessionEntries, queueEntries]);

  // Filtered Sessions
  const filteredSessions = useMemo(() => {
    return sessionEntries.filter(s => {
      if (filterAccount && s.account !== filterAccount) return false;
      if (filterStatus) {
        if (filterStatus === 'running' && s.status !== 'running' && s.status !== 'logging-in') return false;
        if (filterStatus === 'completed' && s.status !== 'completed') return false;
        if (filterStatus === 'error' && s.status !== 'error') return false;
      }
      return true;
    });
  }, [sessionEntries, filterAccount, filterStatus]);

  // Filtered Queues
  const filteredQueues = useMemo(() => {
    return queueEntries.filter(q => {
      if (filterAccount && q.account !== filterAccount) return false;
      if (filterStatus) {
        if (filterStatus === 'running' && q.status !== 'running') return false;
        if (filterStatus === 'waiting' && q.status !== 'waiting') return false;
        if (filterStatus === 'completed' && q.status !== 'completed') return false;
        if (filterStatus === 'error' && q.status !== 'error' && q.status !== 'cancelled') return false;
      }
      return true;
    });
  }, [queueEntries, filterAccount, filterStatus]);

  const activeQueues = filteredQueues.filter(q => q.status === 'running' || q.status === 'waiting');
  const doneQueues = filteredQueues.filter(q => q.status === 'completed' || q.status === 'cancelled' || q.status === 'error');

  const handleCancelQueue = async (queueId) => {
    await api.cancelQueue(queueId);
    toast('Đã hủy hàng chờ', 'info');
  };

  const handleRushQueue = async (queueId) => {
    await api.rushQueue(queueId);
    toast('Đã đôn hàng chờ — chạy ngay!', 'success');
  };

  const handleAddPairs = (queueId) => setAddPairsId(queueId);

  const handleSubmitAddPairs = async (queueId, pairs) => {
    const res = await api.addPairsToQueue(queueId, pairs);
    if (res.ok) {
      toast(`➕ Đã thêm ${pairs.length} cặp (tổng: ${res.totalPairs})`, 'success');
      setAddPairsId(null);
    } else {
      toast(`❌ ${res.error}`, 'error');
    }
  };

  const queueCardProps = { onCancel: handleCancelQueue, onRush: handleRushQueue, onAddPairs: handleAddPairs };

  return (
    <>
      {addPairsId && (
        <AddPairsModal
          queueId={addPairsId}
          onClose={() => setAddPairsId(null)}
          onSubmit={handleSubmitAddPairs}
        />
      )}

      {/* Filter Control Bar for Queues & Sessions */}
      <div className="card" style={{ gridColumn: '1/-1', marginBottom: -8 }}>
        <div className="card-body" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)' }}>🔍 Lọc theo Tài khoản:</span>
          
          <select
            value={filterAccount}
            onChange={e => setFilterAccount(e.target.value)}
            style={{
              padding: '6px 12px',
              background: 'var(--surface2)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              color: 'var(--text)',
              fontSize: '13px',
              cursor: 'pointer',
              outline: 'none',
              minWidth: '180px',
            }}
          >
            <option value="">👤 Tất cả tài khoản ({allAccounts.length})</option>
            {allAccounts.map(acc => (
              <option key={acc} value={acc}>👤 {acc}</option>
            ))}
          </select>

          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginLeft: 8 }}>Trạng thái:</span>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            style={{
              padding: '6px 12px',
              background: 'var(--surface2)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              color: 'var(--text)',
              fontSize: '13px',
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            <option value="">⚡ Tất cả trạng thái</option>
            <option value="running">▶️ Đang chạy (Running)</option>
            <option value="waiting">⏳ Đang chờ (Waiting)</option>
            <option value="completed">✅ Hoàn thành (Completed)</option>
            <option value="error">❌ Lỗi / Đã hủy (Error/Cancelled)</option>
          </select>

          {(filterAccount || filterStatus) && (
            <button
              className="btn btn-sm btn-outline"
              onClick={() => {
                setFilterAccount('');
                setFilterStatus('');
              }}
              style={{ fontSize: 12, padding: '4px 10px' }}
            >
              🔄 Hiển thị tất cả
            </button>
          )}
        </div>
      </div>

      {/* Active Sessions */}
      <div className="card" style={{ gridColumn: '1/-1' }}>
        <div className="card-header">
          Phiên đang chạy
          {filteredSessions.length > 0 && (
            <span style={{ marginLeft: 8, background: 'var(--primary)', color: '#fff', borderRadius: 10, padding: '1px 8px', fontSize: 11 }}>
              {filteredSessions.length}
            </span>
          )}
        </div>
        <div className="card-body">
          {filteredSessions.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">😴</div>
              {filterAccount ? `Tài khoản ${filterAccount} chưa có phiên nào đang chạy` : 'Chưa có phiên nào đang chạy'}
            </div>
          ) : (
            filteredSessions.map(s => <SessionCard key={s.id} session={s} toast={toast} />)
          )}
        </div>
      </div>

      {/* Queues List */}
      <div className="card" style={{ gridColumn: '1/-1' }}>
        <div className="card-header">
          Hàng chờ Box bài học
          {activeQueues.length > 0 && (
            <span style={{ marginLeft: 8, background: 'var(--primary)', color: '#fff', borderRadius: 10, padding: '1px 8px', fontSize: 11 }}>{activeQueues.length}</span>
          )}
        </div>
        <div className="card-body">
          {filteredQueues.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">📭</div>
              {filterAccount ? `Tài khoản ${filterAccount} chưa có hàng chờ nào` : 'Chưa có hàng chờ'}
            </div>
          ) : (
            <>
              {activeQueues.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
                    ⚡ Đang hoạt động ({activeQueues.length})
                  </div>
                  {activeQueues.map(q => <QueueCard key={q.id} queue={q} {...queueCardProps} />)}
                </div>
              )}

              {doneQueues.length > 0 && (
                <div style={{ marginTop: activeQueues.length > 0 ? 16 : 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
                    ✅ Đã hoàn thành / Kết thúc ({doneQueues.length})
                  </div>
                  {doneQueues.map(q => <QueueCard key={q.id} queue={q} {...queueCardProps} />)}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
