const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { BotSession } = require('./bot');
const { AutoCourseSession } = require('./autoCourseEngine');
const { isAllowedStudyDate, getNextAllowedStudyDate } = require('./courseScanner');
const fbService = require('./firebase-service');

const ADMIN_CONFIG_FILE = path.join(__dirname, 'admin-config.json');

function getAdminConfig() {
  if (!fs.existsSync(ADMIN_CONFIG_FILE)) {
    return { adminPassword: 'admin123' };
  }
  try {
    return JSON.parse(fs.readFileSync(ADMIN_CONFIG_FILE, 'utf8'));
  } catch {
    return { adminPassword: 'admin123' };
  }
}

function saveAdminConfig(cfg) {
  try {
    fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('[ADMIN] Không thể lưu admin config:', e.message);
  }
}

// =================== PRESETS PERSISTENCE ===================

const PRESETS_FILE = path.join(__dirname, 'presets.json');

function loadPresets() {
  if (!fs.existsSync(PRESETS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')).presets || [];
  } catch {
    return [];
  }
}

function savePresets(presets) {
  try {
    fs.writeFileSync(PRESETS_FILE, JSON.stringify({ presets }, null, 2), 'utf8');
    const fbConfig = fbService.loadFirebaseConfig();
    if (fbConfig && fbConfig.projectId) {
      fbService.syncToFirebaseREST('system_presets', 'list', { presets, updatedAt: new Date().toISOString() }, fbConfig);
    }
  } catch (e) {
    console.error('[PRESETS] Không thể lưu presets:', e.message);
  }
}

// ============================================================
//  WEB SERVER - Dashboard quản lý bot
// ============================================================

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: '/lythuyet/socket.io',
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use('/lythuyet', express.static(path.join(__dirname, 'public')));

// ======================== STATE =============================

const sessions = new Map();   // sessionId -> BotSession
const logHistory = [];         // Lưu 500 dòng log gần nhất
const MAX_LOG = 500;

function addLog(entry) {
  logHistory.push(entry);
  if (logHistory.length > MAX_LOG) logHistory.shift();
  io.emit('log', entry);

  // Auto sync to Firebase if configured
  const fbConfig = fbService.loadFirebaseConfig();
  if (fbConfig && fbConfig.projectId) {
    fbService.syncToFirebaseREST('system_logs', 'latest', { logs: logHistory.slice(-100), updatedAt: new Date().toISOString() }, fbConfig);
  }
}

// ===================== QUEUE MGMT ==========================

const queues = new Map();   // queueId -> queue data

// =================== QUEUE STATE PERSISTENCE ==============

const QUEUE_STATE_FILE = path.join(__dirname, 'queue-state.json');

function saveQueueState() {
  try {
    const state = [];
    for (const [id, queue] of queues) {
      state.push({
        id: queue.id,
        account: queue.account,
        accountIndex: queue.accountIndex,
        pairs: queue.pairs,
        currentPairIndex: queue.currentPairIndex,
        startHour: queue.startHour,
        options: queue.options,
        status: queue.status,
        nextRunTime: queue.nextRunTime ? queue.nextRunTime.toISOString() : null,
        pairStartedAt: queue.pairStartedAt ? queue.pairStartedAt.toISOString() : null,
        lastRefreshAt: queue.lastRefreshAt ? queue.lastRefreshAt.toISOString() : null,
        pausedFromStatus: queue.pausedFromStatus || null,
        completedAt: queue.completedAt || null,
        timeLimitData: queue.timeLimitData || null,
        logs: (queue.logs || []).slice(-200),
        createdAt: queue.createdAt.toISOString(),
      });
    }
    fs.writeFileSync(QUEUE_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');

    // Auto sync to Firebase if configured
    const fbConfig = fbService.loadFirebaseConfig();
    if (fbConfig && fbConfig.projectId) {
      fbService.syncToFirebaseREST('system_queues', 'state', { queues: state, updatedAt: new Date().toISOString() }, fbConfig);
    }
  } catch (e) {
    console.error('[STATE] Không thể lưu queue state:', e.message);
  }
}

function loadAndRestoreQueues() {
  if (!fs.existsSync(QUEUE_STATE_FILE)) return;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(QUEUE_STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('[STATE] Không thể đọc queue state:', e.message);
    return;
  }

  const now = new Date();
  let active = 0;

  for (const saved of state) {
    const queue = {
      id: saved.id,
      account: saved.account,
      accountIndex: saved.accountIndex,
      pairs: saved.pairs,
      currentPairIndex: saved.currentPairIndex,
      startHour: saved.startHour,
      options: saved.options || { time: 240, refreshInterval: 15, stealthInterval: 30 },
      status: saved.status,
      pausedFromStatus: saved.pausedFromStatus || null,
      nextRunTime: saved.nextRunTime ? new Date(saved.nextRunTime) : null,
      currentSessionId: null,
      timer: null,
      completedAt: saved.completedAt || null,
      timeLimitData: saved.timeLimitData || null,
      logs: saved.logs || [],
      createdAt: new Date(saved.createdAt),
    };

    queues.set(queue.id, queue);

    if (saved.status === 'paused') {
      // Queue was paused when server stopped → treat like waiting, resume on next start
      const prevStatus = saved.pausedFromStatus || 'running';
      if (prevStatus === 'running') {
        // Was running a session → need to restart the pair
        queue.status = 'waiting';
        queue.pausedFromStatus = null;
        logHistory.push({
          timestamp: formatVN(new Date()),
          account: queue.account.name,
          msg: `🔄 Server restart - queue đang tạm dừng → chạy lại box ${queue.currentPairIndex + 1}`,
          level: 'warn',
        });
        setTimeout(() => { if (queue.status === 'waiting') startPairForQueue(queue); }, 5000);
      } else {
        // Was waiting → restore as waiting
        queue.status = 'waiting';
        queue.pausedFromStatus = null;
        const nextRun = queue.nextRunTime;
        const delay = nextRun ? nextRun.getTime() - new Date().getTime() : -1;
        if (delay > 0) {
          queue.timer = setTimeout(() => { if (queue.status === 'waiting') startPairForQueue(queue); }, delay);
        } else {
          setTimeout(() => { if (queue.status === 'waiting') startPairForQueue(queue); }, 3000);
        }
      }
      active++;
    } else if (saved.status === 'running') {
      // Tính thời gian còn lại — rollback về checkpoint F5 gần nhất
      // Vì hệ thống chỉ ghi nhận thời gian tại mỗi lần F5,
      // thời gian giữa F5 cuối và lúc restart bị mất → cần treo lại đoạn đó
      const pairOpts = saved.pairs?.[saved.currentPairIndex]?.pairOptions || {};
      const fullMs = (pairOpts.time || saved.options?.time || 240) * 60 * 1000;
      const refreshIntervalMs = (pairOpts.refreshInterval || saved.options?.refreshInterval || 15) * 60 * 1000;
      const pairStartedAt = saved.pairStartedAt ? new Date(saved.pairStartedAt) : null;
      const lastRefreshAt = saved.lastRefreshAt ? new Date(saved.lastRefreshAt) : null;

      // Tính elapsed dựa trên checkpoint F5 cuối cùng
      let effectiveElapsedMs;
      if (lastRefreshAt && pairStartedAt) {
        // Rollback: chỉ tính thời gian đến lần F5 cuối (checkpoint)
        const timeSinceLastF5 = now.getTime() - lastRefreshAt.getTime();
        if (timeSinceLastF5 < refreshIntervalMs) {
          // Chưa đủ 1 chu kỳ F5 kể từ lần F5 cuối → rollback về F5 cuối
          effectiveElapsedMs = lastRefreshAt.getTime() - pairStartedAt.getTime();
          logHistory.push({
            timestamp: formatVN(new Date()),
            account: queue.account.name,
            msg: `⏪ Rollback về F5 cuối (${Math.round(timeSinceLastF5 / 60000)} phút chưa ghi nhận bị mất)`,
            level: 'warn',
          });
        } else {
          effectiveElapsedMs = now.getTime() - pairStartedAt.getTime();
        }
      } else if (pairStartedAt) {
        // Chưa có lần F5 nào → kiểm tra nếu chạy chưa đủ 1 chu kỳ F5
        const totalElapsed = now.getTime() - pairStartedAt.getTime();
        if (totalElapsed < refreshIntervalMs) {
          // Chưa có F5 nào, toàn bộ thời gian chưa được ghi nhận → chạy lại từ đầu
          effectiveElapsedMs = 0;
          logHistory.push({
            timestamp: formatVN(new Date()),
            account: queue.account.name,
            msg: `⏪ Chưa có F5 nào, chạy lại từ đầu (${Math.round(totalElapsed / 60000)} phút chưa ghi nhận)`,
            level: 'warn',
          });
        } else {
          effectiveElapsedMs = totalElapsed;
        }
      } else {
        effectiveElapsedMs = fullMs;
      }

      const remainingMs = Math.max(0, fullMs - effectiveElapsedMs);
      const remainingMinutes = Math.ceil(remainingMs / 60000);

      queue.status = 'waiting';
      queue.nextRunTime = null;
      queue.lastRefreshAt = null; // Reset cho lần chạy mới

      if (remainingMinutes < 2) {
        // Còn dưới 2 phút → coi như xong, chuyển cặp tiếp
        logHistory.push({
          timestamp: formatVN(new Date()),
          account: queue.account.name,
          msg: `✅ Server restart - box ${queue.currentPairIndex + 1} coi như hoàn thành (còn <2 phút), chuyển box tiếp...`,
          level: 'info',
        });
        setTimeout(() => scheduleNextPair(queue), 3000);
      } else {
        queue.resumeMinutes = remainingMinutes;
        logHistory.push({
          timestamp: formatVN(new Date()),
          account: queue.account.name,
          msg: `🔄 Server restart - tiếp tục box ${queue.currentPairIndex + 1} (còn ${remainingMinutes} phút) sau 5 giây...`,
          level: 'warn',
        });
        setTimeout(() => { if (queue.status === 'waiting') startPairForQueue(queue); }, 5000);
      }
      active++;
    } else if (saved.status === 'time-limit') {
      // Queue đang chờ khung giờ tiếp theo
      const nextRun = queue.nextRunTime;
      const delay = nextRun ? nextRun.getTime() - now.getTime() : -1;
      logHistory.push({
        timestamp: formatVN(new Date()),
        account: queue.account.name,
        msg: `⏰ Khôi phục queue đang quá giờ ${delay > 0 ? `→ tiếp tục lúc ${formatVN(nextRun)}` : '→ chạy ngay'}`,
        level: 'warn',
      });
      if (delay > 0) {
        queue.timer = setTimeout(() => {
          if (queue.status === 'time-limit') {
            queue.resumeFromTimeLimit = queue.timeLimitData;
            delete queue.timeLimitData;
            startPairForQueue(queue);
          }
        }, delay);
      } else {
        setTimeout(() => {
          if (queue.status === 'time-limit') {
            queue.resumeFromTimeLimit = queue.timeLimitData;
            delete queue.timeLimitData;
            startPairForQueue(queue);
          }
        }, 3000);
      }
      active++;
    } else if (saved.status === 'waiting') {
      const nextRun = queue.nextRunTime;
      const delay = nextRun ? nextRun.getTime() - now.getTime() : -1;
      if (delay <= 0) {
        logHistory.push({
          timestamp: formatVN(new Date()),
          account: queue.account.name,
          msg: `🔄 Khôi phục hàng chờ (quá giờ) → chạy ngay box ${queue.currentPairIndex + 1}/${queue.pairs.length}`,
          level: 'info',
        });
        setTimeout(() => { if (queue.status === 'waiting') startPairForQueue(queue); }, 3000);
      } else {
        logHistory.push({
          timestamp: formatVN(new Date()),
          account: queue.account.name,
          msg: `🔄 Khôi phục hàng chờ → box ${queue.currentPairIndex + 1}/${queue.pairs.length} chạy lúc ${formatVN(nextRun)}`,
          level: 'info',
        });
        queue.timer = setTimeout(() => { if (queue.status === 'waiting') startPairForQueue(queue); }, delay);
      }
      active++;
    }
    // completed / cancelled / error → khôi phục để hiển thị lại trên UI
  }

  if (state.length > 0) {
    console.log(`[STATE] Khôi phục ${state.length} queue (${active} đang chờ/chạy).`);
  }
}

// Wrapper: emit queue-update VÀ persist state cùng lúc
function updateQueue(queue) {
  io.emit('queue-update', getQueueStatus(queue));
  saveQueueState();
}

function getQueueStatus(queue) {
  return {
    id: queue.id,
    account: queue.account.name,
    pairs: queue.pairs,
    currentPairIndex: queue.currentPairIndex,
    totalPairs: queue.pairs.length,
    startHour: queue.startHour,
    status: queue.status,
    pausedFromStatus: queue.pausedFromStatus || null,
    nextRunTime: queue.nextRunTime ? queue.nextRunTime.toISOString() : null,
    currentSessionId: queue.currentSessionId,
    createdAt: queue.createdAt.toISOString(),
    completedAt: queue.completedAt || null,
    randomStartMin: queue.options.randomStartMin,
    randomStartMax: queue.options.randomStartMax,
    options: {
      time: queue.options.time,
      refreshInterval: queue.options.refreshInterval,
      stealthInterval: queue.options.stealthInterval,
    },
  };
}

// ===================== TIMEZONE HELPER =====================

// Tính thời điểm startHour:00 giờ Việt Nam (UTC+7) tiếp theo
function getNextVietnamRun(startHour) {
  const now = new Date();
  // Giờ VN hiện tại (trả về "fake" Date nhưng giờ đúng VN)
  const vnNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));

  // Mặc định: ngày mai lúc startHour:00 VN
  const vnTarget = new Date(vnNow);
  vnTarget.setDate(vnTarget.getDate() + 1);
  vnTarget.setHours(startHour, 0, 0, 0);

  // Nếu hôm nay chưa đến giờ startHour (giờ VN) thì chạy hôm nay
  const vnToday = new Date(vnNow);
  vnToday.setHours(startHour, 0, 0, 0);
  if (vnNow < vnToday) {
    vnTarget.setTime(vnToday.getTime());
  }

  // Delay tính bằng hiệu giờ VN
  const delay = vnTarget.getTime() - vnNow.getTime();
  // Thời điểm thực (UTC) = now + delay
  const realTarget = new Date(now.getTime() + delay);

  return { target: realTarget, delay };
}

