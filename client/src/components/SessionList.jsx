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
        <div className="session-actions">
          <span className={`session-badge ${badgeClass}`}>{statusText}</span>
          {session.status === 'running' && (
            <button className="btn btn-sm btn-outline" onClick={handleRefresh}>F5</button>
          )}
          {(session.status === 'running' || session.status === 'logging-in') && (
            <button className="btn btn-sm btn-danger" onClick={handleStop}>Dừng</button>
          )}
        </div>
      </div>

      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${progress}%` }} />
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
        <div className="session-error">{session.error}</div>
      )}
      <div className="session-meta">
        Bài {(session.currentLessonIndex || 0) + 1}/{session.totalLessons || 1}: {session.currentUrl || ''}
      </div>
    </div>
  );
}

const QUEUE_STATUS = {
  running: { text: 'Đang chạy', cls: 'q-running', badge: 'badge-running' },
  waiting: { text: 'Đang chờ', cls: 'q-waiting', badge: 'badge-logging-in' },
  completed: { text: 'Hoàn thành', cls: 'q-completed', badge: 'badge-completed' },
  cancelled: { text: 'Đã hủy', cls: 'q-cancelled', badge: 'badge-idle' },
  error: { text: 'Lỗi', cls: 'q-error', badge: 'badge-error' },
};

function QueueCard({ queue, onCancel, onDelete, onRush, onAddPairs }) {
  const info = QUEUE_STATUS[queue.status] || QUEUE_STATUS.running;
  const isEnded = queue.status === 'completed' || queue.status === 'cancelled' || queue.status === 'error';

  return (
    <div className={`queue-card ${info.cls}`}>
      <div className="queue-card-header">
        <span className="queue-card-name">{queue.account}</span>
        <div className="session-actions">
          <span className={`session-badge ${info.badge}`}>{info.text}</span>
          {queue.status === 'waiting' && (
            <button className="btn btn-sm btn-warning" onClick={() => onRush(queue.id)}>Đôn lên chạy ngay</button>
          )}
          {!isEnded && (
            <>
              <button className="btn btn-sm btn-outline" onClick={() => onAddPairs(queue.id)}>+ Thêm</button>
              <button className="btn btn-sm btn-danger" onClick={() => onCancel(queue.id)}>Hủy</button>
            </>
          )}
          {isEnded && (
            <button className="btn btn-sm btn-ghost" onClick={() => onDelete(queue.id)} title="Xóa thẻ hàng chờ này">Xóa</button>
          )}
        </div>
      </div>

      <div className="queue-card-meta">
        Box <strong>{queue.currentPairIndex + 1}</strong> / {queue.totalPairs}
        {(queue.randomStartMin != null && queue.randomStartMax != null && queue.randomStartMax > queue.randomStartMin) && (
          <span className="queue-tag">Random +{queue.randomStartMin}–{queue.randomStartMax}m</span>
        )}
      </div>

      <div className="queue-steps">
        {queue.pairs.map((pair, i) => {
          const isCurrent = i === queue.currentPairIndex;
          const isDone = i < queue.currentPairIndex;
          const stateClass = isDone ? 'done' : isCurrent ? 'current' : '';
          const glyph = isDone ? '✓' : isCurrent ? '▸' : '·';
          const name1 = (pair.urls ? pair.urls[0]?.url : pair.url1 || '')?.split('/').pop() || '?';
          const url2 = pair.urls ? pair.urls[1]?.url : pair.url2;
          const name2 = url2?.split('/').pop();
          return (
            <div key={i} className={`queue-step ${stateClass}`}>
              <span className="step-glyph">{glyph}</span>
              <span>Box {i + 1}: {name1} {name2 ? `+ ${name2}` : ''}</span>
              {pair.scheduledDateTime && (
                <span className="step-schedule">
                  Hẹn {new Date(pair.scheduledDateTime).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}
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
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 500 }}>
        <div className="modal-title">Thêm Box bài học vào hàng chờ</div>

        {pairs.map((p, i) => (
          <div key={i} className="box-card">
            <div className="box-card-header">
              <span className="box-card-title">
                <span className="box-card-index">{i + 1}</span>
                Box {i + 1}
              </span>
              {pairs.length > 1 && <button className="icon-btn" onClick={() => removePair(i)} title="Xóa box này">✕</button>}
            </div>
            <input type="url" placeholder="URL bài 1 *" value={p.url1} onChange={e => updatePair(i, 'url1', e.target.value)} style={{ width: '100%', marginBottom: 6 }} />
            <input type="url" placeholder="URL bài 2 (tùy chọn)" value={p.url2} onChange={e => updatePair(i, 'url2', e.target.value)} style={{ width: '100%' }} />
          </div>
        ))}

        <button className="btn btn-outline btn-block" style={{ marginBottom: 12 }} onClick={addPair}>+ Thêm một cặp nữa</button>

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

  const handleDeleteQueue = async (queueId) => {
    await api.deleteQueue(queueId);
    toast('Đã xóa thẻ hàng chờ', 'info');
  };

  const handleClearCompletedQueues = async () => {
    if (!window.confirm('Xóa tất cả hàng chờ đã hoàn thành / kết thúc / lỗi?')) return;
    const res = await api.clearCompletedQueues();
    if (res.ok) {
      toast(`Đã xóa ${res.count} hàng chờ đã xong`, 'success');
    }
  };

  const handleRushQueue = async (queueId) => {
    await api.rushQueue(queueId);
    toast('Đã đôn hàng chờ — chạy ngay!', 'success');
  };

  const handleAddPairs = (queueId) => setAddPairsId(queueId);

  const handleSubmitAddPairs = async (queueId, pairs) => {
    const res = await api.addPairsToQueue(queueId, pairs);
    if (res.ok) {
      toast(`Đã thêm ${pairs.length} cặp (tổng: ${res.totalPairs})`, 'success');
      setAddPairsId(null);
    } else {
      toast(res.error || 'Lỗi thêm cặp bài học', 'error');
    }
  };

  const queueCardProps = { onCancel: handleCancelQueue, onDelete: handleDeleteQueue, onRush: handleRushQueue, onAddPairs: handleAddPairs };

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
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-body filter-bar" style={{ padding: '12px 16px' }}>
          <span className="filter-label">Lọc theo tài khoản</span>
          <select
            value={filterAccount}
            onChange={e => setFilterAccount(e.target.value)}
            style={{ minWidth: 180 }}
          >
            <option value="">Tất cả tài khoản ({allAccounts.length})</option>
            {allAccounts.map(acc => (
              <option key={acc} value={acc}>{acc}</option>
            ))}
          </select>

          <span className="filter-label">Trạng thái</span>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
          >
            <option value="">Tất cả trạng thái</option>
            <option value="running">Đang chạy</option>
            <option value="waiting">Đang chờ</option>
            <option value="completed">Hoàn thành</option>
            <option value="error">Lỗi / Đã hủy</option>
          </select>

          {(filterAccount || filterStatus) && (
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setFilterAccount('');
                setFilterStatus('');
              }}
            >
              Hiển thị tất cả
            </button>
          )}
        </div>
      </div>

      {/* Active Sessions */}
      <div className="card">
        <div className="card-header">
          Phiên đang chạy
          {filteredSessions.length > 0 && (
            <span className="count-pill">{filteredSessions.length}</span>
          )}
        </div>
        <div className="card-body">
          {filteredSessions.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">◌</div>
              {filterAccount ? `Tài khoản ${filterAccount} chưa có phiên nào đang chạy` : 'Chưa có phiên nào đang chạy'}
            </div>
          ) : (
            filteredSessions.map(s => <SessionCard key={s.id} session={s} toast={toast} />)
          )}
        </div>
      </div>

      {/* Queues List */}
      <div className="card">
        <div className="card-header" style={{ justifyContent: 'space-between' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            Hàng chờ Box bài học
            {activeQueues.length > 0 && (
              <span className="count-pill">{activeQueues.length}</span>
            )}
          </span>

          {doneQueues.length > 0 && (
            <button
              className="btn btn-xs btn-danger"
              onClick={handleClearCompletedQueues}
            >
              Xóa tất cả đã xong ({doneQueues.length})
            </button>
          )}
        </div>

        <div className="card-body">
          {filteredQueues.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">≡</div>
              {filterAccount ? `Tài khoản ${filterAccount} chưa có hàng chờ nào` : 'Chưa có hàng chờ'}
            </div>
          ) : (
            <>
              {activeQueues.length > 0 && (
                <div>
                  <div className="section-label">
                    <span>Đang hoạt động ({activeQueues.length})</span>
                  </div>
                  {activeQueues.map(q => <QueueCard key={q.id} queue={q} {...queueCardProps} />)}
                </div>
              )}

              {doneQueues.length > 0 && (
                <div style={{ marginTop: activeQueues.length > 0 ? 16 : 0 }}>
                  <div className="section-label">
                    <span>Đã hoàn thành / Kết thúc ({doneQueues.length})</span>
                    <button
                      className="btn btn-xs btn-danger"
                      onClick={handleClearCompletedQueues}
                    >
                      Xóa tất cả
                    </button>
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
