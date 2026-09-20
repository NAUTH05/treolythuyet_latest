import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

export function useSocket() {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState({});
  const [queues, setQueues] = useState({});
  const [autoScans, setAutoScans] = useState({});
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    const socket = io({
      path: '/socket.io',
      auth: { token: sessionStorage.getItem('treohoc_admin_token') || '' },
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('init', (data) => {
      const sessionMap = {};
      data.sessions.forEach(s => { sessionMap[s.id] = s; });
      setSessions(sessionMap);

      const queueMap = {};
      (data.queues || []).forEach(q => { queueMap[q.id] = q; });
      setQueues(queueMap);

      const autoScanMap = {};
      (data.autoScans || []).forEach(s => { autoScanMap[s.id] = s; });
      setAutoScans(autoScanMap);

      setLogs(data.logs || []);
    });

    socket.on('log', (entry) => {
      setLogs(prev => {
        const next = [...prev, entry];
        // Trần bộ nhớ realtime: lịch sử đầy đủ được tải theo trang qua /api/logs/history.
        return next.length > 500 ? next.slice(-500) : next;
      });
    });

    socket.on('session-status', (status) => {
      setSessions(prev => ({ ...prev, [status.id]: status }));
    });

    socket.on('session-done', (status) => {
      setSessions(prev => ({ ...prev, [status.id]: status }));
    });

    socket.on('queue-update', (queue) => {
      setQueues(prev => ({ ...prev, [queue.id]: queue }));
    });

    socket.on('autoscan-status', (status) => {
      setAutoScans(prev => ({ ...prev, [status.id]: status }));
    });

    socket.on('autoscan-removed', (id) => {
      setAutoScans(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    });

    return () => { socket.disconnect(); };
  }, []);

  return { connected, sessions, queues, autoScans, logs, setLogs };
}