// Format giờ theo Việt Nam
function formatVN(date) {
  return date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// Tính ms đến thời điểm bắt đầu của khung giờ tiếp theo (VN timezone)
function calcNextWindowMs(timeWindows) {
  if (!timeWindows || !timeWindows.length) return 0;
  const now = new Date();
  const vnNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const nowMins = vnNow.getHours() * 60 + vnNow.getMinutes();
  const nowSecs = vnNow.getSeconds();
  const sorted = [...timeWindows]
    .map(w => { const [sh, sm] = w.start.split(':').map(Number); return { ...w, startMins: sh * 60 + sm }; })
    .sort((a, b) => a.startMins - b.startMins);
  for (const w of sorted) {
    if (w.startMins > nowMins) {
      const ms = (w.startMins - nowMins) * 60000 - nowSecs * 1000;
      return Math.max(1000, ms);
    }
  }
  // Tất cả các khung đã qua hôm nay → khung đầu ngày mai
  const first = sorted[0];
  const minsUntilTomorrow = (24 * 60 - nowMins) + first.startMins;
  const ms = minsUntilTomorrow * 60000 - nowSecs * 1000;
  return Math.max(1000, ms);
}

// Tính ms còn lại trong khung giờ hiện tại (-1 = không giới hạn, -2 = ngoài tất cả các khung)
function calcMsRemainingInWindow(timeWindows) {
  if (!timeWindows || !timeWindows.length) return -1;
  const now = new Date();
  const vnNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const nowMins = vnNow.getHours() * 60 + vnNow.getMinutes();
  const nowSecs = vnNow.getSeconds();
  for (const w of timeWindows) {
    const [sh, sm] = w.start.split(':').map(Number);
    const [eh, em] = w.end.split(':').map(Number);
    const startMins = sh * 60 + sm;
    const endMins = eh * 60 + em;
    if (nowMins >= startMins && nowMins < endMins) {
      return Math.max(0, (endMins - nowMins) * 60000 - nowSecs * 1000);
    }
  }
  return -2; // Ngoài tất cả các khung giờ
}

// Thêm random delay vào baseDelay (ms). options.randomStartMin/Max là phút.
function applyRandomDelay(baseDelay, options) {
  const min = options.randomStartMin;
  const max = options.randomStartMax;
  if (min == null || max == null || max <= min) return baseDelay;
  const extraMs = Math.floor(Math.random() * (max - min) * 60000) + min * 60000;
  return baseDelay + extraMs;
}

function startPairForQueue(queue) {
  // Kiểm tra xung đột: nếu account đang có session chạy từ queue khác → đợi
  const conflictSession = [...sessions.values()].find(
    s => s.account.email === queue.account.email && (s.status === 'running' || s.status === 'logging-in')
  );
  if (conflictSession) {
    addLog({
      timestamp: formatVN(new Date()),
      account: queue.account.name,
      msg: `⏳ Account đang chạy từ lịch khác, chờ 5 phút rồi thử lại...`,
      level: 'warn',
    });
    queue.timer = setTimeout(() => {
      if (queue.status === 'waiting') startPairForQueue(queue);
    }, 5 * 60 * 1000); // Chờ 5 phút rồi thử lại
    return;
  }

  const pair = queue.pairs[queue.currentPairIndex];
  // Hỗ trợ format mới { urls: [{url, time}] } và cũ { url1, url2 }
  const pairUrls = pair.urls
    ? pair.urls.filter(u => u.url).map(u => ({ url: u.url, time: u.time || null }))
    : [pair.url1, pair.url2].filter(Boolean).map(url => ({ url, time: null }));
  const urls = pairUrls.map(u => u.url);
  const perUrlTimes = pairUrls.map(u => u.time); // null = dùng default

  // Debug: log raw pair.urls để kiểm tra data từ client
  // Debug: log raw pair.urls để kiểm tra data từ client
  const sessionId = `${queue.account.name}_p${queue.currentPairIndex + 1}_${Date.now()}`;

  // Per-pair options override queue-level options
  const pairOpts = pair.pairOptions || {};
  const effectiveTime = pairOpts.time || queue.options.time || 240;
  const effectiveRefresh = pairOpts.refreshInterval || queue.options.refreshInterval || 30;
  const effectiveStealth = pairOpts.stealthInterval || queue.options.stealthInterval || 30;
  // Toggle Stealth/Anti-detection: mặc định BẬT cho Queue thủ công, tắt khi box chọn tắt
  const effectiveStealthMode = pairOpts.stealth != null ? pairOpts.stealth !== false : (queue.options.stealth !== false);

  // Khi resume sau restart: chỉ URL đầu tiên (đang bị gián đoạn) dùng resumeMinutes,
  // các URL còn lại trong box vẫn dùng effectiveTime đầy đủ
  const isResume = !!queue.resumeMinutes;
  const resumeMinutes = queue.resumeMinutes;
  delete queue.resumeMinutes;

  const durationMinutes = effectiveTime; // fallback cho BotSession
  let finalPerUrlTimes = isResume
    ? perUrlTimes.map((t, i) => i === 0 ? resumeMinutes : (t || effectiveTime))
    : perUrlTimes;

  // Xử lý tiếp tục sau time-limit: bỏ qua các bài đã xong, tiếp tục từ bài hiện tại
  let startLessonIndex = 0;
  if (queue.resumeFromTimeLimit) {
    const { currentLessonIndex, remainingMs } = queue.resumeFromTimeLimit;
    delete queue.resumeFromTimeLimit;
    startLessonIndex = currentLessonIndex;
    finalPerUrlTimes = perUrlTimes.map((t, i) => {
      if (i < currentLessonIndex) return 0; // Bài đã hoàn thành trước đó
      if (i === currentLessonIndex) return Math.max(1, Math.ceil(remainingMs / 60000)); // Phần còn lại
      return t || effectiveTime; // Bài tiếp theo: thời gian đầy đủ
    });
    addLog({
      timestamp: formatVN(new Date()),
      account: queue.account.name,
      msg: `⏰ Tiếp tục box ${queue.currentPairIndex + 1} từ bài ${currentLessonIndex + 1} (còn ${Math.ceil(remainingMs / 60000)} phút)`,
      level: 'info',
    });
  }

  // Kiểm tra khung giờ trước khi tạo session
  const pairTimeWindows = (pairOpts).timeWindows || [];
  if (pairTimeWindows.length > 0) {
    const windowRemaining = calcMsRemainingInWindow(pairTimeWindows);
    if (windowRemaining === -2) {
      const nextWindowMs = calcNextWindowMs(pairTimeWindows);
      const resumeTime = new Date(Date.now() + nextWindowMs);
      addLog({
        timestamp: formatVN(new Date()),
        account: queue.account.name,
        msg: `⏰ Ngoài khung giờ học — chờ đến ${formatVN(resumeTime)}`,
        level: 'warn',
      });
      if (!queue.timeLimitData) {
        queue.timeLimitData = { currentLessonIndex: startLessonIndex, remainingMs: finalPerUrlTimes.slice(startLessonIndex).reduce((s, t) => s + (t || effectiveTime) * 60000, 0) };
      }
      queue.status = 'time-limit';
      queue.nextRunTime = resumeTime;
      queue.currentSessionId = null;
      updateQueue(queue);
      queue.timer = setTimeout(() => {
        if (queue.status === 'time-limit') {
          queue.resumeFromTimeLimit = queue.timeLimitData;
          delete queue.timeLimitData;
          startPairForQueue(queue);
        }
      }, nextWindowMs);
      return;
    }
  }

  queue.pairStartedAt = new Date();
  queue.lastRefreshAt = null; // Reset cho pair mới

  const session = new BotSession(sessionId, queue.account, urls, {
    headless: true,
    durationMinutes,
    perUrlTimes: finalPerUrlTimes,
    refreshInterval: effectiveRefresh,
    stealth: effectiveStealthMode,
    stealthInterval: effectiveStealth,
    startLessonIndex,
    timeWindows: pairTimeWindows,
  });

  if (isResume) {
    session.once('log', () => { }); // ensure emitter ready
    addLog({
      timestamp: formatVN(new Date()),
      account: queue.account.name,
      msg: `▶️ Tiếp tục box ${queue.currentPairIndex + 1} - bài 1 còn ${resumeMinutes} phút, ${urls.length > 1 ? `bài 2-${urls.length} đủ ${effectiveTime} phút` : ''}`,
      level: 'info',
    });
  }

  queue.currentSessionId = sessionId;
  queue.status = 'running';

  session.on('log', (entry) => {
    addLog(entry);
    if (!queue.logs) queue.logs = [];
    queue.logs.push(entry);
    if (queue.logs.length > 200) queue.logs.shift();
  });
  session.on('status', (status) => io.emit('session-status', status));
  session.on('refresh', (data) => {
    queue.lastRefreshAt = new Date();
    saveQueueState();
    io.emit('session-refresh', data);
  });
  session.on('done', (status) => {
    io.emit('session-done', status);
    if (status.status === 'completed') {
      scheduleNextPair(queue);
    } else if (queue.status === 'running') {
      queue.status = status.status === 'error' ? 'error' : 'cancelled';
      queue.completedAt = new Date().toISOString();
      updateQueue(queue);
    }
    setTimeout(() => sessions.delete(sessionId), 5 * 60 * 1000);
  });

  // Xử lý sự kiện hết giờ khung học
  session.on('time-limit', (data) => {
    io.emit('session-done', { ...session.getStatus(), status: 'time-limit' });
    const timeWindows = (pair.pairOptions || {}).timeWindows || [];
    const nextWindowMs = calcNextWindowMs(timeWindows);
    const resumeTime = new Date(Date.now() + nextWindowMs);
    queue.timeLimitData = {
      currentLessonIndex: data.currentLessonIndex,
      remainingMs: data.remainingMs,
    };
    queue.status = 'time-limit';
    queue.nextRunTime = resumeTime;
    queue.currentSessionId = null;
    addLog({
      timestamp: formatVN(new Date()),
      account: queue.account.name,
      msg: `⏰ Box ${queue.currentPairIndex + 1} đã chạm giới hạn khung giờ học — tiếp tục lúc ${formatVN(resumeTime)}`,
      level: 'warn',
    });
    updateQueue(queue);
    queue.timer = setTimeout(() => {
      if (queue.status === 'time-limit') {
        queue.resumeFromTimeLimit = queue.timeLimitData;
        delete queue.timeLimitData;
        startPairForQueue(queue);
      }
    }, nextWindowMs);
    setTimeout(() => sessions.delete(sessionId), 5 * 60 * 1000);
  });

  sessions.set(sessionId, session);
  session.start().catch((err) => {
    addLog({
      timestamp: formatVN(new Date()),
      account: queue.account.name,
      msg: `❌ Lỗi khởi động session: ${err.message}`,
      level: 'error',
    });
    queue.status = 'error';
    queue.completedAt = new Date().toISOString();
    updateQueue(queue);
  });

  addLog({
    timestamp: new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    account: queue.account.name,
    msg: `📋 Bắt đầu box ${queue.currentPairIndex + 1}/${queue.pairs.length}: ${urls.join(' + ')}`,
    level: 'info',
  });
  updateQueue(queue);
}

function scheduleNextPair(queue) {
  // Ghi nhận thời gian hoàn thành của box vừa xong
  if (queue.pairs[queue.currentPairIndex]) {
    queue.pairs[queue.currentPairIndex].completedAt = new Date().toISOString();
  }

  queue.currentPairIndex++;

  if (queue.currentPairIndex >= queue.pairs.length) {
    queue.status = 'completed';
    queue.completedAt = new Date().toISOString();
    queue.currentSessionId = null;
    addLog({
      timestamp: new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      account: queue.account.name,
      msg: `🎉 Hoàn thành tất cả ${queue.pairs.length} box bài!`,
      level: 'success',
    });
    updateQueue(queue);
    return;
  }

  const nextPair = queue.pairs[queue.currentPairIndex];
  const nextPairOpts = nextPair.pairOptions || {};
  const effectiveStartHour = nextPairOpts.startHour != null ? nextPairOpts.startHour : queue.startHour;
  const now = new Date();

  // Nếu cặp tiếp có scheduledDateTime riêng → dùng nó
  if (nextPair.scheduledDateTime) {
    const targetDate = new Date(typeof nextPair.scheduledDateTime === 'number'
      ? nextPair.scheduledDateTime
      : new Date(nextPair.scheduledDateTime).getTime());
    const baseDelay = targetDate.getTime() - now.getTime();

    if (baseDelay <= 0) {
      // Đã quá giờ hẹn → chạy ngay
      addLog({
        timestamp: formatVN(new Date()),
        account: queue.account.name,
        msg: `⏰ Box ${queue.currentPairIndex + 1} đã quá giờ hẹn → chạy ngay`,
        level: 'info',
      });
      queue.status = 'waiting';
      queue.nextRunTime = new Date();
      queue.currentSessionId = null;
      updateQueue(queue);
      setTimeout(() => {
        if (queue.status === 'waiting') startPairForQueue(queue);
      }, 2000);
      return;
    }

    const delay = applyRandomDelay(baseDelay, queue.options);
    const nextRun = new Date(now.getTime() + delay);
    const randomNote = delay > baseDelay ? ` (+${Math.round((delay - baseDelay) / 60000)}m ngẫu nhiên)` : '';

    queue.status = 'waiting';
    queue.nextRunTime = nextRun;
    queue.currentSessionId = null;

    addLog({
      timestamp: formatVN(new Date()),
      account: queue.account.name,
      msg: `📅 Box ${queue.currentPairIndex + 1}/${queue.pairs.length} hẹn chạy lúc ${formatVN(nextRun)}${randomNote}`,
      level: 'info',
    });

    updateQueue(queue);
    queue.timer = setTimeout(() => {
      if (queue.status === 'waiting') startPairForQueue(queue);
    }, delay);
    return;
  }

  // Mặc định: dùng startHour (giờ Việt Nam)
  const { delay: basePairDelay } = getNextVietnamRun(effectiveStartHour);
  const pairDelay = applyRandomDelay(basePairDelay, queue.options);
  const nextRun = new Date(now.getTime() + pairDelay);
  const pairRandomNote = pairDelay > basePairDelay ? ` (+${Math.round((pairDelay - basePairDelay) / 60000)}m ngẫu nhiên)` : '';

  queue.status = 'waiting';
  queue.nextRunTime = nextRun;
  queue.currentSessionId = null;

  addLog({
    timestamp: formatVN(new Date()),
    account: queue.account.name,
    msg: `⏰ Box tiếp (${queue.currentPairIndex + 1}/${queue.pairs.length}) sẽ chạy lúc ${formatVN(nextRun)}${pairRandomNote}`,
    level: 'info',
  });

  updateQueue(queue);

  queue.timer = setTimeout(() => {
    if (queue.status === 'waiting') {
      startPairForQueue(queue);
    }
  }, pairDelay);
}

// ==================== ACCOUNTS MGMT ========================

function loadAccounts() {
  const p = path.join(__dirname, 'accounts.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8')).accounts || [];
}

