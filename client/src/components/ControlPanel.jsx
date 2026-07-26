import { useEffect, useState } from 'react';
import * as api from '../api';

const STORAGE_KEY = 'treohoc_settings';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function parseTimeMinutes(h, m) {
  const hours = parseInt(h, 10) || 0;
  const mins = parseInt(m, 10) || 0;
  return hours * 60 + mins;
}

function createDefaultBox() {
  return {
    urls: [{ url: '', timeH: '', timeM: '' }],
    timeH: '4',
    timeM: '0',
    startHour: 7,
    refreshInterval: 15,
    stealthInterval: 30,
    useTimeWindows: false,
    timeWindows: [{ start: '07:00', end: '23:00' }],
    useSchedule: false,
    scheduleDate: '',
    scheduleTime: '07:00',
    showOptions: false,
  };
}

function convertSavedToBox(savedBox, globalSettings = {}) {
  let urls = [];
  if (savedBox.urls && Array.isArray(savedBox.urls)) {
    urls = savedBox.urls.map(u => ({
      url: u.url || '',
      timeH: u.timeH != null ? String(u.timeH) : (u.time ? String(Math.floor(u.time / 60)) : ''),
      timeM: u.timeM != null ? String(u.timeM) : (u.time ? String(u.time % 60) : ''),
    }));
  } else {
    if (savedBox.url1) urls.push({ url: savedBox.url1, timeH: '', timeM: '' });
    if (savedBox.url2) urls.push({ url: savedBox.url2, timeH: '', timeM: '' });
  }
  if (urls.length === 0) urls = [{ url: '', timeH: '', timeM: '' }];

  const totalTime = savedBox.pairOptions?.time || savedBox.time || 240;

  return {
    ...createDefaultBox(),
    ...savedBox,
    urls,
    timeH: String(Math.floor(totalTime / 60)),
    timeM: String(totalTime % 60),
    startHour: savedBox.pairOptions?.startHour ?? savedBox.startHour ?? globalSettings.startHour ?? 7,
    refreshInterval: savedBox.pairOptions?.refreshInterval ?? savedBox.refreshInterval ?? globalSettings.refreshInterval ?? 15,
    stealthInterval: savedBox.pairOptions?.stealthInterval ?? savedBox.stealthInterval ?? globalSettings.stealthInterval ?? 30,
    useTimeWindows: !!(savedBox.useTimeWindows || savedBox.pairOptions?.timeWindows?.length),
    timeWindows: savedBox.timeWindows || savedBox.pairOptions?.timeWindows || [{ start: '07:00', end: '23:00' }],
  };
}

