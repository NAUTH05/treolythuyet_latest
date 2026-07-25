export default function ToastContainer({ toasts }) {
  const styles = {
    success: { background: '#1a1a1a', borderLeftColor: '#1a6640' },
    error:   { background: '#1a1a1a', borderLeftColor: '#b83232' },
    info:    { background: '#1a1a1a', borderLeftColor: '#2e7fc1' },
  };

  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div
          key={t.id}
          className="toast"
          style={styles[t.type] || styles.info}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}