function saveAccounts(accounts) {
  fs.writeFileSync(
    path.join(__dirname, 'accounts.json'),
    JSON.stringify({ accounts }, null, 2),
    'utf8'
  );

  // Auto sync to Firebase if configured
  const fbConfig = fbService.loadFirebaseConfig();
  if (fbConfig && fbConfig.projectId) {
    fbService.syncToFirebaseREST('system_accounts', 'list', { accounts, updatedAt: new Date().toISOString() }, fbConfig);
  }
}

// ===================== ADMIN & FIREBASE API ==================

// Xác thực Admin password
app.post('/lythuyet/api/admin/verify', (req, res) => {
  const { password } = req.body;
  const cfg = getAdminConfig();
  if (password === cfg.adminPassword) {
    return res.json({ ok: true, token: 'admin_verified_' + Date.now() });
  }
  res.status(401).json({ ok: false, error: 'Mật khẩu Admin không chính xác' });
});

// Đổi mật khẩu Admin
app.post('/lythuyet/api/admin/change-password', (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 4 ký tự' });
  }
  const cfg = getAdminConfig();
  if (oldPassword !== cfg.adminPassword) {
    return res.status(401).json({ error: 'Mật khẩu cũ không chính xác' });
  }
  cfg.adminPassword = newPassword;
  saveAdminConfig(cfg);
  res.json({ ok: true });
});

