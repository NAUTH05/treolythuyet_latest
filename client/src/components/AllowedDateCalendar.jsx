import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildMonthGrid,
  addMonths,
  monthLabel,
  toggleDateSelection,
  paintDateSelection,
  todayISO,
} from '../autoscanCalendar.mjs';

const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

// Lịch chọn ngày học được phép:
//   - Click 1 ngày: bật/tắt ngày đó.
//   - Giữ + kéo: "tô" một dải liên tục (chọn hoặc bỏ chọn tuỳ ô bắt đầu).
// Dùng Pointer Events để chạy được cả chuột lẫn cảm ứng.
export default function AllowedDateCalendar({ value = [], onChange }) {
  const today = useMemo(() => todayISO(), []);
  const anchorIso = value.length > 0 ? [...value].sort()[0] : today;
  const [view, setView] = useState(() => {
    const [y, m] = anchorIso.split('-').map(Number);
    return { year: y, month: m };
  });
  const selectedSet = useMemo(() => new Set(value), [value]);
  const dragRef = useRef({ active: false, mode: 'select', anchor: null });

  // Kết thúc kéo dù pointerup xảy ra ngoài lịch → không bao giờ kẹt trạng thái.
  useEffect(() => {
    const stop = () => {
      dragRef.current.active = false;
      dragRef.current.anchor = null;
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  const weeks = buildMonthGrid(view.year, view.month);

  const goMonth = (delta) => setView(v => addMonths(v.year, v.month, delta));

  const handlePointerDown = (iso) => (event) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault(); // chặn bôi đen text khi kéo
    const mode = selectedSet.has(iso) ? 'deselect' : 'select';
    dragRef.current = { active: true, mode, anchor: iso };
    onChange(toggleDateSelection(value, iso));
  };

  const handlePointerEnter = (iso) => () => {
    const drag = dragRef.current;
    if (!drag.active || !drag.anchor) return;
    onChange(paintDateSelection(value, drag.anchor, iso, drag.mode));
  };

  return (
    <div className="acal" style={styles.wrap}>
      <div style={styles.header}>
        <button type="button" style={styles.navBtn} onClick={() => goMonth(-1)} aria-label="Tháng trước">‹</button>
        <span style={styles.title}>{monthLabel(view.year, view.month)}</span>
        <button type="button" style={styles.navBtn} onClick={() => goMonth(1)} aria-label="Tháng sau">›</button>
      </div>

      <div style={styles.weekRow}>
        {WEEKDAYS.map(label => (
          <span key={label} style={styles.weekLabel}>{label}</span>
        ))}
      </div>

      <div style={styles.grid} onPointerLeave={() => { /* vẫn giữ kéo: pointerup toàn cục sẽ kết thúc */ }}>
        {weeks.map((week, wi) => (
          <div key={wi} style={styles.week}>
            {week.map(cell => {
              const isSelected = selectedSet.has(cell.iso);
              const isToday = cell.iso === today;
              return (
                <button
                  key={cell.iso}
                  type="button"
                  data-iso={cell.iso}
                  style={{
                    ...styles.cell,
                    ...(cell.inMonth ? {} : styles.cellOutside),
                    ...(isSelected ? styles.cellSelected : {}),
                    ...(isToday && !isSelected ? styles.cellToday : {}),
                  }}
                  onPointerDown={handlePointerDown(cell.iso)}
                  onPointerEnter={handlePointerEnter(cell.iso)}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div style={styles.legend}>
        <span>🖱️ Click để chọn/bỏ • Giữ & kéo để tô cả dải</span>
      </div>
    </div>
  );
}

const styles = {
  wrap: {
    border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
    borderRadius: 10,
    padding: 10,
    background: 'var(--bg-card-subtle, rgba(255,255,255,0.03))',
    userSelect: 'none',
    touchAction: 'none',
  },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { fontWeight: 600 },
  navBtn: {
    width: 30, height: 30, borderRadius: 8, cursor: 'pointer',
    border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
    background: 'transparent', color: 'inherit', fontSize: 18, lineHeight: 1,
  },
  weekRow: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 },
  weekLabel: { textAlign: 'center', fontSize: '0.72rem', opacity: 0.65, padding: '2px 0' },
  grid: { display: 'flex', flexDirection: 'column', gap: 4 },
  week: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 },
  cell: {
    aspectRatio: '1 / 1', border: '1px solid transparent', borderRadius: 8, cursor: 'pointer',
    background: 'var(--bg-card, rgba(255,255,255,0.05))', color: 'inherit',
    fontSize: '0.82rem', display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0,
  },
  cellOutside: { opacity: 0.35 },
  cellSelected: { background: 'var(--accent, #2f80ed)', color: '#fff', fontWeight: 600 },
  cellToday: { border: '1px solid var(--accent, #2f80ed)' },
  legend: { marginTop: 8, fontSize: '0.78rem', opacity: 0.7 },
};
