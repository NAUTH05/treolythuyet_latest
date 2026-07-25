import { useState, useEffect } from 'react';

export default function AutoScanPanel({ accounts, toast }) {
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
  const [autoSessions, setAutoSessions] = useState([]);

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
      toast('❌ Vui lòng nhập ít nhất 1 URL khóa học và chọn tài khoản', 'error');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/lythuyet/api/auto-scan/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courses: validCourses.map(c => ({
            courseUrl: c.courseUrl.trim(),
            targetHours: parseInt(c.targetHours, 10) || 0,
            targetMinutes: parseInt(c.targetMinutes, 10) || 0,
          })),
          allowedDateRanges: allowedDateRanges.split(',').map(s => s.trim()).filter(Boolean),
          dailyMaxMinutes: (parseInt(dailyMaxHours, 10) || 8) * 60,
          accountIndices: [...selectedAccounts],
        }),
      });

      const data = await res.json();
      if (data.ok) {
        toast(`🤖 Đã khởi động Auto-Scan cho ${data.started.length} tài khoản`, 'success');
      } else {
        toast(`❌ ${data.error || 'Lỗi khởi động Auto-Scan'}`, 'error');
      }
    } catch (err) {
      toast(`❌ Lỗi kết nối: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auto-scan-container" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
      {/* Auto Scan Setup Form */}
      <div className="card">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>🤖 Thử Nghiệm: Auto-Scan & Auto-Study Khóa Học</span>
          <span className="session-badge badge-running">Bản thử nghiệm (test_dev)</span>
        </div>

        <div className="card-body">
          <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 16 }}>
            Bot sẽ tự động vào link Khóa học $\rightarrow$ Lọc bài chưa xong (&lt;100%) $\rightarrow$ Tự động đọc vòng tròn đếm ngược DOM Timer $\rightarrow$ Kiểm soát định mức tổng giờ học của từng Khóa & Giới hạn tối đa 8h/ngày!
          </div>

          {/* Courses List Form */}
          <div className="form-group">
            <label>📚 Danh Sách Khóa Học Cần Quét & Treo</label>
            {courses.map((c, idx) => (
              <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 8, background: 'var(--surface2)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--primary)' }}>Khóa học #{idx + 1}</span>
                  {courses.length > 1 && (
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => removeCourse(idx)} style={{ padding: '2px 6px', fontSize: 10 }}>✕ Xóa</button>
                  )}
                </div>

                <input
                  type="url"
                  placeholder="URL Khóa học (VD: https://hoclythuyetlaixe.eco-tek.com.vn/slides/...)"
                  value={c.courseUrl}
                  onChange={e => updateCourse(idx, 'courseUrl', e.target.value)}
                  style={{ width: '100%', marginBottom: 6 }}
                  required
                />

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ color: 'var(--text2)' }}>Định mức yêu cầu:</span>
                  <input
                    type="number"
                    placeholder="12"
                    value={c.targetHours}
                    onChange={e => updateCourse(idx, 'targetHours', e.target.value)}
                    style={{ width: 60, textAlign: 'center' }}
                  />
                  <span>giờ</span>
                  <input
                    type="number"
                    placeholder="36"
                    value={c.targetMinutes}
                    onChange={e => updateCourse(idx, 'targetMinutes', e.target.value)}
                    style={{ width: 60, textAlign: 'center' }}
                  />
                  <span>phút</span>
                </div>
              </div>
            ))}

            <button type="button" className="btn btn-sm btn-outline" onClick={addCourse} style={{ width: '100%' }}>
              + Thêm Khóa Học Nữa
            </button>
          </div>

          {/* Date Ranges & Daily Cap */}
          <div className="form-group">
            <label>📅 Lịch Ngày Học Được Phép (Phân cách bằng dấu phẩy)</label>
            <input
              type="text"
              placeholder="VD: 25/07-28/07, 30/07, 01/08-02/08..."
              value={allowedDateRanges}
              onChange={e => setAllowedDateRanges(e.target.value)}
            />
            <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>
              Nếu ngày hiện tại là ngày nghỉ, Bot sẽ tự chờ đến 06:00 ngày học hợp lệ tiếp theo.
            </div>
          </div>

          <div className="form-group">
            <label>⏱️ Giới Hạn Tối Đa Mỗi Ngày (Tiếng/Ngày)</label>
            <input
              type="number"
              placeholder="8"
              value={dailyMaxHours}
              onChange={e => setDailyMaxHours(e.target.value)}
              style={{ width: 120 }}
            />
            <span style={{ fontSize: 12, color: 'var(--text2)', marginLeft: 8 }}>(Mặc định: 8 tiếng/ngày)</span>
          </div>

          {/* Accounts Selector */}
          <div className="form-group">
            <label>👤 Chọn Tài Khoản Áp Dụng</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {accounts.map(acc => {
                const isSelected = selectedAccounts.has(acc.index);
                return (
                  <button
                    key={acc.index}
                    type="button"
                    className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-outline'}`}
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
            </div>
          </div>

          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={handleStartAutoScan}
            disabled={loading || selectedAccounts.size === 0}
            style={{ marginTop: 16 }}
          >
            {loading ? '⏳ Đang khởi động...' : '🤖 Bắt Đầu Auto-Scan & Treo Học'}
          </button>
        </div>
      </div>

      {/* Progress & Live Logs Monitor */}
      <div className="card">
        <div className="card-header">📊 Tiến Độ Auto-Scan Khóa Học</div>
        <div className="card-body">
          <div className="empty">
            <div className="empty-icon">🤖</div>
            <span>Auto-Scan Engine đang chờ khởi động</span>
            <p style={{ fontSize: 12, color: 'var(--text2)', marginTop: 8 }}>
              Tiến độ từng bài học, thời gian DOM Timer đã đọc và số giờ còn lại của Khóa học sẽ tự động cập nhật ở đây.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