// Lấy Firebase config & status
app.get('/lythuyet/api/admin/firebase-config', (req, res) => {
  const config = fbService.loadFirebaseConfig();
  res.json({
    config: config || {},
    connected: !!(config && config.projectId && config.apiKey),
  });
});

// Lưu Firebase config
app.post('/lythuyet/api/admin/firebase-config', async (req, res) => {
  const { config } = req.body;
  if (!config || !config.projectId || !config.apiKey) {
    return res.status(400).json({ error: 'Cần nhập ít nhất apiKey và projectId' });
  }
  const saved = fbService.saveFirebaseConfig(config);
  if (saved) {
    // Sync current accounts, state, and logs immediately to Firebase
    const accounts = loadAccounts();
    await fbService.syncToFirebaseREST('system_accounts', 'list', { accounts, updatedAt: new Date().toISOString() }, config);
    await fbService.syncToFirebaseREST('system_logs', 'latest', { logs: logHistory.slice(-100), updatedAt: new Date().toISOString() }, config);
    await fbService.syncToFirebaseREST('system_settings', 'config_info', {
      updatedAt: new Date().toISOString(),
      status: 'connected',
    }, config);

    saveQueueState();
    saveAutoScanState();
    return res.json({ ok: true, connected: true });
  }
  res.status(500).json({ error: 'Không thể lưu file cấu hình Firebase' });
});

// ===================== API ROUTES ==========================

// Lấy danh sách tài khoản
app.get('/lythuyet/api/accounts', (req, res) => {
  const accounts = loadAccounts();
  // Ẩn password khi trả về
  res.json(accounts.map((a, i) => ({
    index: i + 1,
    name: a.name,
    email: a.email,
    hasPassword: !!a.password,
  })));
});

// Thêm tài khoản
app.post('/lythuyet/api/accounts', (req, res) => {
  const { name, email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Cần email và mật khẩu' });
  const accounts = loadAccounts();
  accounts.push({ name: name || email, email, password });
  saveAccounts(accounts);
  res.json({ ok: true, count: accounts.length });
});

// Xóa tài khoản
app.delete('/lythuyet/api/accounts/:index', (req, res) => {
  const idx = parseInt(req.params.index) - 1;
  const accounts = loadAccounts();
  if (idx < 0 || idx >= accounts.length) return res.status(404).json({ error: 'Không tìm thấy' });
  accounts.splice(idx, 1);
  saveAccounts(accounts);
  res.json({ ok: true });
});

// Sửa tài khoản
app.put('/lythuyet/api/accounts/:index', (req, res) => {
  const idx = parseInt(req.params.index) - 1;
  const accounts = loadAccounts();
  if (idx < 0 || idx >= accounts.length) return res.status(404).json({ error: 'Không tìm thấy' });
  const { name, email, password } = req.body;
  if (name) accounts[idx].name = name;
  if (email) accounts[idx].email = email;
  if (password) accounts[idx].password = password;
  saveAccounts(accounts);
  res.json({ ok: true });
});

// Lấy trạng thái tất cả sessions
app.get('/lythuyet/api/sessions', (req, res) => {
  const list = [];
  for (const [id, session] of sessions) {
    list.push(session.getStatus());
  }
  res.json(list);
});

// Bắt đầu treo bài (hàng chờ cặp)
app.post('/lythuyet/api/start', (req, res) => {
  const { pairs, startHour, delayStart, scheduledDateTime, accountIndices, time, refreshInterval, stealthInterval, randomStartMin, randomStartMax } = req.body;

  if (!pairs || !Array.isArray(pairs) || pairs.length === 0) {
    return res.status(400).json({ error: 'Cần ít nhất 1 box bài học' });
  }
  for (const pair of pairs) {
    if (!pair.urls || !Array.isArray(pair.urls) || pair.urls.length === 0 || !pair.urls[0].url) {
      return res.status(400).json({ error: 'Mỗi box cần ít nhất 1 URL' });
    }
  }

  const accounts = loadAccounts();
  if (accounts.length === 0) return res.status(400).json({ error: 'Chưa có tài khoản nào' });

  let indices = accountIndices || [1];
  if (indices === 'all' || (Array.isArray(indices) && indices[0] === 'all')) {
    indices = accounts.map((_, i) => i + 1);
  }

  // Kiểm tra xem có bất kỳ pair nào hẹn lịch không
  const hasSchedule = pairs.some(p => p.scheduledDateTime) || scheduledDateTime;

  const started = [];
  for (const idx of indices) {
    const account = accounts[idx - 1];
    if (!account) continue;

    const alreadyRunning = [...sessions.values()].find(
      s => s.account.email === account.email && (s.status === 'running' || s.status === 'logging-in')
    );

    const alreadyQueued = [...queues.values()].find(
      q => q.account.email === account.email && (q.status === 'running' || q.status === 'waiting')
    );

    // Chỉ chặn nếu account đang có session THỰC SỰ CHẠY (running/logging-in) VÀ request mới cũng chạy ngay (không hẹn)
    // Queue ở trạng thái 'waiting' (hẹn lịch ngày sau) KHÔNG chặn tạo queue mới
    const alreadyRunningQueue = [...queues.values()].find(
      q => q.account.email === account.email && q.status === 'running'
    );

    if (alreadyRunning && !hasSchedule) {
      addLog({ timestamp: formatVN(new Date()), account: account.name, msg: '⚠️ Account đang chạy rồi, bỏ qua.', level: 'warn' });
      continue;
    }
    if (alreadyRunningQueue && !hasSchedule) {
      addLog({ timestamp: formatVN(new Date()), account: account.name, msg: '⚠️ Account đã có queue đang chạy, bỏ qua.', level: 'warn' });
      continue;
    }
    if (alreadyRunning) {
      addLog({ timestamp: formatVN(new Date()), account: account.name, msg: '📅 Account đang chạy nhưng tạo thêm lịch hẹn mới.', level: 'info' });
    }
    if (alreadyQueued) {
      addLog({ timestamp: formatVN(new Date()), account: account.name, msg: '📋 Account đã có hàng chờ, tạo thêm queue mới.', level: 'info' });
    }

    // Lấy options từ pair đầu tiên (hoặc fallback về global/default)
    const firstPairOpts = pairs[0].pairOptions || {};
    const queueId = `queue_${account.name}_${Date.now()}`;
    const queue = {
      id: queueId,
      account,
      accountIndex: idx,
      pairs,
      currentPairIndex: 0,
      startHour: firstPairOpts.startHour ?? (startHour != null ? startHour : 7),
      options: {
        time: firstPairOpts.time || time || 240,
        refreshInterval: firstPairOpts.refreshInterval || refreshInterval || 15,
        stealthInterval: firstPairOpts.stealthInterval || stealthInterval || 30,
        randomStartMin,
        randomStartMax,
      },
      status: 'running',
      nextRunTime: null,
      currentSessionId: null,
      timer: null,
      logs: [],
      createdAt: new Date(),
    };

    queues.set(queueId, queue);

    // Kiểm tra lịch: ưu tiên per-pair scheduledDateTime, rồi global scheduledDateTime, rồi delayStart
    const firstPairSchedule = pairs[0].scheduledDateTime;
    const effectiveSchedule = firstPairSchedule || scheduledDateTime;

    if (effectiveSchedule) {
      const targetDate = new Date(typeof effectiveSchedule === 'number'
        ? effectiveSchedule
        : new Date(effectiveSchedule).getTime());
      const now = new Date();
      const baseDelay = targetDate.getTime() - now.getTime();

      if (baseDelay < 0) {
        addLog({
          timestamp: formatVN(new Date()),
          account: account.name,
          msg: `❌ Thời gian hẹn đã quá (${formatVN(targetDate)})`,
          level: 'error',
        });
        queue.status = 'error';
        queue.errorMsg = 'Thời gian hẹn đã quá';
        updateQueue(queue);
        continue;
      }

      const delay = applyRandomDelay(baseDelay, queue.options);
      const actualTarget = new Date(now.getTime() + delay);
      const randomNote = delay > baseDelay ? ` (+${Math.round((delay - baseDelay) / 60000)}m ngẫu nhiên)` : '';
      queue.status = 'waiting';
      queue.nextRunTime = actualTarget;
      addLog({
        timestamp: formatVN(new Date()),
        account: account.name,
        msg: `📅 Hẹn ngày giờ: box 1 sẽ chạy lúc ${formatVN(actualTarget)}${randomNote}`,
        level: 'info',
      });
      updateQueue(queue);
      queue.timer = setTimeout(() => {
        if (queue.status === 'waiting') startPairForQueue(queue);
      }, delay);
    } else if (delayStart) {
      // Legacy: hẹn giờ ngày mai
      const { delay: baseDelay2 } = getNextVietnamRun(queue.startHour);
      const now2 = new Date();
      const delay2 = applyRandomDelay(baseDelay2, queue.options);
      const target2 = new Date(now2.getTime() + delay2);
      const randomNote2 = delay2 > baseDelay2 ? ` (+${Math.round((delay2 - baseDelay2) / 60000)}m ngẫu nhiên)` : '';

      queue.status = 'waiting';
      queue.nextRunTime = target2;
      addLog({
        timestamp: formatVN(new Date()),
        account: account.name,
        msg: `⏰ Hẹn giờ: box 1 sẽ chạy lúc ${formatVN(target2)}${randomNote2}`,
        level: 'info',
      });
      updateQueue(queue);
      queue.timer = setTimeout(() => {
        if (queue.status === 'waiting') startPairForQueue(queue);
      }, delay2);
    } else {
      startPairForQueue(queue);
    }

    started.push({ queueId, account: account.name, pairs: pairs.length });
  }

  res.json({ ok: true, started });
});

// Dừng session
app.post('/lythuyet/api/stop/:id', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session không tìm thấy' });
  await session.stop();
  res.json({ ok: true });
});

