import { useState } from 'react';
import * as api from '../api';

const AUTO_STATUS = {
  idle:         { text: 'Chờ khởi động', badge: 'badge-idle' },
  'logging-in': { text: 'Đang đăng nhập', badge: 'badge-logging-in' },
  scanning:     { text: 'Đang quét khóa học', badge: 'badge-running' },
  studying:     { text: 'Đang treo học', badge: 'badge-running' },
  'date-limit': { text: 'Ngày nghỉ — chờ lịch', badge: 'badge-logging-in' },
  'daily-limit':{ text: 'Đạt giới hạn ngày', badge: 'badge-logging-in' },
  completed:    { text: 'Hoàn thành', badge: 'badge-completed' },
  stopped:      { text: 'Đã dừng', badge: 'badge-idle' },
  error:        { text: 'Lỗi', badge: 'badge-error' },
};

const ACTIVE_STATUSES = new Set(['idle', 'logging-in', 'scanning', 'studying']);

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
  const courses = Object.entries(scan.courseProgress || {});

  const handleStop = async () => {
    if (!window.confirm(`Dừng phiên Auto-Scan của ${scan.account}?`)) return;
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
          {isActive ? (
            <button className="btn btn-sm btn-danger" onClick={handleStop}>Dừng</button>
          ) : (
            <button className="btn btn-sm btn-ghost" onClick={handleRemove} title="Xóa thẻ này khỏi danh sách">Xóa</button>
          )}
        </div>
      </div>

      <div className="autoscan-meta">
        <span>Khóa học: <strong>{Math.min((scan.currentCourseIndex || 0) + 1, scan.totalCourses || 1)}/{scan.totalCourses || 1}</strong></span>
        <span>Hôm nay: <strong>{formatMinutes(scan.dailyStudiedMinutes)} / {formatMinutes(dailyMax)}</strong></span>
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

export default function AutoScanPanel({ accounts, autoScans, toast }) {
  const [courses, setCourses] = useState([
    {
      courseUrl: 'https://hoclythuyetlaixe.eco-tek.com.vn/slides/cau-tao-va-sua-chua-thong-thuong-xe-cat-tuong-minh-213',
      targetHours: '12',
      targetMinutes: '36',
    },
  ]);

  const [allowedDateRanges, setAllowedDateRanges] = useState('25/07-28/07, 30/07, 01/08-02/08, 04/08, 06/08-14/08');
  const [dailyMaxHours, setDailyMaxHours] = useState('8');
  const [selectedAccounts, setSelectedAccounts] = useState(new Set());
  const [loading, setLoading] = useState(false);

  const scanList = Object.values(autoScans || {});
  const activeCount = scanList.filter(s => ACTIVE_STATUSES.has(s.status)).length;

  const addCourse = () => {
    setCourses(prev => [...prev, { courseUrl: '', targetHours: '12', targetMinutes: '0' }]);
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
          <span className="session-badge badge-running">Thử nghiệm</span>
        </div>

        <div className="card-body">
          <div className="hint" style={{ marginTop: 0, marginBottom: 16 }}>
            Bot tự động vào link khóa học, lọc bài chưa xong (&lt;100%), đọc bộ đếm ngược
            của từng bài rồi treo đủ giờ. Tự kiểm soát định mức tổng giờ của từng khóa
            và giới hạn số giờ học mỗi ngày.
          </div>

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

          {/* Date Ranges & Daily Cap */}
          <div className="form-group">
            <label>Lịch ngày học được phép (phân cách bằng dấu phẩy)</label>
            <input
              type="text"
              placeholder="VD: 25/07-28/07, 30/07, 01/08-02/08..."
              value={allowedDateRanges}
              onChange={e => setAllowedDateRanges(e.target.value)}
            />
            <div className="hint">
              Nếu ngày hiện tại là ngày nghỉ, bot sẽ tự chờ đến 06:00 ngày học hợp lệ tiếp theo.
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
          <span>Tiến độ Auto-Scan</span>
          {activeCount > 0 && <span className="count-pill">{activeCount} đang chạy</span>}
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
            scanList.map(scan => (
              <AutoScanCard key={scan.id} scan={scan} toast={toast} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
