import { useState } from 'react';
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
  const [expanded, setExpanded] = useState(false);

  const comp = !isActive ? formatCompletedAt(queue.completedAt, queue.status) : null;

  // ── COMPACT ROW (done queues) ──────────────────────────────
  if (!isActive) {
    const pairLabel = `${queue.totalPairs} box`;
    return (
      <div style={{
        border: '1px solid var(--border)',
        borderRadius: 4,
        marginBottom: 4,
        background: 'var(--surface)',
        overflow: 'hidden',
      }}>
        {/* Header row */}
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', cursor: 'pointer' }}
          onClick={() => setExpanded(e => !e)}
        >
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {queue.account}
          </span>
          <span className={`session-badge ${info.badge}`} style={{ fontSize: 11, padding: '1px 7px', flexShrink: 0 }}>{info.text}</span>
          <span style={{ fontSize: 11, color: 'var(--text2)', flexShrink: 0 }}>{pairLabel}</span>
          {comp && (
            <span style={{ fontSize: 11, color: comp.color, flexShrink: 0 }}>{comp.time}</span>
          )}
          <span style={{ fontSize: 12, color: 'var(--text2)', flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
        </div>

        {/* Expandable detail */}
        {expanded && (
          <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px', fontSize: 12, color: 'var(--text2)' }}>
            {queue.pairs.map((pair, i) => {
              const isDone = i < queue.currentPairIndex || queue.status === 'completed';
              const isCancelled = queue.status === 'cancelled' || queue.status === 'error';
              const icon = isDone && !isCancelled ? '✅' : isCancelled ? '—' : '✅';
              const name1 = (pair.urls ? pair.urls[0]?.url : pair.url1 || '')?.split('/').pop() || '?';
              const url2 = pair.urls ? pair.urls[1]?.url : pair.url2;
              const name2 = url2?.split('/').pop();
              return (
                <div key={i} style={{ padding: '2px 0' }}>
                  {icon} Box {i + 1}: {name1}{name2 ? ` + ${name2}` : ''}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── FULL CARD (active queues) ──────────────────────────────
  return (
    <div style={{
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${info.color}`,
      borderRadius: 4,
      padding: 14,
      marginBottom: 10,
      background: 'var(--surface)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: '-0.2px' }}>{queue.account}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span className={`session-badge ${info.badge}`}>{info.text}</span>
          {queue.status === 'waiting' && (
            <button className="btn btn-sm btn-outline" style={{ borderColor: '#a0660a', color: '#a0660a' }} onClick={() => onRush(queue.id)}>Đôn</button>
          )}
          <button className="btn btn-sm btn-outline" onClick={() => onAddPairs(queue.id)}>➕ Thêm</button>
          <button className="btn btn-sm btn-danger" onClick={() => onCancel(queue.id)}>✕ Hủy</button>
        </div>
      </div>

      <div style={{ fontSize: 13, marginBottom: 8, color: 'var(--text2)' }}>
        Box <strong style={{ color: 'var(--text)' }}>{queue.currentPairIndex + 1}</strong> / {queue.totalPairs}
        {(queue.randomStartMin != null && queue.randomStartMax != null && queue.randomStartMax > queue.randomStartMin) && (
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text2)' }}>+{queue.randomStartMin}–{queue.randomStartMax}m random</span>
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
            <div key={i} style={{ padding: '3px 0', color: isCurrent ? 'var(--primary)' : isDone ? 'var(--success)' : 'var(--text2)', fontWeight: isCurrent ? 600 : 400 }}>
              {icon} Box {i + 1}: {name1}{name2 ? ` + ${name2}` : ''}
            </div>
          );
        })}
      </div>

      {queue.nextRunTime && (
        <div style={{ marginTop: 8, padding: '6px 10px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12 }}>
          Chạy lúc: <strong>{new Date(queue.nextRunTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</strong>
        </div>
      )}
    </div>
  );
}

function AddPairsModal({ queueId, onClose, onSubmit }) {
  const [pairs, setPairs] = useState([{ url1: '', url2: '' }]);

  const updatePair = (i, field, val) =>
    setPairs(prev => { const n = [...prev]; n[i] = { ...n[i], [field]: val }; return n; });

  const addPair = () => setPairs(prev => [...prev, { url1: '', url2: '' }]);
  const removePair = (i) => pairs.length > 1 && setPairs(prev => prev.filter((_, j) => j !== i));

  const handleSubmit = () => {
    const valid = pairs.filter(p => p.url1?.trim());
    if (!valid.length) return;
    onSubmit(queueId, valid);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480, width: '90vw' }} onClick={e => e.stopPropagation()}>
        <h3 style={{ marginBottom: 6, fontSize: 16, fontWeight: 700, letterSpacing: '-0.3px' }}>Thêm cặp bài học</h3>
        <p style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 16 }}>
          Cặp mới sẽ được xếp vào cuối hàng chờ của tài khoản này
        </p>

        {pairs.map((pair, i) => (
          <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: 10, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text2)' }}>Cặp {i + 1}</span>
              {pairs.length > 1 && (
                <button className="btn btn-sm btn-danger" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => removePair(i)}>✕</button>
              )}
            </div>
            <input type="url" placeholder="Link bài 1 (bắt buộc)" value={pair.url1}
              onChange={e => updatePair(i, 'url1', e.target.value)}
              style={{ marginBottom: 6, width: '100%', padding: '8px 10px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
            <input type="url" placeholder="Link bài 2 (tùy chọn)" value={pair.url2}
              onChange={e => updatePair(i, 'url2', e.target.value)}
              style={{ width: '100%', padding: '8px 10px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
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
  const sessionEntries = Object.values(sessions);
  const queueEntries = Object.values(queues || {});

  const activeQueues = queueEntries.filter(q => q.status === 'running' || q.status === 'waiting');
  const doneQueues = queueEntries.filter(q => q.status === 'completed' || q.status === 'cancelled' || q.status === 'error');

  const [addPairsId, setAddPairsId] = useState(null);

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

      <div className="card" style={{ gridColumn: '1/-1' }}>
        <div className="card-header">Phiên đang chạy</div>
        <div className="card-body">
          {sessionEntries.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">😴</div>
              Chưa có phiên nào đang chạy
            </div>
          ) : (
            sessionEntries.map(s => <SessionCard key={s.id} session={s} toast={toast} />)
          )}
        </div>
      </div>

      <div className="card" style={{ gridColumn: '1/-1' }}>
        <div className="card-header">
          Hàng chờ cặp bài
          {activeQueues.length > 0 && (
            <span style={{ marginLeft: 8, background: 'var(--primary)', color: '#fff', borderRadius: 10, padding: '1px 8px', fontSize: 11 }}>{activeQueues.length}</span>
          )}
        </div>
        <div className="card-body">
          {queueEntries.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">📭</div>
              Chưa có hàng chờ
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
                    ✅ Đã hoàn thành ({doneQueues.length})
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