// F5 thủ công
app.post('/lythuyet/api/refresh/:id', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session không tìm thấy' });
  if (session.status !== 'running') return res.status(400).json({ error: 'Session không đang chạy' });
  session.autoRefresh();
  res.json({ ok: true });
});

// Tạm dừng session
app.post('/lythuyet/api/pause-session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session không tìm thấy' });
  if (!session.pause()) return res.status(400).json({ error: 'Session không đang chạy' });
  // Cập nhật queue tương ứng
  for (const [, queue] of queues) {
    if (queue.currentSessionId === session.id && queue.status === 'running') {
      queue.status = 'paused';
      queue.pausedFromStatus = 'running';
      updateQueue(queue);
    }
  }
  res.json({ ok: true });
});

// Tiếp tục session
app.post('/lythuyet/api/resume-session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session không tìm thấy' });
  if (!session.resume()) return res.status(400).json({ error: 'Session không đang tạm dừng' });
  for (const [, queue] of queues) {
    if (queue.currentSessionId === session.id && queue.status === 'paused') {
      queue.status = 'running';
      queue.pausedFromStatus = null;
      updateQueue(queue);
    }
  }
  res.json({ ok: true });
});

// D\u1EEBng t\u1EA5t c\u1EA3
app.post('/lythuyet/api/stop-all', async (req, res) => {
  const promises = [];
  for (const [id, session] of sessions) {
    if (session.status === 'running' || session.status === 'logging-in' || session.status === 'paused') {
      promises.push(session.stop());
    }
  }
  for (const [id, queue] of queues) {
    if (queue.status === 'running' || queue.status === 'waiting' || queue.status === 'paused' || queue.status === 'time-limit') {
      if (queue.timer) { clearTimeout(queue.timer); queue.timer = null; }
      queue.status = 'cancelled';
      queue.completedAt = new Date().toISOString();
      queue.nextRunTime = null;
      queue.pausedFromStatus = null;
      updateQueue(queue);
    }
  }
  await Promise.all(promises);
  res.json({ ok: true });
});

// L\u1EA5y h\u00E0ng ch\u1EDD
app.get('/lythuyet/api/queues', (req, res) => {
  const list = [];
  for (const [id, queue] of queues) {
    list.push(getQueueStatus(queue));
  }
  res.json(list);
});

// Get queue log
app.get('/lythuyet/api/queue-log/:id', (req, res) => {
  const queue = queues.get(req.params.id);
  if (!queue) return res.status(404).json({ error: 'Queue not found' });
  res.json(queue.logs || []);
});

// H\u1EE7y h\u00E0ng ch\u1EDD
app.post('/lythuyet/api/cancel-queue/:id', async (req, res) => {
  const queue = queues.get(req.params.id);
  if (!queue) return res.status(404).json({ error: 'Queue kh\u00F4ng t\u00ECm th\u1EA5y' });
  if (queue.timer) { clearTimeout(queue.timer); queue.timer = null; }
  queue.status = 'cancelled';
  queue.completedAt = new Date().toISOString();
  queue.nextRunTime = null;
  queue.pausedFromStatus = null;
  if (queue.currentSessionId) {
    const session = sessions.get(queue.currentSessionId);
    if (session && (session.status === 'running' || session.status === 'logging-in' || session.status === 'paused')) {
      await session.stop();
    }
  }
  updateQueue(queue);
  res.json({ ok: true });
});

// =================== PRESETS API ===========================

// Lấy danh sách Mẫu Preset
app.get('/lythuyet/api/presets', (req, res) => {
  res.json(loadPresets());
});

// Tạo hoặc Cập nhật Mẫu Preset
app.post('/lythuyet/api/presets', (req, res) => {
  const { name, boxes } = req.body;
  if (!name || !boxes || !Array.isArray(boxes) || boxes.length === 0) {
    return res.status(400).json({ error: 'Cần nhập tên Preset và danh sách Box hợp lệ' });
  }

  const presets = loadPresets();
  const newPreset = {
    id: `preset_${Date.now()}`,
    name,
    boxes,
    createdAt: new Date().toISOString(),
  };

  presets.unshift(newPreset);
  savePresets(presets);
  res.json({ ok: true, preset: newPreset });
});

// Xóa Mẫu Preset
app.delete('/lythuyet/api/presets/:id', (req, res) => {
  const { id } = req.params;
  let presets = loadPresets();
  const initialLen = presets.length;
  presets = presets.filter(p => p.id !== id);
  if (presets.length === initialLen) {
    return res.status(404).json({ error: 'Không tìm thấy Preset' });
  }
  savePresets(presets);
  res.json({ ok: true });
});

// =================== DELETE QUEUES API =====================

// Xóa 1 hàng chờ
app.delete('/lythuyet/api/queues/:id', async (req, res) => {
  const queueId = req.params.id;
  const queue = queues.get(queueId);
  if (!queue) return res.status(404).json({ error: 'Hàng chờ không tồn tại' });

  if (queue.timer) clearTimeout(queue.timer);
  if (queue.currentSessionId) {
    const session = sessions.get(queue.currentSessionId);
    if (session) await session.stop();
  }

  queues.delete(queueId);
  saveQueueState();
  io.emit('queue-deleted', queueId);
  res.json({ ok: true });
});

// Xóa tất cả hàng chờ đã hoàn thành / kết thúc / lỗi / hủy
app.post('/lythuyet/api/queues/clear-completed', async (req, res) => {
  let clearedCount = 0;
  for (const [id, queue] of queues) {
    if (queue.status === 'completed' || queue.status === 'cancelled' || queue.status === 'error') {
      if (queue.timer) clearTimeout(queue.timer);
      if (queue.currentSessionId) {
        const session = sessions.get(queue.currentSessionId);
        if (session) await session.stop();
      }
      queues.delete(id);
      clearedCount++;
    }
  }
  saveQueueState();
  io.emit('queues-cleared');
  res.json({ ok: true, count: clearedCount });
});

// =================== AUTO-SCAN COURSES API =================

const autoScanSessions = new Map();
const autoScanResumeTimers = new Map(); // sessionId -> timeout hẹn giờ chạy lại
const AUTOSCAN_STATE_FILE = path.join(__dirname, 'autoscan-state.json');

