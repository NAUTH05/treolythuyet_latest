import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

export function useSocket() {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState({});
  const [queues, setQueues] = useState({});
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    const socket = io({ path: '/lythuyet/socket.io' });
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

      setLogs(data.logs || []);
    });

    socket.on('log', (entry) => {
      setLogs(prev => {
        const next = [...prev, entry];
        return next.length > 300 ? next.slice(-300) : next;
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

    return () => { socket.disconnect(); };
  }, []);

  return { connected, sessions, queues, logs, setLogs };
}
