import { useEffect, useState } from 'react';
import * as api from '../api';

const AUTO_STATUS = {
  idle:         { text: 'Chờ khởi động', badge: 'badge-idle' },
  'logging-in': { text: 'Đang đăng nhập', badge: 'badge-logging-in' },
  scanning:     { text: 'Đang quét khóa học', badge: 'badge-running' },
  studying:     { text: 'Đang treo học', badge: 'badge-running' },
  paused:       { text: 'Tạm dừng', badge: 'badge-idle' },
  'date-limit': { text: 'Ngày nghỉ — đã hẹn lịch', badge: 'badge-logging-in' },
  'daily-limit':{ text: 'Đủ giờ hôm nay — đã hẹn lịch', badge: 'badge-logging-in' },
  'time-window':{ text: 'Ngoài khung giờ — đã hẹn lịch', badge: 'badge-logging-in' },
  completed:    { text: 'Hoàn thành', badge: 'badge-completed' },
  stopped:      { text: 'Đã dừng', badge: 'badge-idle' },
  error:        { text: 'Lỗi', badge: 'badge-error' },
};

const ACTIVE_STATUSES = new Set(['idle', 'logging-in', 'scanning', 'studying']);
const SCHEDULED_STATUSES = new Set(['date-limit', 'daily-limit', 'time-window']);
const DONE_STATUSES = new Set(['completed', 'stopped', 'error']);