// Lưu trạng thái Auto-Scan ra file + đồng bộ Firebase (giống Queue thủ công)
function saveAutoScanState() {
  try {
    const state = [];
    for (const [id, s] of autoScanSessions) {
      state.push({
        id: s.id,
        account: s.account,
        coursesConfig: s.coursesConfig,
        options: {
          dailyMaxMinutes: s.options.dailyMaxMinutes,
          allowedDateRanges: s.options.allowedDateRanges,
          newDayStartTime: s.options.newDayStartTime || '06:00',
          refreshInterval: s.options.refreshInterval || 15,
          stealthInterval: s.options.stealthInterval || 30,
          stealth: s.options.stealth === true,
          timeWindows: s.options.timeWindows || [],
        },
        status: s.status,
        pausedFromStatus: s.pausedFromStatus || null,
        currentCourseIndex: s.currentCourseIndex,
        dailyStudiedMinutes: s.dailyStudiedMinutes,
        dailyDate: s.dailyDate || null,
        courseProgress: s.courseProgress,
        nextRunTime: s.nextRunTime || null,
        createdAt: s.createdAt || new Date().toISOString(),
      });
    }
    fs.writeFileSync(AUTOSCAN_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');

    // Auto sync to Firebase if configured
    const fbConfig = fbService.loadFirebaseConfig();
    if (fbConfig && fbConfig.projectId) {
      fbService.syncToFirebaseREST('system_autoscan', 'state', { autoScans: state, updatedAt: new Date().toISOString() }, fbConfig);
    }
  } catch (e) {
    console.error('[STATE] Không thể lưu auto-scan state:', e.message);
  }
}

function clearAutoScanTimer(sessionId) {
  const t = autoScanResumeTimers.get(sessionId);
  if (t) { clearTimeout(t); autoScanResumeTimers.delete(sessionId); }
}

// Hẹn giờ an toàn với delay dài (chia bước 12h tránh tràn int32 của setTimeout)
function scheduleAutoScanTimer(sessionId, fireAt, fn) {
  clearAutoScanTimer(sessionId);
  const MAX_STEP = 12 * 60 * 60 * 1000;
  const delay = Math.max(1000, fireAt.getTime() - Date.now());
  const t = setTimeout(() => {
    autoScanResumeTimers.delete(sessionId);
    if (fireAt.getTime() - Date.now() > 1000) {
      scheduleAutoScanTimer(sessionId, fireAt, fn); // còn xa → hẹn bước tiếp theo
    } else {
      fn();
    }
  }, Math.min(delay, MAX_STEP));
  autoScanResumeTimers.set(sessionId, t);
}

// Tạo + wire một phiên Auto-Scan (dùng chung cho start / restore / resume)
function createAutoScanSession(sessionId, account, courses, options, restoreState = null) {
  const autoSession = new AutoCourseSession(sessionId, account, courses, options);
  autoSession.createdAt = (restoreState && restoreState.createdAt) || new Date().toISOString();
  autoSession.nextRunTime = null;
  if (restoreState) {
    if (restoreState.dailyStudiedMinutes != null) autoSession.dailyStudiedMinutes = restoreState.dailyStudiedMinutes;
    if (restoreState.dailyDate) autoSession.dailyDate = restoreState.dailyDate;
    if (restoreState.courseProgress) autoSession.courseProgress = restoreState.courseProgress;
  }

  autoSession.on('log', (entry) => addLog(entry));
  autoSession.on('status', (status) => {
    // Bỏ qua emit muộn của phiên đã bị xóa khỏi Dashboard để không hồi sinh thẻ
    if (!autoScanSessions.has(status.id)) return;
    io.emit('autoscan-status', { ...status, nextRunTime: autoSession.nextRunTime || null });
    saveAutoScanState();
    // Chạm giới hạn ngày / ngày nghỉ / hết khung giờ học → tự hẹn giờ chạy lại (giống Queue thủ công)
    if (status.status === 'date-limit' || status.status === 'daily-limit' || status.status === 'time-window') {
      scheduleAutoScanResume(autoSession);
    }
  });
  autoSession.on('progress-saved', (data) => {
    const fbConfig = fbService.loadFirebaseConfig();
    if (fbConfig && fbConfig.projectId) {
      fbService.syncToFirebaseREST('system_course_progress', `${account.name}_${Date.now()}`, data, fbConfig);
    }
  });

  autoScanSessions.set(sessionId, autoSession);
  return autoSession;
}

// Hẹn giờ chạy lại phiên Auto-Scan vào giờ ngày học hợp lệ tiếp theo
// (hoặc đầu khung giờ học tiếp theo nếu đang ngoài khung giờ)
function scheduleAutoScanResume(autoSession) {
  let resumeAt;
  if (autoSession.status === 'time-window' && (autoSession.options.timeWindows || []).length > 0) {
    resumeAt = new Date(Date.now() + calcNextWindowMs(autoSession.options.timeWindows));
  } else {
    resumeAt = getNextAllowedStudyDate(
      new Date(),
      autoSession.options.allowedDateRanges || [],
      autoSession.options.newDayStartTime || '06:00'
    );
  }
  autoSession.nextRunTime = resumeAt.toISOString();
  addLog({
    timestamp: formatVN(new Date()),
    account: autoSession.account.name,
    msg: `⏰ Auto-Scan hẹn tự chạy lại lúc ${formatVN(resumeAt)}`,
    level: 'info',
  });
  io.emit('autoscan-status', { ...autoSession.getStatus(), nextRunTime: autoSession.nextRunTime });
  saveAutoScanState();
  scheduleAutoScanTimer(autoSession.id, resumeAt, () => restartAutoScanSession(autoSession.id));
}

// Đến giờ hẹn → tạo lại phiên mới cùng ID và khởi động (phiên cũ đã đóng browser)
function restartAutoScanSession(sessionId) {
  const old = autoScanSessions.get(sessionId);
  if (!old) return;
  if (old.status !== 'date-limit' && old.status !== 'daily-limit' && old.status !== 'time-window') return;

  const fresh = createAutoScanSession(sessionId, old.account, old.coursesConfig, {
    headless: true,
    dailyMaxMinutes: old.options.dailyMaxMinutes,
    allowedDateRanges: old.options.allowedDateRanges,
    newDayStartTime: old.options.newDayStartTime || '06:00',
    refreshInterval: old.options.refreshInterval || 15,
    stealth: old.options.stealth === true,
    stealthInterval: old.options.stealthInterval || 30,
    timeWindows: old.options.timeWindows || [],
  }, {
    createdAt: old.createdAt,
    dailyStudiedMinutes: old.dailyStudiedMinutes,
    dailyDate: old.dailyDate, // engine tự reset bộ đếm khi thấy sang ngày mới
    courseProgress: old.courseProgress,
  });

  addLog({
    timestamp: formatVN(new Date()),
    account: old.account.name,
    msg: `▶️ Đến giờ hẹn — khởi động lại Auto-Scan cho ${old.account.name}`,
    level: 'info',
  });
  startAutoScanWhenFree(fresh);
  saveAutoScanState();
}

// Khôi phục các phiên Auto-Scan từ lần chạy trước (nếu server bị restart hoặc từ Firebase)
async function loadAndRestoreAutoScans() {
  let state = null;
  if (fs.existsSync(AUTOSCAN_STATE_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(AUTOSCAN_STATE_FILE, 'utf8'));
    } catch (e) {
      console.error('[STATE] Không thể đọc auto-scan state local:', e.message);
    }
  }

  // Nếu file local rỗng/không có, thử đọc từ Firebase REST
  if (!state || !Array.isArray(state) || state.length === 0) {
    const fbConfig = fbService.loadFirebaseConfig();
    if (fbConfig && fbConfig.projectId) {
      try {
        const fbData = await fbService.fetchFromFirebaseREST('system_autoscan', fbConfig);
        if (fbData && fbData[0] && Array.isArray(fbData[0].autoScans)) {
          state = fbData[0].autoScans;
          console.log(`[FIREBASE] Đã lấy ${state.length} phiên Auto-Scan từ Firebase REST.`);
        }
      } catch (e) {
        console.error('[FIREBASE] Không thể đọc Auto-Scan từ Firebase:', e.message);
      }
    }
  }

  if (!state || !Array.isArray(state)) return;

  let active = 0;
  for (const saved of state) {
    if (!saved || !saved.id || !saved.account) continue;
    const options = {
      headless: true,
      dailyMaxMinutes: (saved.options && saved.options.dailyMaxMinutes) || 480,
      allowedDateRanges: (saved.options && saved.options.allowedDateRanges) || [],
      newDayStartTime: (saved.options && saved.options.newDayStartTime) || '06:00',
      refreshInterval: (saved.options && saved.options.refreshInterval) || 15,
      stealth: !!(saved.options && saved.options.stealth),
      stealthInterval: (saved.options && saved.options.stealthInterval) || 30,
      timeWindows: (saved.options && saved.options.timeWindows) || [],
    };
    const s = createAutoScanSession(saved.id, saved.account, saved.coursesConfig || [], options, {
      createdAt: saved.createdAt,
      dailyStudiedMinutes: saved.dailyStudiedMinutes || 0,
      dailyDate: saved.dailyDate,
      courseProgress: saved.courseProgress || {},
    });
    s.status = saved.status;
    s.pausedFromStatus = saved.pausedFromStatus || null;
    s.currentCourseIndex = saved.currentCourseIndex || 0;
    s.nextRunTime = saved.nextRunTime || null;

    if (saved.status === 'paused') {
      logHistory.push({
        timestamp: formatVN(new Date()),
        account: saved.account.name,
        msg: `⏸ Server restart — Khôi phục trạng thái Tạm dừng cho Auto-Scan ${saved.account.name}`,
        level: 'info',
      });
      active++;
    } else if (saved.status === 'idle' || saved.status === 'logging-in' || saved.status === 'scanning' || saved.status === 'studying') {
      logHistory.push({
        timestamp: formatVN(new Date()),
        account: saved.account.name,
        msg: `🔄 Server restart — chạy lại Auto-Scan (đang dở khóa ${(saved.currentCourseIndex || 0) + 1})`,
        level: 'warn',
      });
      s.status = 'idle';
      setTimeout(() => startAutoScanWhenFree(s), 5000);
      active++;
    } else if (saved.status === 'date-limit' && isAllowedStudyDate(new Date(), options.allowedDateRanges)) {
      // Hôm nay (giờ VN) đã là ngày học hợp lệ — bỏ qua lịch hẹn cũ (có thể sai do lệch múi giờ) → chạy lại ngay
      logHistory.push({
        timestamp: formatVN(new Date()),
        account: saved.account.name,
        msg: `▶️ Hôm nay là ngày học hợp lệ — khởi động lại Auto-Scan ngay (bỏ lịch hẹn cũ)`,
        level: 'info',
      });
      s.status = 'idle';
      s.nextRunTime = null;
      setTimeout(() => startAutoScanWhenFree(s), 5000);
      active++;
    } else if (saved.status === 'date-limit' || saved.status === 'daily-limit' || saved.status === 'time-window') {
      const fireAt = saved.nextRunTime
        ? new Date(saved.nextRunTime)
        : (saved.status === 'time-window' && options.timeWindows.length > 0)
          ? new Date(Date.now() + calcNextWindowMs(options.timeWindows))
          : getNextAllowedStudyDate(new Date(), options.allowedDateRanges, options.newDayStartTime);
      logHistory.push({
        timestamp: formatVN(new Date()),
        account: saved.account.name,
        msg: `⏰ Khôi phục lịch hẹn Auto-Scan → chạy lại lúc ${formatVN(fireAt)}`,
        level: 'info',
      });
      s.nextRunTime = fireAt.toISOString();
      scheduleAutoScanTimer(saved.id, fireAt, () => restartAutoScanSession(saved.id));
      active++;
    }
  }

  if (state.length > 0) {
    console.log(`[STATE] Khôi phục ${state.length} phiên Auto-Scan (${active} hoạt động/đang hẹn giờ).`);
  }
}

// Tài khoản đang có phiên browser khác chạy (Queue thủ công hoặc Auto-Scan khác)?
function findAccountConflict(email, excludeSessionId) {
  const activeManual = [...sessions.values()].find(
    s => s.account.email === email && (s.status === 'running' || s.status === 'logging-in')
  );
  if (activeManual) return `phiên thủ công ${activeManual.id}`;
  const activeAuto = [...autoScanSessions.values()].find(
    s => s.id !== excludeSessionId && s.account.email === email
      && (s.status === 'idle' || s.status === 'scanning' || s.status === 'studying' || s.status === 'logging-in')
  );
  if (activeAuto) return `phiên Auto-Scan ${activeAuto.id}`;
  return null;
}

