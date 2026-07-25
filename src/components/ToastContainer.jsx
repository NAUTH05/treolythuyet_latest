export default function ToastContainer({ toasts }) {
  const borderColors = {
    success: 'var(--success)',
    error: 'var(--danger)',
    info: 'var(--primary)',
  };

  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div
          key={t.id}
          className="toast"
          style={{ borderLeftColor: borderColors[t.type] || 'var(--border)' }}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}