export default function ControlPanel({ accounts, onStart }) {
  const [saved] = useState(loadSettings);
  const [boxes, setBoxes] = useState(() => {
    const s = loadSettings();
    if (s.pairs && Array.isArray(s.pairs) && s.pairs.length > 0) {
      return s.pairs.map(p => convertSavedToBox(p, s));
    }
    return [createDefaultBox()];
  });

  const [randomStart, setRandomStart] = useState(saved.randomStart ?? false);
  const [randomStartMin, setRandomStartMin] = useState(saved.randomStartMin ?? 0);
  const [randomStartMax, setRandomStartMax] = useState(saved.randomStartMax ?? 30);
  const [selectedAccounts, setSelectedAccounts] = useState(new Set());
  const [loading, setLoading] = useState(false);

  // Preset states
  const [presets, setPresets] = useState([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [showSavePresetModal, setShowSavePresetModal] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [presetSaving, setPresetSaving] = useState(false);

  // Load presets list
  useEffect(() => {
    api.fetchPresets()
      .then(data => { if (Array.isArray(data)) setPresets(data); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        pairs: boxes,
        randomStart,
        randomStartMin,
        randomStartMax,
      })
    );
  }, [boxes, randomStart, randomStartMin, randomStartMax]);

  const handleSelectPreset = (presetId) => {
    setSelectedPresetId(presetId);
    if (!presetId) return;

    const preset = presets.find(p => p.id === presetId);
    if (!preset || !preset.boxes) return;

    // Convert preset boxes to local boxes state
    const newBoxes = preset.boxes.map(p => convertSavedToBox(p));
    setBoxes(newBoxes);
  };

  const handleSavePresetSubmit = async (e) => {
    e.preventDefault();
    if (!newPresetName.trim()) return;

    setPresetSaving(true);
    try {
      const res = await api.savePreset({
        name: newPresetName.trim(),
        boxes,
      });

      if (res.ok && res.preset) {
        setPresets(prev => [res.preset, ...prev]);
        setSelectedPresetId(res.preset.id);
        setShowSavePresetModal(false);
        setNewPresetName('');
      } else {
        alert(res.error || 'Lỗi lưu Preset');
      }
    } catch {
      alert('Lỗi kết nối lưu Preset');
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
      const res = await api.deletePreset(selectedPresetId);
      if (res.ok) {
        setPresets(prev => prev.filter(p => p.id !== selectedPresetId));
        setSelectedPresetId('');
      }
    } catch {
      alert('Lỗi xóa Preset');
    }
  };

  const updateBox = (boxIdx, field, value) => {
    setBoxes(prev => {
      const next = [...prev];
      next[boxIdx] = { ...next[boxIdx], [field]: value };
      return next;
    });
  };

  const updateBoxUrl = (boxIdx, urlIdx, field, value) => {
    setBoxes(prev => {
      const next = [...prev];
      const urls = [...next[boxIdx].urls];
      urls[urlIdx] = { ...urls[urlIdx], [field]: value };
      next[boxIdx] = { ...next[boxIdx], urls };
      return next;
    });
  };

  const addUrlToBox = boxIdx => {
    setBoxes(prev => {
      const next = [...prev];
      next[boxIdx] = {
        ...next[boxIdx],
        urls: [...next[boxIdx].urls, { url: '', timeH: '', timeM: '' }],
      };
      return next;
    });
  };

  const removeUrlFromBox = (boxIdx, urlIdx) => {
    setBoxes(prev => {
      const next = [...prev];
      if (next[boxIdx].urls.length <= 1) return prev;
      next[boxIdx] = {
        ...next[boxIdx],
        urls: next[boxIdx].urls.filter((_, i) => i !== urlIdx),
      };
      return next;
    });
  };

  const addBox = () => {
    setBoxes(prev => [...prev, createDefaultBox()]);
  };

  const removeBox = boxIdx => {
    if (boxes.length <= 1) return;
    setBoxes(prev => prev.filter((_, i) => i !== boxIdx));
  };

  const handleStart = async () => {
    const validBoxes = boxes.filter(b => b.urls.some(u => u.url.trim()));
    if (validBoxes.length === 0 || selectedAccounts.size === 0) return;

    setLoading(true);
    await onStart({
      pairs: validBoxes.map(box => {
        const defaultTotal = parseTimeMinutes(box.timeH, box.timeM) || 240;
        const payload = {
          urls: box.urls
            .filter(u => u.url.trim())
            .map(u => ({
              url: u.url.trim(),
              time: u.timeH || u.timeM ? parseTimeMinutes(u.timeH, u.timeM) : null,
            })),
          pairOptions: {
            time: defaultTotal,
            startHour: parseInt(box.startHour, 10) || 7,
            refreshInterval: parseInt(box.refreshInterval, 10) || 15,
            stealthInterval: parseInt(box.stealthInterval, 10) || 30,
            ...(box.useTimeWindows && {
              timeWindows: box.timeWindows.filter(w => w.start && w.end),
            }),
          },
        };

        if (box.useSchedule && box.scheduleDate && box.scheduleTime) {
          payload.scheduledDateTime = new Date(`${box.scheduleDate}T${box.scheduleTime}:00`).getTime();
        }

        return payload;
      }),
      accountIndices: [...selectedAccounts],
      ...(randomStart && { randomStartMin, randomStartMax }),
    });
    setLoading(false);
  };

  const hasValidLink = boxes.some(b => b.urls.some(u => u.url.trim()));

  const totalLinksCount = boxes.reduce((acc, b) => acc + b.urls.filter(u => u.url.trim()).length, 0);

  return (
    <div className="card">
      <div className="card-header">
        <span>Bảng điều khiển Box bài học</span>
      </div>

      <div className="card-body">
        {/* Preset Management Toolbar */}
        <div className="preset-bar">
          <span className="filter-label">Mẫu Preset bài học</span>

          <select
            value={selectedPresetId}
            onChange={e => handleSelectPreset(e.target.value)}
            style={{ minWidth: 220 }}
          >
            <option value="">-- Chọn mẫu đã lưu --</option>
            {presets.map(p => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.boxes ? p.boxes.length : 0} box)
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
            disabled={!hasValidLink}
          >
            Lưu làm Preset mới
          </button>
        </div>

        {/* Save Preset Modal */}
        {showSavePresetModal && (
          <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowSavePresetModal(false)}>
            <div className="modal">
              <div className="modal-title">Lưu mẫu Preset mới</div>
              <p className="modal-desc">
                Lưu lại toàn bộ cấu hình {boxes.length} Box ({totalLinksCount} link bài học kèm thời gian) để nạp lại nhanh cho các học viên khác.
              </p>

              <form onSubmit={handleSavePresetSubmit}>
                <div className="form-group">
                  <label>Tên mẫu Preset</label>
                  <input
                    type="text"
                    placeholder="VD: Bộ Lý Thuyết Hạng B2 - 32 bài..."
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

        <div className="form-group">
          <label>Danh sách Box bài học</label>
          <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            Mỗi box có nhiều link, mỗi link có thể tuỳ chỉnh thời gian riêng. Mỗi box có cài đặt riêng biệt.
          </div>

          {boxes.map((box, boxIdx) => {
            const defaultBoxTime = parseTimeMinutes(box.timeH, box.timeM) || 240;
            const totalBoxMinutes = box.urls.reduce((acc, u) => {
              const linkTime = u.timeH || u.timeM ? parseTimeMinutes(u.timeH, u.timeM) : defaultBoxTime;
              return acc + linkTime;
            }, 0);

            return (
              <div key={boxIdx} className="box-card">
                <div className="box-card-header">
                  <span className="box-card-title">
                    <span className="box-card-index">{boxIdx + 1}</span>
                    Box {boxIdx + 1} ({box.urls.length} link)
                  </span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      className="btn btn-xs btn-outline"
                      onClick={() => addUrlToBox(boxIdx)}
                    >
                      + Link
                    </button>
                    {boxes.length > 1 && (
                      <button
                        className="btn btn-xs btn-danger"
                        onClick={() => removeBox(boxIdx)}
                      >
                        Xoá Box
                      </button>
                    )}
                  </div>
                </div>

                {box.urls.map((urlObj, urlIdx) => (
                  <div key={urlIdx} className="url-row">
                    <span className="url-row-index">{urlIdx + 1}.</span>
                    <input
                      type="url"
                      placeholder={`URL bài học ${urlIdx + 1} *`}
                      value={urlObj.url}
                      onChange={e => updateBoxUrl(boxIdx, urlIdx, 'url', e.target.value)}
                    />
                    <input
                      type="number"
                      className="input-num"
                      placeholder="h"
                      min="0"
                      max="24"
                      value={urlObj.timeH}
                      onChange={e => updateBoxUrl(boxIdx, urlIdx, 'timeH', e.target.value)}
                      title="Số giờ riêng cho bài này (để trống = dùng tổng Box)"
                    />
                    <span className="unit">:</span>
                    <input
                      type="number"
                      className="input-num"
                      placeholder="m"
                      min="0"
                      max="59"
                      value={urlObj.timeM}
                      onChange={e => updateBoxUrl(boxIdx, urlIdx, 'timeM', e.target.value)}
                      title="Số phút riêng cho bài này (để trống = dùng tổng Box)"
                    />
                    {box.urls.length > 1 && (
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => removeUrlFromBox(boxIdx, urlIdx)}
                        title="Xoá link này"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}

                <div className="box-card-footer">
                  <span>
                    Tổng: <strong style={{ color: 'var(--text)' }}>{(totalBoxMinutes / 60).toFixed(1)}h</strong> ({totalBoxMinutes} phút)
                  </span>

                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => updateBox(boxIdx, 'showOptions', !box.showOptions)}
                  >
                    Cài đặt Box {box.showOptions ? '▴' : '▾'}
                  </button>
                </div>

                {box.showOptions && (
                  <div className="box-card-options">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label>Thời gian mặc định Box</label>
                        <div className="input-row">
                          <input
                            type="number"
                            className="input-num"
                            placeholder="4"
                            value={box.timeH}
                            onChange={e => updateBox(boxIdx, 'timeH', e.target.value)}
                          />
                          <span className="unit">h</span>
                          <input
                            type="number"
                            className="input-num"
                            placeholder="0"
                            value={box.timeM}
                            onChange={e => updateBox(boxIdx, 'timeM', e.target.value)}
                          />
                          <span className="unit">m</span>
                        </div>
                      </div>

                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label>F5 Refresh (phút)</label>
                        <input
                          type="number"
                          value={box.refreshInterval}
                          onChange={e => updateBox(boxIdx, 'refreshInterval', e.target.value)}
                        />
                      </div>

                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label>Stealth (giây)</label>
                        <input
                          type="number"
                          value={box.stealthInterval}
                          onChange={e => updateBox(boxIdx, 'stealthInterval', e.target.value)}
                        />
                      </div>
                    </div>

                    <div style={{ marginBottom: 8 }}>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={box.useTimeWindows}
                          onChange={e => updateBox(boxIdx, 'useTimeWindows', e.target.checked)}
                        />
                        <span>Giới hạn khung giờ học cho Box này</span>
                      </label>

                      {box.useTimeWindows && (
                        <div style={{ marginTop: 6, paddingLeft: 22 }}>
                          {box.timeWindows.map((tw, twIdx) => (
                            <div key={twIdx} className="input-row" style={{ marginBottom: 4 }}>
                              <input
                                type="time"
                                value={tw.start}
                                onChange={e => {
                                  const next = [...box.timeWindows];
                                  next[twIdx] = { ...next[twIdx], start: e.target.value };
                                  updateBox(boxIdx, 'timeWindows', next);
                                }}
                              />
                              <span className="unit">-</span>
                              <input
                                type="time"
                                value={tw.end}
                                onChange={e => {
                                  const next = [...box.timeWindows];
                                  next[twIdx] = { ...next[twIdx], end: e.target.value };
                                  updateBox(boxIdx, 'timeWindows', next);
                                }}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={box.useSchedule}
                          onChange={e => updateBox(boxIdx, 'useSchedule', e.target.checked)}
                        />
                        <span>Hẹn ngày giờ bắt đầu cho Box này</span>
                      </label>

                      {box.useSchedule && (
                        <div className="input-row" style={{ marginTop: 6, paddingLeft: 22 }}>
                          <input
                            type="date"
                            value={box.scheduleDate}
                            onChange={e => updateBox(boxIdx, 'scheduleDate', e.target.value)}
                          />
                          <input
                            type="time"
                            value={box.scheduleTime}
                            onChange={e => updateBox(boxIdx, 'scheduleTime', e.target.value)}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <button
            type="button"
            className="btn btn-outline btn-sm btn-block"
            onClick={addBox}
            style={{ marginTop: 4 }}
          >
            + Thêm Box bài học mới
          </button>
        </div>

        {/* Random delay start */}
        <div style={{ marginBottom: 16 }}>
          <label className="check-row">
            <input
              type="checkbox"
              checked={randomStart}
              onChange={e => setRandomStart(e.target.checked)}
            />
            <span>Random delay giờ khởi động (mỗi account trễ ngẫu nhiên)</span>
          </label>

          {randomStart && (
            <div className="input-row" style={{ marginTop: 6, paddingLeft: 22 }}>
              <input
                type="number"
                className="input-num"
                value={randomStartMin}
                onChange={e => setRandomStartMin(Number(e.target.value))}
              />
              <span className="unit">-</span>
              <input
                type="number"
                className="input-num"
                value={randomStartMax}
                onChange={e => setRandomStartMax(Number(e.target.value))}
              />
              <span className="unit">phút</span>
            </div>
          )}
        </div>

        {/* Account Selector */}
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

        {/* Action Button */}
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={handleStart}
          disabled={loading || !hasValidLink || selectedAccounts.size === 0}
        >
          {loading ? 'Đang khởi động...' : 'Bắt đầu treo bài học'}
        </button>
      </div>
    </div>
  );
}