// Khởi động phiên Auto-Scan khi tài khoản rảnh — nếu đang bận thì chờ 5 phút thử lại (giống Queue thủ công)
function startAutoScanWhenFree(autoSession) {
  if (!autoScanSessions.has(autoSession.id)) return; // đã bị xóa
  if (autoSession.status === 'stopped' || autoSession._stopped) return;

  const conflict = findAccountConflict(autoSession.account.email, autoSession.id);
  if (conflict) {
    const retryAt = new Date(Date.now() + 5 * 60 * 1000);
    autoSession.nextRunTime = retryAt.toISOString();
    addLog({
      timestamp: formatVN(new Date()),
      account: autoSession.account.name,
      msg: `⏳ Tài khoản đang chạy ${conflict} — chờ 5 phút rồi thử khởi động Auto-Scan lại...`,
      level: 'warn',
    });
    io.emit('autoscan-status', { ...autoSession.getStatus(), nextRunTime: autoSession.nextRunTime });
    saveAutoScanState();
    scheduleAutoScanTimer(autoSession.id, retryAt, () => startAutoScanWhenFree(autoSession));
    return;
  }

  autoSession.nextRunTime = null;
  autoSession.start().catch(err => {
    addLog({ timestamp: formatVN(new Date()), account: autoSession.account.name, msg: `❌ Lỗi Auto-Scan: ${err.message}`, level: 'error' });
  });
}

app.post('/lythuyet/api/auto-scan/start', async (req, res) => {
  const { courses, allowedDateRanges, dailyMaxMinutes, newDayStartTime, refreshInterval, stealth, stealthInterval, timeWindows, accountIndices } = req.body;
  if (!courses || !Array.isArray(courses) || courses.length === 0) {
    return res.status(400).json({ error: 'Cần nhập ít nhất 1 khóa học' });
  }

  const allAccounts = loadAccounts();
  const targetAccounts = accountIndices.map(idx => allAccounts[idx - 1]).filter(Boolean);
  if (targetAccounts.length === 0) {
    return res.status(400).json({ error: 'Không tìm thấy tài khoản hợp lệ' });
  }

  const validTimeWindows = Array.isArray(timeWindows)
    ? timeWindows.filter(w => w && /^\d{1,2}:\d{2}$/.test(w.start || '') && /^\d{1,2}:\d{2}$/.test(w.end || ''))
    : [];

  const started = [];
  for (const acc of targetAccounts) {
    const sessionId = `autoscan_${acc.name}_${Date.now()}`;
    const autoSession = createAutoScanSession(sessionId, acc, courses, {
      headless: true,
      dailyMaxMinutes: dailyMaxMinutes || 480,
      allowedDateRanges: allowedDateRanges || [],
      newDayStartTime: newDayStartTime || '06:00',
      refreshInterval: parseInt(refreshInterval, 10) || 15,
      stealth: stealth === true,
      stealthInterval: parseInt(stealthInterval, 10) || 30,
      timeWindows: validTimeWindows,
    });

    startAutoScanWhenFree(autoSession);
    started.push({ sessionId, account: acc.name });
  }

  saveAutoScanState();
  res.json({ ok: true, started });
});

// Tạm dừng 1 phiên Auto-Scan
app.post('/lythuyet/api/auto-scan/pause/:id', async (req, res) => {
  const autoSession = autoScanSessions.get(req.params.id);
  if (!autoSession) return res.status(404).json({ error: 'Không tìm thấy phiên Auto-Scan' });

  const paused = autoSession.pause();
  if (!paused) return res.status(400).json({ error: 'Không thể tạm dừng (phiên không đang hoạt động)' });

  io.emit('autoscan-status', autoSession.getStatus());
  saveAutoScanState();
  res.json({ ok: true });
});

// Tiếp tục 1 phiên Auto-Scan
app.post('/lythuyet/api/auto-scan/resume/:id', async (req, res) => {
  const autoSession = autoScanSessions.get(req.params.id);
  if (!autoSession) return res.status(404).json({ error: 'Không tìm thấy phiên Auto-Scan' });
  if (autoSession.status !== 'paused') {
    return res.status(400).json({ error: 'Không thể tiếp tục (phiên không đang tạm dừng)' });
  }

  if (autoSession.browser) {
    // Phiên còn browser đang mở → tiếp tục ngay tại chỗ
    autoSession.resume();
    io.emit('autoscan-status', autoSession.getStatus());
  } else {
    // Phiên tạm dừng được khôi phục sau server restart (không còn browser)
    // → tạo lại phiên mới cùng ID từ tiến độ đã lưu (giống Queue thủ công resume sau restart)
    const fresh = createAutoScanSession(autoSession.id, autoSession.account, autoSession.coursesConfig, {
      headless: true,
      dailyMaxMinutes: autoSession.options.dailyMaxMinutes,
      allowedDateRanges: autoSession.options.allowedDateRanges,
      newDayStartTime: autoSession.options.newDayStartTime || '06:00',
      refreshInterval: autoSession.options.refreshInterval || 15,
      stealth: autoSession.options.stealth === true,
      stealthInterval: autoSession.options.stealthInterval || 30,
      timeWindows: autoSession.options.timeWindows || [],
    }, {
      createdAt: autoSession.createdAt,
      dailyStudiedMinutes: autoSession.dailyStudiedMinutes,
      dailyDate: autoSession.dailyDate,
      courseProgress: autoSession.courseProgress,
    });
    addLog({
      timestamp: formatVN(new Date()),
      account: autoSession.account.name,
      msg: '▶️ Tiếp tục Auto-Scan sau khi server khởi động lại — chạy lại từ tiến độ đã lưu',
      level: 'info',
    });
    startAutoScanWhenFree(fresh);
  }

  saveAutoScanState();
  res.json({ ok: true });
});

// Dừng 1 phiên Auto-Scan theo yêu cầu từ Dashboard (hủy cả lịch hẹn nếu có)
app.post('/lythuyet/api/auto-scan/stop/:id', async (req, res) => {
  const autoSession = autoScanSessions.get(req.params.id);
  if (!autoSession) return res.status(404).json({ error: 'Không tìm thấy phiên Auto-Scan' });

  clearAutoScanTimer(req.params.id);
  await autoSession.stop();
  autoSession.status = 'stopped';
  autoSession.nextRunTime = null;
  io.emit('autoscan-status', autoSession.getStatus());
  addLog({
    timestamp: formatVN(new Date()),
    account: autoSession.account.name,
    msg: '⏹ Đã dừng phiên Auto-Scan theo yêu cầu',
    level: 'warn',
  });
  saveAutoScanState();
  res.json({ ok: true });
});

// Xóa thẻ phiên Auto-Scan khỏi Dashboard (hủy cả lịch hẹn nếu có)
app.delete('/lythuyet/api/auto-scan/sessions/:id', async (req, res) => {
  const autoSession = autoScanSessions.get(req.params.id);
  if (!autoSession) return res.status(404).json({ error: 'Không tìm thấy phiên Auto-Scan' });

  clearAutoScanTimer(req.params.id);
  await autoSession.stop();
  autoSession.removeAllListeners('status');
  autoScanSessions.delete(req.params.id);
  io.emit('autoscan-removed', req.params.id);
  saveAutoScanState();
  res.json({ ok: true });
});

// Tạm dừng hàng chờ
app.post('/lythuyet/api/pause-queue/:id', async (req, res) => {
  const queue = queues.get(req.params.id);
  if (!queue) return res.status(404).json({ error: 'Queue không tìm thấy' });
  if (queue.status !== 'running' && queue.status !== 'waiting') {
    return res.status(400).json({ error: 'Queue không đang hoạt động' });
  }

  queue.pausedFromStatus = queue.status; // Remember original state

  if (queue.status === 'running' && queue.currentSessionId) {
    const session = sessions.get(queue.currentSessionId);
    if (session && session.status === 'running') {
      session.pause();
    }
  }

  if (queue.status === 'waiting') {
    if (queue.timer) { clearTimeout(queue.timer); queue.timer = null; }
    // Keep nextRunTime so we can recalculate on resume
  }

  queue.status = 'paused';
  addLog({
    timestamp: formatVN(new Date()),
    account: queue.account.name,
    msg: `⏸ Tạm dừng hàng chờ (box ${queue.currentPairIndex + 1}/${queue.pairs.length})`,
    level: 'info',
  });
  updateQueue(queue);
  res.json({ ok: true });
});

// Tiếp tục hàng chờ
app.post('/treohoc/api/resume-queue/:id', (req, res) => {
  const queue = queues.get(req.params.id);
  if (!queue) return res.status(404).json({ error: 'Queue không tìm thấy' });
  if (queue.status !== 'paused') {
    return res.status(400).json({ error: 'Queue không đang tạm dừng' });
  }

  const prevStatus = queue.pausedFromStatus || 'running';
  queue.pausedFromStatus = null;

  if (prevStatus === 'running' && queue.currentSessionId) {
    const session = sessions.get(queue.currentSessionId);
    if (session && session.status === 'paused') {
      session.resume();
    }
    queue.status = 'running';
  } else if (prevStatus === 'waiting') {
    // Recalculate delay from saved nextRunTime
    const now = new Date();
    if (queue.nextRunTime && queue.nextRunTime.getTime() > now.getTime()) {
      const delay = queue.nextRunTime.getTime() - now.getTime();
      queue.status = 'waiting';
      queue.timer = setTimeout(() => {
        if (queue.status === 'waiting') startPairForQueue(queue);
      }, delay);
    } else {
      // nextRunTime already passed → start immediately
      queue.status = 'waiting';
      queue.nextRunTime = new Date();
      setTimeout(() => {
        if (queue.status === 'waiting') startPairForQueue(queue);
      }, 1000);
    }
  } else {
    // Fallback: start the current pair
    queue.status = 'waiting';
    setTimeout(() => {
      if (queue.status === 'waiting') startPairForQueue(queue);
    }, 1000);
  }

  addLog({
    timestamp: formatVN(new Date()),
    account: queue.account.name,
    msg: `▶️ Tiếp tục hàng chờ (box ${queue.currentPairIndex + 1}/${queue.pairs.length})`,
    level: 'info',
  });
  updateQueue(queue);
  res.json({ ok: true });
});

