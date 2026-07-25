import { useEffect, useState } from 'react';

const STORAGE_KEY = 'treohoc_settings';
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}

export default function ControlPanel({ accounts, onStart }) {
  const [saved] = useState(loadSettings);
  const [pairs, setPairs] = useState(saved.pairs?.length ? saved.pairs : [{ url1: '', url2: '' }]);
  const [startHour, setStartHour] = useState(saved.startHour ?? 7);
  const [time, setTime] = useState(saved.time ?? 240);
  const [refreshInterval, setRefreshInterval] = useState(saved.refreshInterval ?? 15);
  const [stealthInterval, setStealthInterval] = useState(saved.stealthInterval ?? 30);
  const [randomStart, setRandomStart] = useState(saved.randomStart ?? false);
  const [randomStartMin, setRandomStartMin] = useState(saved.randomStartMin ?? 0);
  const [randomStartMax, setRandomStartMax] = useState(saved.randomStartMax ?? 30);
  const [selected, setSelected] = useState(new Set());
  const [scheduleMode, setScheduleMode] = useState(saved.scheduleMode || 'now');
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleTime, setScheduleTime] = useState(saved.scheduleTime || '07:00');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      pairs, startHour, time, refreshInterval, stealthInterval,
      scheduleMode, scheduleTime, randomStart, randomStartMin, randomStartMax,
    }));
  }, [pairs, startHour, time, refreshInterval, stealthInterval, scheduleMode, scheduleTime, randomStart, randomStartMin, randomStartMax]);

  const toggleAccount = (idx) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(accounts.map(a => a.index)));
  };

  const updatePair = (index, field, value) => {
    setPairs(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const addPair = () => setPairs(prev => [...prev, { url1: '', url2: '' }]);

  const removePair = (index) => {
    if (pairs.length <= 1) return;
    setPairs(prev => prev.filter((_, i) => i !== index));
  };

  const handleStart = async () => {
    const validPairs = pairs.filter(p => p.url1.trim());
    if (validPairs.length === 0 || selected.size === 0) return;
    setLoading(true);

    let payload = {
      pairs: validPairs,
      accountIndices: [...selected],
      time,
      refreshInterval,
      stealthInterval,
      ...(randomStart && { randomStartMin, randomStartMax }),
    };

    if (scheduleMode === 'now') {
      payload.delayStart = false;
    } else if (scheduleMode === 'tomorrow') {
      payload.delayStart = true;
      payload.startHour = startHour;
    } else if (scheduleMode === 'schedule') {
      if (!scheduleDate || !scheduleTime) {
        alert('Vui lòng chọn ngày và giờ');
        setLoading(false);
        return;
      }
      // Tạo Date object từ local time của browser (không phải UTC)
      const dateStr = `${scheduleDate}T${scheduleTime}:00`;
      const scheduledDate = new Date(dateStr); // Local time
      payload.scheduledDateTime = scheduledDate.getTime(); // Gửi timestamp (milliseconds)
    }

    await onStart(payload);
    setLoading(false);
  };

  const hasValidPair = pairs.some(p => p.url1.trim());

  return (
    <div className="card">
      <div className="card-header">🎮 Điều khiển</div>
      <div className="card-body">
        <div className="form-group">
          <label>📋 Danh sách cặp bài học</label>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>
            Mỗi cặp có 2 link. Sau khi xong 1 cặp sẽ đợi đến giờ hẹn ngày hôm sau để chạy cặp tiếp.
          </div>

          {pairs.map((pair, i) => (
            <div key={i} style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 12,
              marginBottom: 8,
              background: 'rgba(255,255,255,0.02)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--primary)' }}>
                  Cặp {i + 1}
                </span>
                {pairs.length > 1 && (
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => removePair(i)}
                    style={{ padding: '2px 8px', fontSize: 11 }}
                  >✕ Xóa</button>
                )}
              </div>
              <input
                type="url"
                placeholder="Link bài 1 (bắt buộc)"
                value={pair.url1}
                onChange={e => updatePair(i, 'url1', e.target.value)}
                style={{ marginBottom: 6 }}
              />
              <input
                type="url"
                placeholder="Link bài 2 (tùy chọn)"
                value={pair.url2}
                onChange={e => updatePair(i, 'url2', e.target.value)}
              />
            </div>
          ))}

          <button className="btn btn-outline" onClick={addPair} style={{ marginTop: 4, width: '100%' }}>
            ➕ Thêm cặp
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <div className="form-group">
            <label>⏰ Giờ chạy</label>
            <input type="number" value={startHour} min={0} max={23} onChange={e => setStartHour(Number(e.target.value))} />
            <span style={{ fontSize: 11, color: 'var(--text2)' }}>Giờ bắt đầu ngày mới</span>
          </div>
          <div className="form-group">
            <label>⏱️ Thời gian (phút)</label>
            <input type="number" value={time} min={1} onChange={e => setTime(Number(e.target.value))} />
          </div>
          <div className="form-group">
            <label>🔄 F5 mỗi (phút)</label>
            <input type="number" value={refreshInterval} min={1} onChange={e => setRefreshInterval(Number(e.target.value))} />
          </div>
          <div className="form-group">
            <label>🎭 Stealth (giây)</label>
            <input type="number" value={stealthInterval} min={5} onChange={e => setStealthInterval(Number(e.target.value))} />
          </div>
        </div>

        <div className="form-group">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 0 }}>
            <input
              type="checkbox"
              className="account-check"
              checked={randomStart}
              onChange={e => setRandomStart(e.target.checked)}
            />
            🎲 Random Start Time
            <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 400 }}>(tránh cố định giờ)</span>
          </label>
          {randomStart && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 10 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 4 }}>Delay tối thiểu (phút)</label>
                <input type="number" value={randomStartMin} min={0} max={120}
                  onChange={e => setRandomStartMin(Number(e.target.value))} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 4 }}>Delay tối đa (phút)</label>
                <input type="number" value={randomStartMax} min={0} max={120}
                  onChange={e => setRandomStartMax(Number(e.target.value))} />
              </div>
            </div>
          )}
        </div>

        <div className="form-group">
          <label>👤 Chọn tài khoản</label>
          <div style={{ maxHeight: 150, overflowY: 'auto' }}>
            {accounts.length === 0 ? (
              <span style={{ color: 'var(--text2)', fontSize: 13 }}>Chưa có tài khoản</span>
            ) : (
              accounts.map(a => (
                <label key={a.index} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', cursor: 'pointer', fontSize: 14 }}>
                  <input
                    type="checkbox"
                    className="account-check"
                    checked={selected.has(a.index)}
                    onChange={() => toggleAccount(a.index)}
                  />
                  {a.name} <span style={{ color: 'var(--text2)', fontSize: 12 }}>({a.email})</span>
                </label>
              ))
            )}
          </div>
        </div>

        <div className="form-group">
          <label>📅 Chế độ lịch</label>
          <select
            value={scheduleMode}
            onChange={e => setScheduleMode(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              background: 'var(--bg)',
              color: 'var(--text)',
              fontSize: '14px',
              cursor: 'pointer',
            }}
          >
            <option value="now">🚀 Chạy ngay</option>
            <option value="tomorrow">📅 Ngày mai lúc {startHour}:00</option>
            <option value="schedule">📆 Hẹn ngày giờ cụ thể</option>
          </select>
        </div>

        {scheduleMode === 'schedule' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label>📆 Ngày chạy</label>
              <input
                type="date"
                value={scheduleDate}
                onChange={e => setScheduleDate(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>⏰ Giờ chạy</label>
              <input
                type="time"
                value={scheduleTime}
                onChange={e => setScheduleTime(e.target.value)}
              />
            </div>
          </div>
        )}

        {scheduleMode === 'tomorrow' && (
          <div className="form-group">
            <label>⏰ Giờ chạy ngày mai</label>
            <input type="number" value={startHour} min={0} max={23} onChange={e => setStartHour(Number(e.target.value))} />
            <span style={{ fontSize: 11, color: 'var(--text2)' }}>Giờ bắt đầu selon giờ Việt Nam</span>
          </div>
        )}

        <div className="btn-group">
          <button
            className="btn btn-primary"
            disabled={loading || !hasValidPair || selected.size === 0}
            onClick={handleStart}
          >
            {loading ? '⏳ Đang khởi động...' : scheduleMode === 'now' ? '🚀 Bắt đầu treo' : scheduleMode === 'tomorrow' ? '⏰ Hẹn ngày mai' : '📅 Hẹn lịch'}
          </button>
          <button className="btn btn-outline" onClick={selectAll}>☑ Chọn tất cả</button>
        </div>
      </div>
    </div>
  );
}
