import { useEffect, useState } from 'react';

const STORAGE_KEY = 'treohoc_settings';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function getTomorrowDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

function parseTimeMinutes(h, m) {
  const hours = parseInt(h, 10) || 0;
  const mins = parseInt(m, 10) || 0;
  return hours * 60 + mins;
}

function formatTimeStr(h, m) {
  const total = parseTimeMinutes(h, m) || 240;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return `${hours}h${mins > 0 ? ` ${mins}m` : ''}`;
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

function convertSavedToBox(savedBox, globalSettings) {
  let urls = [];
  if (savedBox.urls && Array.isArray(savedBox.urls)) {
    urls = savedBox.urls.map(u => ({
      url: u.url || '',
      timeH: u.time ? String(Math.floor(u.time / 60)) : '',
      timeM: u.time ? String(u.time % 60) : '',
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

  const toggleAccount = idx => {
    setSelectedAccounts(prev => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  const selectAllAccounts = () => {
    setSelectedAccounts(new Set(accounts.map(a => a.index)));
  };

  const updateBoxField = (boxIdx, field, val) => {
    setBoxes(prev => {
      const next = [...prev];
      next[boxIdx] = { ...next[boxIdx], [field]: val };
      return next;
    });
  };

  const updateUrlField = (boxIdx, urlIdx, field, val) => {
    setBoxes(prev => {
      const next = [...prev];
      const urls = [...next[boxIdx].urls];
      urls[urlIdx] = { ...urls[urlIdx], [field]: val };
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
            startHour: Number(box.startHour ?? 7),
            refreshInterval: Number(box.refreshInterval || 15),
            stealthInterval: Number(box.stealthInterval || 30),
            timeWindows: box.useTimeWindows ? box.timeWindows || [] : [],
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
  const numStyle = { width: 48, textAlign: 'center', padding: '6px 4px' };

  return (
    <div className="card">
      <div className="card-header">🎮 Điều khiển</div>
      <div className="card-body">
        <div className="form-group">
          <label>📋 Danh sách Box bài học</label>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>
            Mỗi box có nhiều link, mỗi link có thể tuỳ chỉnh thời gian riêng. Mỗi box có cài đặt riêng biệt.
          </div>

          {boxes.map((box, boxIdx) => {
            const defaultBoxTime = parseTimeMinutes(box.timeH, box.timeM) || 240;
            const totalBoxMinutes = box.urls.reduce((acc, u) => {
              const linkTime = u.timeH || u.timeM ? parseTimeMinutes(u.timeH, u.timeM) : defaultBoxTime;
              return acc + linkTime;
            }, 0);

            return (
              <div
                key={boxIdx}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 8,
                  background: 'rgba(255, 255, 255, 0.02)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--primary)' }}>
                    Box {boxIdx + 1} ({box.urls.length} link)
                  </span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      className="btn btn-sm btn-outline"
                      onClick={() => addUrlToBox(boxIdx)}
                      style={{ padding: '2px 8px', fontSize: 11 }}
                    >
                      + Link
                    </button>
                    {boxes.length > 1 && (
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => removeBox(boxIdx)}
                        style={{ padding: '2px 8px', fontSize: 11 }}
                      >
                        ✕ Xóa
                      </button>
                    )}
                  </div>
                </div>

                {box.urls.map((uObj, urlIdx) => (
                  <div key={urlIdx} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: 'var(--text2)', width: 18, textAlign: 'center', flexShrink: 0 }}>
                      {urlIdx + 1}
                    </span>
                    <input
                      type="url"
                      placeholder={`Link bài ${urlIdx + 1}`}
                      value={uObj.url}
                      onChange={e => updateUrlField(boxIdx, urlIdx, 'url', e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <input
                      type="number"
                      value={uObj.timeH}
                      placeholder={box.timeH || '4'}
                      min={0}
                      max={99}
                      onChange={e => updateUrlField(boxIdx, urlIdx, 'timeH', e.target.value)}
                      title="Giờ treo riêng"
                      style={{ ...numStyle, width: 38 }}
                    />
                    <span style={{ fontSize: 11, color: 'var(--text2)' }}>h</span>
                    <input
                      type="number"
                      value={uObj.timeM}
                      placeholder={box.timeM || '0'}
                      min={0}
                      max={59}
                      onChange={e => updateUrlField(boxIdx, urlIdx, 'timeM', e.target.value)}
                      title="Phút treo riêng"
                      style={{ ...numStyle, width: 38 }}
                    />
                    <span style={{ fontSize: 11, color: 'var(--text2)' }}>m</span>
                    {box.urls.length > 1 && (
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => removeUrlFromBox(boxIdx, urlIdx)}
                        style={{ padding: '2px 6px', fontSize: 10, flexShrink: 0 }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}

                <div
                  style={{
                    display: 'flex',
                    gap: 12,
                    marginTop: 6,
                    padding: '6px 8px',
                    background: 'rgba(124, 111, 255, 0.08)',
                    borderRadius: 6,
                    fontSize: 12,
                    color: 'var(--primary)',
                  }}
                >
                  <span>
                    ⏱ Tổng:{' '}
                    <b>
                      {Math.floor(totalBoxMinutes / 60)}h
                      {totalBoxMinutes % 60 > 0 ? ` ${totalBoxMinutes % 60}m` : ''}
                    </b>
                  </span>
                  <span style={{ color: 'var(--text2)' }}>
                    = <b>{totalBoxMinutes} phút</b>
                  </span>
                </div>

                <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <div
                    onClick={() => updateBoxField(boxIdx, 'showOptions', !box.showOptions)}
                    style={{
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      color: 'var(--text2)',
                      userSelect: 'none',
                    }}
                  >
                    <span
                      style={{
                        transform: box.showOptions ? 'rotate(90deg)' : 'none',
                        transition: 'transform 0.2s',
                        fontSize: 14,
                      }}
                    >
                      ▶
                    </span>
                    ⚙️ Cài đặt Box {boxIdx + 1}
                    {!box.showOptions && (
                      <span style={{ fontSize: 10, color: 'var(--text2)', marginLeft: 'auto' }}>
                        {formatTimeStr(box.timeH, box.timeM) || '4h'} · {box.startHour}h · F5 {box.refreshInterval}ph
                        {box.useSchedule && box.scheduleDate ? ' · 📅' : ''}
                      </span>
                    )}
                  </div>

                  {box.showOptions && (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
                        <div>
                          <label style={{ fontSize: 11, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>
                            ⏱ Thời gian mặc định
                          </label>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input
                              type="number"
                              value={box.timeH}
                              min={0}
                              max={99}
                              onChange={e => updateBoxField(boxIdx, 'timeH', e.target.value)}
                              style={numStyle}
                            />
                            <span style={{ fontSize: 11, color: 'var(--text2)' }}>h</span>
                            <input
                              type="number"
                              value={box.timeM}
                              min={0}
                              max={59}
                              onChange={e => updateBoxField(boxIdx, 'timeM', e.target.value)}
                              style={numStyle}
                            />
                            <span style={{ fontSize: 11, color: 'var(--text2)' }}>m</span>
                          </div>
                        </div>

                        <div>
                          <label style={{ fontSize: 11, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>
                            ⏰ Giờ chạy ngày mới
                          </label>
                          <input
                            type="number"
                            value={box.startHour}
                            min={0}
                            max={23}
                            onChange={e => updateBoxField(boxIdx, 'startHour', Number(e.target.value))}
                          />
                        </div>

                        <div>
                          <label style={{ fontSize: 11, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>
                            🔄 F5 mỗi (phút)
                          </label>
                          <input
                            type="number"
                            value={box.refreshInterval}
                            min={1}
                            max={120}
                            onChange={e => updateBoxField(boxIdx, 'refreshInterval', Number(e.target.value))}
                          />
                        </div>

                        <div>
                          <label style={{ fontSize: 11, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>
                            🎭 Stealth (giây)
                          </label>
                          <input
                            type="number"
                            value={box.stealthInterval}
                            min={5}
                            max={300}
                            onChange={e => updateBoxField(boxIdx, 'stealthInterval', Number(e.target.value))}
                          />
                        </div>
                      </div>

                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: 'var(--text2)' }}>
                          <input
                            type="checkbox"
                            checked={box.useTimeWindows || false}
                            onChange={e => updateBoxField(boxIdx, 'useTimeWindows', e.target.checked)}
                            style={{ accentColor: 'var(--primary)' }}
                          />
                          ⏰ Giới hạn khung giờ học
                        </label>

                        {box.useTimeWindows && (
                          <div style={{ marginTop: 6 }}>
                            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4 }}>
                              Bot sẽ F5 lưu checkpoint và tạm dừng khi hết giờ khung học
                            </div>
                            {(box.timeWindows || []).map((tw, twIdx) => (
                              <div key={twIdx} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                                <span style={{ fontSize: 11, color: 'var(--text2)', width: 20, textAlign: 'center' }}>
                                  {twIdx + 1}.
                                </span>
                                <input
                                  type="time"
                                  value={tw.start}
                                  onChange={e => {
                                    const nextTW = [...box.timeWindows];
                                    nextTW[twIdx] = { ...nextTW[twIdx], start: e.target.value };
                                    updateBoxField(boxIdx, 'timeWindows', nextTW);
                                  }}
                                  style={{
                                    flex: 1,
                                    padding: '5px 8px',
                                    background: 'var(--surface2)',
                                    border: '1px solid var(--border)',
                                    borderRadius: 6,
                                    color: 'var(--text)',
                                    fontSize: 12,
                                  }}
                                />
                                <span style={{ fontSize: 11, color: 'var(--text2)' }}>→</span>
                                <input
                                  type="time"
                                  value={tw.end}
                                  onChange={e => {
                                    const nextTW = [...box.timeWindows];
                                    nextTW[twIdx] = { ...nextTW[twIdx], end: e.target.value };
                                    updateBoxField(boxIdx, 'timeWindows', nextTW);
                                  }}
                                  style={{
                                    flex: 1,
                                    padding: '5px 8px',
                                    background: 'var(--surface2)',
                                    border: '1px solid var(--border)',
                                    borderRadius: 6,
                                    color: 'var(--text)',
                                    fontSize: 12,
                                  }}
                                />
                                {(box.timeWindows || []).length > 1 && (
                                  <button
                                    className="btn btn-sm btn-danger"
                                    onClick={() =>
                                      updateBoxField(
                                        boxIdx,
                                        'timeWindows',
                                        box.timeWindows.filter((_, i) => i !== twIdx)
                                      )
                                    }
                                    style={{ padding: '2px 6px', fontSize: 10, flexShrink: 0 }}
                                  >
                                    ✕
                                  </button>
                                )}
                              </div>
                            ))}
                            <button
                              className="btn btn-sm btn-outline"
                              onClick={() =>
                                updateBoxField(boxIdx, 'timeWindows', [
                                  ...(box.timeWindows || []),
                                  { start: '07:00', end: '23:00' },
                                ])
                              }
                              style={{ padding: '2px 10px', fontSize: 11, marginTop: 2 }}
                            >
                              + Thêm khung giờ
                            </button>
                          </div>
                        )}
                      </div>

                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: 'var(--text2)' }}>
                          <input
                            type="checkbox"
                            checked={box.useSchedule || false}
                            onChange={e => {
                              const checked = e.target.checked;
                              setBoxes(prev => {
                                const next = [...prev];
                                next[boxIdx] = {
                                  ...next[boxIdx],
                                  useSchedule: checked,
                                };
                                if (checked && !next[boxIdx].scheduleDate) {
                                  next[boxIdx].scheduleDate = getTomorrowDateStr();
                                }
                                return next;
                              });
                            }}
                            style={{ accentColor: 'var(--primary)' }}
                          />
                          📅 Hẹn ngày giờ bắt đầu box này
                        </label>

                        {box.useSchedule && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
                            <div>
                              <label style={{ fontSize: 11, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>
                                📆 Ngày
                              </label>
                              <input
                                type="date"
                                value={box.scheduleDate}
                                onChange={e => updateBoxField(boxIdx, 'scheduleDate', e.target.value)}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: 11, color: 'var(--text2)', display: 'block', marginBottom: 3 }}>
                                🕐 Giờ
                              </label>
                              <input
                                type="time"
                                value={box.scheduleTime}
                                onChange={e => updateBoxField(boxIdx, 'scheduleTime', e.target.value)}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          <button className="btn btn-outline" onClick={addBox} style={{ marginTop: 4, width: '100%' }}>
            ➕ Thêm box
          </button>
        </div>

        <div className="form-group">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 0 }}>
            <input
              type="checkbox"
              className="account-check"
              checked={randomStart}
              onChange={e => setRandomStart(e.target.checked)}
            />
            🎲 Random Start Time{' '}
            <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 400 }}>(tránh cố định giờ)</span>
          </label>

          {randomStart && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 10 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 4 }}>
                  Delay tối thiểu (phút)
                </label>
                <input
                  type="number"
                  value={randomStartMin}
                  min={0}
                  max={120}
                  onChange={e => setRandomStartMin(Number(e.target.value))}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text2)', display: 'block', marginBottom: 4 }}>
                  Delay tối đa (phút)
                </label>
                <input
                  type="number"
                  value={randomStartMax}
                  min={0}
                  max={120}
                  onChange={e => setRandomStartMax(Number(e.target.value))}
                />
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
              accounts.map(acc => (
                <label
                  key={acc.index}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', cursor: 'pointer', fontSize: 14 }}
                >
                  <input
                    type="checkbox"
                    className="account-check"
                    checked={selectedAccounts.has(acc.index)}
                    onChange={() => toggleAccount(acc.index)}
                  />
                  {acc.name}{' '}
                  <span style={{ color: 'var(--text2)', fontSize: 12 }}>({acc.email})</span>
                </label>
              ))
            )}
          </div>
        </div>

        <div className="btn-group">
          <button
            className="btn btn-primary"
            disabled={loading || !hasValidLink || selectedAccounts.size === 0}
            onClick={handleStart}
          >
            {loading ? '⏳ Đang khởi động...' : '🚀 Bắt đầu treo'}
          </button>
          <button className="btn btn-outline" onClick={selectAllAccounts}>
            ☑ Chọn tất cả
          </button>
        </div>
      </div>
    </div>
  );
}