// Đôn hàng chờ - chạy ngay box đang đợi
app.post('/lythuyet/api/rush-queue/:id', (req, res) => {
  const queue = queues.get(req.params.id);
  if (!queue) return res.status(404).json({ error: 'Queue kh\u00F4ng t\u00ECm th\u1EA5y' });
  if (queue.status !== 'waiting' && queue.status !== 'time-limit') return res.status(400).json({ error: 'Queue kh\u00F4ng \u0111ang ch\u1EDD' });
  if (queue.timer) { clearTimeout(queue.timer); queue.timer = null; }
  queue.nextRunTime = null;
  addLog({
    timestamp: formatVN(new Date()),
    account: queue.account.name,
    msg: `\u26A1 \u0110\u00F4n h\u00E0ng ch\u1EDD - ch\u1EA1y ngay box ${queue.currentPairIndex + 1}!`,
    level: 'info',
  });
  if (queue.status === 'time-limit') {
    // Bỏ qua kiểm tra khung giờ — chạy ngay theo dữ liệu tiếp tục
    queue.resumeFromTimeLimit = queue.timeLimitData;
    delete queue.timeLimitData;
  }
  startPairForQueue(queue);
  res.json({ ok: true });
});

// Thêm box vào hàng chờ đang tồn tại
app.post('/lythuyet/api/add-pairs/:id', (req, res) => {
  const queue = queues.get(req.params.id);
  if (!queue) return res.status(404).json({ error: 'Queue không tìm thấy' });
  if (queue.status === 'cancelled' || queue.status === 'completed') {
    return res.status(400).json({ error: 'Queue đã kết thúc, không thể thêm' });
  }
  const { pairs, options, scheduledDateTime } = req.body;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return res.status(400).json({ error: 'Cần ít nhất 1 box bài' });
  }
  for (const p of pairs) {
    if (!p.urls || !Array.isArray(p.urls) || !p.urls.some(u => u.url)) {
      return res.status(400).json({ error: 'Mỗi box cần ít nhất 1 URL' });
    }
  }

  // Pairs đã có pairOptions và scheduledDateTime nhúng sẵn (từ client mới)
  // Nếu client cũ gửi options/scheduledDateTime riêng → gắn vào
  const pairsWithOpts = pairs.map(p => {
    const result = { ...p };
    if (!result.pairOptions && options) {
      result.pairOptions = {
        time: options.time || queue.options.time,
        startHour: options.startHour != null ? options.startHour : queue.startHour,
        refreshInterval: options.refreshInterval || queue.options.refreshInterval,
        stealthInterval: options.stealthInterval || queue.options.stealthInterval,
      };
    }
    if (!result.scheduledDateTime && scheduledDateTime) {
      result.scheduledDateTime = scheduledDateTime;
    }
    return result;
  });

  queue.pairs.push(...pairsWithOpts);

  const pOpts = pairsWithOpts[0]?.pairOptions;
  const optNote = pOpts ? ` (${Math.floor(pOpts.time / 60)}h${pOpts.time % 60 ? pOpts.time % 60 + 'm' : ''}, F5 ${pOpts.refreshInterval}ph)` : '';
  const firstSched = pairsWithOpts[0]?.scheduledDateTime;
  const schedNote = firstSched ? ` 📅 hẹn ${formatVN(new Date(firstSched))}` : '';
  addLog({
    timestamp: formatVN(new Date()),
    account: queue.account.name,
    msg: `➕ Thêm ${pairs.length} box mới (tổng: ${queue.pairs.length} box)${optNote}${schedNote}`,
    level: 'success',
  });
  updateQueue(queue);
  res.json({ ok: true, totalPairs: queue.pairs.length });
});

// Chạy lại queue (completed/error/cancelled)
app.post('/lythuyet/api/retry-queue/:id', (req, res) => {
  const oldQueue = queues.get(req.params.id);
  if (!oldQueue) return res.status(404).json({ error: 'Queue không tìm thấy' });
  if (oldQueue.status === 'running' || oldQueue.status === 'waiting') {
    return res.status(400).json({ error: 'Queue đang hoạt động, không cần chạy lại' });
  }

  // Tạo queue mới từ data cũ, reset về đầu
  const queueId = `queue_${oldQueue.account.name}_${Date.now()}`;
  const queue = {
    id: queueId,
    account: oldQueue.account,
    accountIndex: oldQueue.accountIndex,
    pairs: oldQueue.pairs,
    currentPairIndex: 0,
    startHour: oldQueue.startHour,
    options: { ...oldQueue.options },
    status: 'running',
    nextRunTime: null,
    currentSessionId: null,
    timer: null,
    createdAt: new Date(),
  };

  queues.set(queueId, queue);
  addLog({
    timestamp: formatVN(new Date()),
    account: queue.account.name,
    msg: `🔄 Chạy lại queue (${oldQueue.pairs.length} box) từ đầu`,
    level: 'info',
  });
  startPairForQueue(queue);
  res.json({ ok: true, queueId });
});

// Sửa pairs trong queue (chỉ sửa được box chưa chạy)
app.put('/lythuyet/api/edit-queue/:id', (req, res) => {
  const queue = queues.get(req.params.id);
  if (!queue) return res.status(404).json({ error: 'Queue không tìm thấy' });

  const { pairs } = req.body;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return res.status(400).json({ error: 'Cần ít nhất 1 box' });
  }
  for (const p of pairs) {
    if (!p.urls || !Array.isArray(p.urls) || !p.urls.some(u => u.url)) {
      return res.status(400).json({ error: 'Mỗi box cần ít nhất 1 URL' });
    }
  }

  const isActive = queue.status === 'running' || queue.status === 'waiting';
  if (isActive) {
    // Chỉ sửa các box chưa chạy (từ currentPairIndex + 1 trở đi)
    const kept = queue.pairs.slice(0, queue.currentPairIndex + 1);
    queue.pairs = [...kept, ...pairs];
    addLog({
      timestamp: formatVN(new Date()),
      account: queue.account.name,
      msg: `✏️ Sửa hàng chờ: giữ ${kept.length} box đã/đang chạy + ${pairs.length} box mới (tổng: ${queue.pairs.length})`,
      level: 'info',
    });
  } else if (queue.status === 'paused') {
    // Queue đang tạm dừng → thay toàn bộ pairs
    queue.pairs = pairs;
    // Nếu đang chờ lịch (pausedFromStatus === 'waiting'), đồng bộ nextRunTime
    // theo scheduledDateTime mới của box hiện tại
    if (queue.pausedFromStatus === 'waiting') {
      const currentPair = queue.pairs[queue.currentPairIndex];
      if (currentPair?.scheduledDateTime) {
        queue.nextRunTime = new Date(
          typeof currentPair.scheduledDateTime === 'number'
            ? currentPair.scheduledDateTime
            : new Date(currentPair.scheduledDateTime).getTime()
        );
        addLog({
          timestamp: formatVN(new Date()),
          account: queue.account.name,
          msg: `✏️ Sửa queue (tạm dừng): ${pairs.length} box — cập nhật giờ chạy → ${formatVN(queue.nextRunTime)}`,
          level: 'info',
        });
      } else {
        addLog({
          timestamp: formatVN(new Date()),
          account: queue.account.name,
          msg: `✏️ Sửa queue (tạm dừng): ${pairs.length} box`,
          level: 'info',
        });
      }
    } else {
      addLog({
        timestamp: formatVN(new Date()),
        account: queue.account.name,
        msg: `✏️ Sửa queue (tạm dừng): ${pairs.length} box`,
        level: 'info',
      });
    }
  } else {
    // Queue đã kết thúc → thay toàn bộ pairs
    queue.pairs = pairs;
    addLog({
      timestamp: formatVN(new Date()),
      account: queue.account.name,
      msg: `✏️ Sửa queue: ${pairs.length} box`,
      level: 'info',
    });
  }

  updateQueue(queue);
  res.json({ ok: true, totalPairs: queue.pairs.length });
});

// Lấy log
app.get('/lythuyet/api/logs', (req, res) => {
  res.json(logHistory);
});

// =================== SOCKET.IO =============================

io.on('connection', (socket) => {
  console.log(`[WEB] Client connected: ${socket.id}`);

  const sessionList = [];
  for (const [id, session] of sessions) {
    sessionList.push(session.getStatus());
  }
  const queueList = [];
  for (const [id, queue] of queues) {
    queueList.push(getQueueStatus(queue));
  }
  const autoScanList = [];
  for (const [id, autoSession] of autoScanSessions) {
    autoScanList.push({ ...autoSession.getStatus(), nextRunTime: autoSession.nextRunTime || null });
  }
  socket.emit('init', { sessions: sessionList, queues: queueList, autoScans: autoScanList, logs: logHistory.slice(-100) });

  socket.on('disconnect', () => {
    console.log(`[WEB] Client disconnected: ${socket.id}`);
  });
});

// ======================== START ============================

// Khôi phục queue state từ lần chạy trước (nếu server bị restart)
loadAndRestoreQueues();

// Khôi phục các phiên Auto-Scan từ lần chạy trước
loadAndRestoreAutoScans();

// SPA fallback
app.get('/treohoc/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/treohoc', (req, res) => {
  res.redirect('/treohoc/');
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   TREO HỌC LÝ THUYẾT - Web Dashboard       ║
║   http://localhost:${PORT}                       ║
╚══════════════════════════════════════════════╝
  `);
});