function formatVNDateTime(iso) {
  try {
    return new Date(iso).toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatMinutes(mins) {
  const m = Math.max(0, Math.round(mins || 0));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

function courseNameFromUrl(url) {
  try {
    return decodeURIComponent(url.split('/').filter(Boolean).pop() || url);
  } catch {
    return url;
  }
}

function AutoScanCard({ scan, toast }) {
  const info = AUTO_STATUS[scan.status] || { text: scan.status, badge: 'badge-idle' };
  const isActive = ACTIVE_STATUSES.has(scan.status);
  const isScheduled = SCHEDULED_STATUSES.has(scan.status);
  const isPaused = scan.status === 'paused';
  const courses = Object.entries(scan.courseProgress || {});

  const handlePause = async () => {
    const res = await api.pauseAutoScan(scan.id);
    if (res.ok) toast('Đã tạm dừng phiên Auto-Scan', 'info');
    else toast(res.error || 'Lỗi tạm dừng phiên Auto-Scan', 'error');
  };

  const handleResume = async () => {
    const res = await api.resumeAutoScan(scan.id);
    if (res.ok) toast('Đã tiếp tục phiên Auto-Scan', 'success');
    else toast(res.error || 'Lỗi tiếp tục phiên Auto-Scan', 'error');
  };

  const handleStop = async () => {
    const msg = isScheduled
      ? `Hủy lịch hẹn và dừng phiên Auto-Scan của ${scan.account}?`
      : `Dừng phiên Auto-Scan của ${scan.account}?`;
    if (!window.confirm(msg)) return;
    const res = await api.stopAutoScan(scan.id);
    if (res.ok) toast('Đã dừng phiên Auto-Scan', 'info');
    else toast(res.error || 'Lỗi dừng phiên Auto-Scan', 'error');
  };

  const handleRemove = async () => {
    const res = await api.removeAutoScan(scan.id);
    if (res.ok) toast('Đã xóa thẻ phiên Auto-Scan', 'info');
    else toast(res.error || 'Lỗi xóa phiên Auto-Scan', 'error');
  };

  const dailyMax = scan.dailyMaxMinutes || 480;
  const dailyPct = Math.min(100, ((scan.dailyStudiedMinutes || 0) / dailyMax) * 100);

  return (
    <div className="autoscan-card">
      <div className="autoscan-card-header">
        <span className="autoscan-card-name">{scan.account}</span>
        <div className="session-actions">
          <span className={`session-badge ${info.badge}`}>{info.text}</span>
          {(scan.status === 'logging-in' || scan.status === 'scanning' || scan.status === 'studying') && (
            <button className="btn btn-sm btn-outline" onClick={handlePause}>Tạm dừng</button>
          )}
          {isPaused && (
            <button className="btn btn-sm btn-primary" onClick={handleResume}>Tiếp tục</button>
          )}
          {(isActive || isScheduled || isPaused) && (
            <button className="btn btn-sm btn-danger" onClick={handleStop}>Dừng</button>
          )}
          {!isActive && !isPaused && (
            <button className="btn btn-sm btn-ghost" onClick={handleRemove} title="Xóa thẻ này khỏi danh sách">Xóa</button>
          )}
        </div>
      </div>

      <div className="autoscan-meta">
        <span>Khóa học: <strong>{Math.min((scan.currentCourseIndex || 0) + 1, scan.totalCourses || 1)}/{scan.totalCourses || 1}</strong></span>
        <span>Hôm nay: <strong>{formatMinutes(scan.dailyStudiedMinutes)} / {formatMinutes(dailyMax)}</strong></span>
        {isScheduled && scan.nextRunTime && (
          <span>Tự chạy lại: <strong>{formatVNDateTime(scan.nextRunTime)}</strong></span>
        )}
        {DONE_STATUSES.has(scan.status) && scan.completedAt && (
          <span>Kết thúc: <strong>{formatVNDateTime(scan.completedAt)}</strong></span>
        )}
      </div>

      <div className="progress-track">
        <div
          className={`progress-fill ${dailyPct >= 100 ? 'warning' : ''}`}
          style={{ width: `${dailyPct}%` }}
        />
      </div>

      {courses.length > 0 && (
        <div className="course-progress">
          {courses.map(([url, cp]) => {
            const target = cp.targetMinutes || 0;
            const studied = cp.studiedMinutes || 0;
            const pct = cp.completed ? 100 : target > 0 ? Math.min(100, (studied / target) * 100) : 0;
            return (
              <div className="course-progress-row" key={url}>
                <div className="course-progress-title">
                  <span className="name" title={url}>{cp.title || courseNameFromUrl(url)}</span>
                  <span className={`value ${cp.completed ? 'done' : ''}`}>
                    {cp.completed ? 'Đã đạt mục tiêu' : `${formatMinutes(studied)} / ${formatMinutes(target)}`}
                  </span>
                </div>
                <div className="progress-track">
                  <div
                    className={`progress-fill ${cp.completed ? 'success' : ''}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const EMPTY_COURSE = { courseUrl: '', targetHours: '', targetMinutes: '' };

export default function AutoScanPanel({ accounts, autoScans, toast }) {
  const [courses, setCourses] = useState([{ ...EMPTY_COURSE }]);

  const [allowedDateRanges, setAllowedDateRanges] = useState('');
  const [dailyMaxHours, setDailyMaxHours] = useState('8');
  const [newDayStartTime, setNewDayStartTime] = useState('06:00');
  const [refreshInterval, setRefreshInterval] = useState('15');
  const [timeWindowsText, setTimeWindowsText] = useState('');
  const [customTimeRules, setCustomTimeRules] = useState([
    { id: 1, dates: '', shifts: '07:00-11:30, 14:00-23:00' }
  ]);
  const [stealth, setStealth] = useState(false);
  const [selectedAccounts, setSelectedAccounts] = useState(new Set());
  const [loading, setLoading] = useState(false);

  const addCustomRule = () => {
    setCustomTimeRules(prev => [...prev, { id: Date.now(), dates: '', shifts: '07:00-11:30, 14:00-23:00' }]);
  };

  const removeCustomRule = (id) => {
    if (customTimeRules.length <= 1) {
      setCustomTimeRules([{ id: Date.now(), dates: '', shifts: '' }]);
      return;
    }
    setCustomTimeRules(prev => prev.filter(r => r.id !== id));
  };

  const updateCustomRule = (id, field, value) => {
    setCustomTimeRules(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));
  };

  // Auto-Scan Presets
  const [presets, setPresets] = useState([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [showSavePresetModal, setShowSavePresetModal] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [presetSaving, setPresetSaving] = useState(false);

  useEffect(() => {
    api.fetchAutoPresets()
      .then(data => { if (Array.isArray(data)) setPresets(data); })
      .catch(() => {});
  }, []);

  const scanList = Object.values(autoScans || {});
  const activeScans = scanList.filter(s => !DONE_STATUSES.has(s.status));
  const doneScans = scanList.filter(s => DONE_STATUSES.has(s.status));
  const activeCount = scanList.filter(s => ACTIVE_STATUSES.has(s.status) || s.status === 'paused').length;

  const handleSelectPreset = (presetId) => {
    setSelectedPresetId(presetId);
    if (!presetId) return;
    const preset = presets.find(p => p.id === presetId);
    if (!preset || !preset.config) return;

    const cfg = preset.config;
    if (Array.isArray(cfg.courses) && cfg.courses.length > 0) {
      setCourses(cfg.courses.map(c => ({
        courseUrl: c.courseUrl || '',
        targetHours: c.targetHours != null ? String(c.targetHours) : '',
        targetMinutes: c.targetMinutes != null ? String(c.targetMinutes) : '',
      })));
    }
    if (cfg.allowedDateRanges != null) setAllowedDateRanges(cfg.allowedDateRanges);
    if (cfg.dailyMaxHours != null) setDailyMaxHours(String(cfg.dailyMaxHours));
    if (cfg.newDayStartTime != null) setNewDayStartTime(cfg.newDayStartTime);
    if (cfg.refreshInterval != null) setRefreshInterval(String(cfg.refreshInterval));
    if (cfg.timeWindowsText != null) setTimeWindowsText(cfg.timeWindowsText);
    if (Array.isArray(cfg.customTimeRules)) setCustomTimeRules(cfg.customTimeRules);
    if (cfg.stealth != null) setStealth(!!cfg.stealth);
  };

  const handleSavePresetSubmit = async (e) => {
    e.preventDefault();
    if (!newPresetName.trim()) return;

    setPresetSaving(true);
    try {
      const res = await api.saveAutoPreset({
        name: newPresetName.trim(),
        config: {
          courses: courses.filter(c => c.courseUrl.trim()),
          allowedDateRanges,
          dailyMaxHours,
          newDayStartTime,
          refreshInterval,
          timeWindowsText,
          customTimeRules,
          stealth,
        },
      });

      if (res.ok && res.preset) {
        setPresets(prev => [res.preset, ...prev]);
        setSelectedPresetId(res.preset.id);
        setShowSavePresetModal(false);
        setNewPresetName('');
        toast('Đã lưu Preset Auto-Scan', 'success');
      } else {
        toast(res.error || 'Lỗi lưu Preset', 'error');
      }
    } catch (err) {
      toast(`Lỗi lưu Preset: ${err.message}`, 'error');
    } finally {
      setPresetSaving(false);
    }
  };

  const handleDeletePreset = async () => {
    if (!selectedPresetId) return;
    const preset = presets.find(p => p.id === selectedPresetId);
    if (!preset) return;
    if (!window.confirm(`Xóa mẫu Preset "${preset.name}"?`)) return;

    try {
      const res = await api.deleteAutoPreset(selectedPresetId);
      if (res.ok) {
        setPresets(prev => prev.filter(p => p.id !== selectedPresetId));
        setSelectedPresetId('');
        toast('Đã xóa Preset', 'info');
      }
    } catch {
      toast('Lỗi xóa Preset', 'error');
    }
  };

  const handleClearCompleted = async () => {
    if (!window.confirm('Xóa tất cả phiên Auto-Scan đã kết thúc?')) return;
    const res = await api.clearCompletedAutoScans();
    if (res.ok) toast(`Đã xóa ${res.count} phiên đã kết thúc`, 'success');
    else toast(res.error || 'Lỗi xóa phiên đã kết thúc', 'error');
  };

  const addCourse = () => {
    setCourses(prev => [...prev, { ...EMPTY_COURSE }]);
  };

  const removeCourse = idx => {
    if (courses.length <= 1) return;
    setCourses(prev => prev.filter((_, i) => i !== idx));
  };

  const updateCourse = (idx, field, value) => {
    setCourses(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  };

  const handleStartAutoScan = async () => {
    const validCourses = courses.filter(c => c.courseUrl.trim());
    if (validCourses.length === 0 || selectedAccounts.size === 0) {
      toast('Vui lòng nhập ít nhất 1 URL khóa học và chọn tài khoản', 'error');
      return;
    }

    // Parse khung giờ học "07:00-11:30, 13:00-22:00" → [{start, end}]
    const timeWindows = timeWindowsText
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(part => {
        const m = part.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
        return m ? { start: m[1], end: m[2] } : null;
      })
      .filter(Boolean);

    const validCustomRules = customTimeRules
      .map(r => ({ dates: (r.dates || '').trim(), shifts: (r.shifts || '').trim() }))
      .filter(r => r.shifts.length > 0);

    setLoading(true);
    try {
      const data = await api.startAutoScan({
        courses: validCourses.map(c => ({
          courseUrl: c.courseUrl.trim(),
          targetHours: parseInt(c.targetHours, 10) || 0,
          targetMinutes: parseInt(c.targetMinutes, 10) || 0,
        })),
        allowedDateRanges: allowedDateRanges.split(',').map(s => s.trim()).filter(Boolean),
        dailyMaxMinutes: (parseInt(dailyMaxHours, 10) || 8) * 60,
        newDayStartTime: newDayStartTime.trim() || '06:00',
        refreshInterval: parseInt(refreshInterval, 10) || 15,
        stealth,
        ...(timeWindows.length > 0 && { timeWindows }),
        customTimeRules: validCustomRules,
        accountIndices: [...selectedAccounts],
      });

      if (data.ok) {
        toast(`Đã khởi động Auto-Scan cho ${data.started.length} tài khoản`, 'success');
      } else {
        toast(data.error || 'Lỗi khởi động Auto-Scan', 'error');
      }
    } catch (err) {
      toast(`Lỗi kết nối: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="autoscan-grid">
      {/* Auto Scan Setup Form */}
      <div className="card">
        <div className="card-header" style={{ justifyContent: 'space-between' }}>
          <span>Cấu hình Auto-Scan & Treo học</span>
          <span className="session-badge badge-running">Chính thức</span>
        </div>

        <div className="card-body">
          <div className="hint" style={{ marginTop: 0, marginBottom: 16 }}>
            Bot tự động vào link khóa học, lọc bài chưa xong (&lt;100%), đọc bộ đếm ngược
            của từng bài rồi treo đủ giờ. Tự kiểm soát định mức tổng giờ của từng khóa
            và giới hạn số giờ học mỗi ngày.
          </div>

          {/* Preset Toolbar */}
          <div className="preset-bar">
            <span className="filter-label">Mẫu Preset Auto-Scan</span>

            <select
              value={selectedPresetId}
              onChange={e => handleSelectPreset(e.target.value)}
              style={{ minWidth: 200 }}
            >
              <option value="">-- Chọn mẫu đã lưu --</option>
              {presets.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.config && p.config.courses ? p.config.courses.length : 0} khóa)
                </option>
              ))}
            </select>

            {selectedPresetId && (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={handleDeletePreset}
                title="Xóa mẫu Preset này"
              >
                Xóa mẫu
              </button>
            )}

            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => setShowSavePresetModal(true)}
              style={{ marginLeft: 'auto' }}
              disabled={!courses.some(c => c.courseUrl.trim())}
            >
              Lưu Preset mới
            </button>
          </div>

          {/* Save Preset Modal */}
          {showSavePresetModal && (
            <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowSavePresetModal(false)}>
              <div className="modal">
                <div className="modal-title">Lưu mẫu Preset Auto-Scan</div>
                <p className="modal-desc">
                  Lưu lại toàn bộ cấu hình hiện tại ({courses.filter(c => c.courseUrl.trim()).length} khóa học,
                  lịch ngày học, giới hạn giờ, khung giờ) để nạp lại nhanh cho lần sau.
                </p>

                <form onSubmit={handleSavePresetSubmit}>
                  <div className="form-group">
                    <label>Tên mẫu Preset</label>
                    <input
                      type="text"
                      placeholder="VD: Bộ khóa học Hạng B - Tháng 8..."
                      value={newPresetName}
                      onChange={e => setNewPresetName(e.target.value)}
                      autoFocus
                      required
                    />
                  </div>

                  <div className="btn-group" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
                    <button type="button" className="btn btn-outline" onClick={() => setShowSavePresetModal(false)}>
                      Hủy
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={presetSaving || !newPresetName.trim()}>
                      {presetSaving ? 'Đang lưu...' : 'Lưu Preset'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Courses List Form */}
          <div className="form-group">
            <label>Danh sách khóa học cần quét & treo</label>
            {courses.map((c, idx) => (
              <div key={idx} className="box-card">
                <div className="box-card-header">
                  <span className="box-card-title">
                    <span className="box-card-index">{idx + 1}</span>
                    Khóa học {idx + 1}
                  </span>
                  {courses.length > 1 && (
                    <button type="button" className="icon-btn" onClick={() => removeCourse(idx)} title="Xóa khóa học này">✕</button>
                  )}
                </div>

                <input
                  type="url"
                  placeholder="URL khóa học (VD: https://hoclythuyetlaixe.eco-tek.com.vn/slides/...)"
                  value={c.courseUrl}
                  onChange={e => updateCourse(idx, 'courseUrl', e.target.value)}
                  style={{ width: '100%', marginBottom: 8 }}
                  required
                />

                <div className="input-row">
                  <span className="unit">Định mức yêu cầu:</span>
                  <input
                    type="number"
                    className="input-num"
                    placeholder="12"
                    min="0"
                    value={c.targetHours}
                    onChange={e => updateCourse(idx, 'targetHours', e.target.value)}
                  />
                  <span className="unit">giờ</span>
                  <input
                    type="number"
                    className="input-num"
                    placeholder="36"
                    min="0"
                    max="59"
                    value={c.targetMinutes}
                    onChange={e => updateCourse(idx, 'targetMinutes', e.target.value)}
                  />
                  <span className="unit">phút</span>
                </div>
              </div>
            ))}

            <button type="button" className="btn btn-sm btn-outline btn-block" onClick={addCourse}>
              + Thêm khóa học
            </button>
          </div>

          {/* Date Ranges & Daily Cap & New Day Start Time */}
          <div className="form-group">
            <label>Lịch ngày học được phép (phân cách bằng dấu phẩy)</label>
            <input
              type="text"
              placeholder="VD: 25/07-28/07, 30/07, 01/08-02/08..."
              value={allowedDateRanges}
              onChange={e => setAllowedDateRanges(e.target.value)}
            />
            <div className="hint">
              Nếu ngày hiện tại là ngày nghỉ, bot sẽ tự chờ đến giờ bắt đầu ngày học hợp lệ tiếp theo.
            </div>
          </div>

          <div className="form-group">
            <label>Giới hạn tối đa mỗi ngày</label>
            <div className="input-row">
              <input
                type="number"
                placeholder="8"
                min="1"
                max="24"
                value={dailyMaxHours}
                onChange={e => setDailyMaxHours(e.target.value)}
                style={{ width: 100 }}
              />
              <span className="unit">tiếng/ngày (mặc định: 8)</span>
            </div>
          </div>

          <div className="form-group">
            <label>Giờ bắt đầu ngày mới (Hẹn tự động chạy lại)</label>
            <div className="input-row">
              <input
                type="text"
                placeholder="06:00"
                value={newDayStartTime}
                onChange={e => setNewDayStartTime(e.target.value)}
                style={{ width: 100 }}
              />
              <span className="unit">ví dụ: 06:00, 07:00 (mặc định: 06:00)</span>
            </div>
            <div className="hint">
              Nếu chạm giới hạn ngày hoặc gặp ngày nghỉ, bot sẽ tự động hẹn giờ chạy lại vào giờ này.
            </div>
          </div>

          <div className="form-group">
            <label>Thời gian F5 reload trang (lưu checkpoint & giữ phiên)</label>
            <div className="input-row">
              <input
                type="number"
                placeholder="15"
                min="1"
                max="60"
                value={refreshInterval}
                onChange={e => setRefreshInterval(e.target.value)}
                style={{ width: 100 }}
              />
              <span className="unit">phút/lần (mặc định: 15)</span>
            </div>
            <div className="hint">
              Sau mỗi chu kỳ này, bot sẽ tự động reload trang để lưu checkpoint lên web và thực hiện Heartbeat Check.
            </div>
          </div>

          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={{ margin: 0, fontWeight: 600 }}>Cấu hình Ca học / Khung giờ theo Ngày (Tùy chọn)</label>
              <button type="button" className="btn btn-sm btn-outline" onClick={addCustomRule}>
                + Thêm Ca học
              </button>
            </div>
            <div className="hint" style={{ marginBottom: 12 }}>
              Cài đặt khung giờ theo ca cho ngày cụ thể (ví dụ: ngày 25/07 chia làm 2 ca: ca 1 từ <code>07:00-11:30</code>, ca 2 từ <code>14:00-23:00</code>). Để trống <strong>Ngày áp dụng</strong> nếu muốn làm ca học mặc định hàng ngày.
            </div>

            {customTimeRules.map((rule, idx) => (
              <div key={rule.id || idx} className="box-card" style={{ marginBottom: 10, padding: '12px 14px' }}>
                <div className="box-card-header" style={{ marginBottom: 8 }}>
                  <span className="box-card-title" style={{ fontSize: '0.88rem' }}>
                    Quy tắc Ca học #{idx + 1}
                  </span>
                  <button type="button" className="icon-btn" onClick={() => removeCustomRule(rule.id || idx)} title="Xóa quy tắc này">✕</button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '10px' }}>
                  <div>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Ngày áp dụng (dd/mm)</label>
                    <input
                      type="text"
                      placeholder="VD: 25/07 hoặc 25/07-28/07 (trống = Hàng ngày)"
                      value={rule.dates}
                      onChange={e => updateCustomRule(rule.id || idx, 'dates', e.target.value)}
                      style={{ fontSize: '0.85rem' }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Các Ca học trong ngày</label>
                    <input
                      type="text"
                      placeholder="VD: 07:00-11:30, 14:00-23:00"
                      value={rule.shifts}
                      onChange={e => updateCustomRule(rule.id || idx, 'shifts', e.target.value)}
                      style={{ fontSize: '0.85rem' }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="form-group">
            <label>Khung giờ học chung trong ngày (tùy chọn đơn giản)</label>
            <input
              type="text"
              placeholder="VD: 07:00-11:30, 13:00-22:00"
              value={timeWindowsText}
              onChange={e => setTimeWindowsText(e.target.value)}
            />
            <div className="hint">
              Để trống = không giới hạn. Khi hết khung giờ, bot sẽ F5 lưu checkpoint, tạm nghỉ
              và tự hẹn giờ chạy lại vào đầu khung giờ tiếp theo (giống Queue thủ công).
            </div>
          </div>

          <div className="form-group">
            <label className="check-row">
              <input
                type="checkbox"
                checked={stealth}
                onChange={e => setStealth(e.target.checked)}
              />
              <span>Stealth / Anti-detection (mặc định TẮT cho Auto-Scan)</span>
            </label>
            <div className="hint">
              Khi bật: giả lập di chuột/cuộn trang, che dấu hiệu tự động hóa. Mặc định tắt để chạy nhẹ và ổn định.
            </div>
          </div>

          {/* Accounts Selector */}
          <div className="form-group">
            <label>Chọn tài khoản áp dụng</label>
            <div className="chip-group">
              {accounts.map(acc => {
                const isSelected = selectedAccounts.has(acc.index);
                return (
                  <button
                    key={acc.index}
                    type="button"
                    className={`chip ${isSelected ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedAccounts(prev => {
                        const next = new Set(prev);
                        if (next.has(acc.index)) next.delete(acc.index);
                        else next.add(acc.index);
                        return next;
                      });
                    }}
                  >
                    {acc.name}
                  </button>
                );
              })}
              {accounts.length === 0 && (
                <span className="hint" style={{ marginTop: 0 }}>Chưa có tài khoản nào — thêm ở mục Tài khoản.</span>
              )}
            </div>
          </div>

          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={handleStartAutoScan}
            disabled={loading || selectedAccounts.size === 0}
            style={{ marginTop: 16 }}
          >
            {loading ? 'Đang khởi động...' : 'Bắt đầu Auto-Scan & Treo học'}
          </button>
        </div>
      </div>

      {/* Progress & Live Monitor */}
      <div className="card">
        <div className="card-header" style={{ justifyContent: 'space-between' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            Tiến độ Auto-Scan
            {activeCount > 0 && <span className="count-pill">{activeCount} hoạt động</span>}
          </span>
          {doneScans.length > 0 && (
            <button className="btn btn-xs btn-danger" onClick={handleClearCompleted}>
              Xóa tất cả đã xong ({doneScans.length})
            </button>
          )}
        </div>
        <div className="card-body">
          {scanList.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">⟳</div>
              <span>Auto-Scan Engine đang chờ khởi động</span>
              <p>
                Trạng thái từng tài khoản, tiến độ từng khóa học và số giờ đã treo
                trong ngày sẽ tự động cập nhật ở đây.
              </p>
            </div>
          ) : (
            <>
              {activeScans.length > 0 && (
                <div>
                  <div className="section-label">
                    <span>Đang hoạt động / Đã hẹn lịch ({activeScans.length})</span>
                  </div>
                  {activeScans.map(scan => (
                    <AutoScanCard key={scan.id} scan={scan} toast={toast} />
                  ))}
                </div>
              )}

              {doneScans.length > 0 && (
                <div style={{ marginTop: activeScans.length > 0 ? 16 : 0 }}>
                  <div className="section-label">
                    <span>Đã hoàn thành / Kết thúc ({doneScans.length})</span>
                    <button className="btn btn-xs btn-danger" onClick={handleClearCompleted}>
                      Xóa tất cả
                    </button>
                  </div>
                  {doneScans.map(scan => (
                    <AutoScanCard key={scan.id} scan={scan} toast={toast} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
