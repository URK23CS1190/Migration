function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
const express = require('express');
const session = require('express-session');
const path = require('path');
const os = require('os');
require('dotenv').config();
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://localhost:9090';

const app = express();
const PORT = process.env.PORT || 3000;
const REGION = process.env.REGION || 'us-east-1';
const fetch = require('node-fetch');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'aegis-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 }
}));

// ── Metrics ──
const metrics = {
  loginCount: 0,
  activeUsers: 0,
  requestCount: 0,
  failoverCount: 0,
  startTime: Date.now(),
  primaryStatus: 'healthy',
  secondaryStatus: 'standby',
  trafficHistory: [],
  cpuHistory: [],
  activityLog: [],
};

// ── LOGGING ──
function addLog(level, message) {
  metrics.activityLog.unshift({
    time: new Date().toISOString(),
    level,
    message
  });
  if (metrics.activityLog.length > 50) metrics.activityLog.pop();
}

addLog('INFO', 'AEGIS system started');

// ── Middleware counter ──
app.use((req, res, next) => {
  metrics.requestCount++;
  next();
});

// ── LOGIN ──
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (username === 'admin' && password === 'cloud123') {
    metrics.loginCount++;
    metrics.activeUsers++;

    req.session.user = { username };

    addLog('INFO', 'Admin logged in');
    return res.json({ success: true });
  }

  addLog('WARN', 'Failed login attempt');
  return res.status(401).json({ success: false });
});

// ── LOGOUT ──
app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// ── HOME ROUTE (IMPORTANT FIX) ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── DASHBOARD ──
app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── API STATS ──
app.get('/api/stats', (req, res) => {
  const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
  const mem = process.memoryUsage();

  res.json({
    uptime,
    activeUsers: metrics.activeUsers,
    requestCount: metrics.requestCount,
    loginCount: metrics.loginCount,
    failoverCount: metrics.failoverCount,
    primaryStatus: metrics.primaryStatus,
    secondaryStatus: metrics.secondaryStatus,
    cpu: os.loadavg()[0],
    memory: {
      used: Math.round(mem.heapUsed / 1024 / 1024)
    },
    trafficHistory: metrics.trafficHistory,
    cpuHistory: metrics.cpuHistory
  });
});

// ── ACTIVITY LOG ──
app.get('/api/activity', (req, res) => {
  res.json({ logs: metrics.activityLog });
});

// ── FAILOVER ──
app.post('/api/failover', (req, res) => {
  const { action } = req.body;

  if (action === 'trigger') {
    metrics.primaryStatus = 'down';
    metrics.secondaryStatus = 'active';
    metrics.failoverCount++;

    addLog('CRITICAL', 'Failover triggered');
  }

  if (action === 'recover') {
    metrics.primaryStatus = 'healthy';
    metrics.secondaryStatus = 'standby';

    addLog('SUCCESS', 'System recovered');
  }

  res.json({ success: true });
});

// ── HEALTH ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', region: REGION });
});
// ── Grafana Loki Logs Proxy ───────────────────────────────────────────────────
app.get('/api/grafana/logs', requireAuth, async (req, res) => {
  const LOKI_URL = process.env.LOKI_URL || 'http://localhost:3100';
  const limit    = req.query.limit || 50;
  const start    = req.query.start || (Date.now() - 3600000) * 1e6; // last 1hr in nanoseconds

  try {
    const fetch = (await import('node-fetch')).default;
    const url   = `${LOKI_URL}/loki/api/v1/query_range?query={job="node"}&limit=${limit}&start=${start}&end=${Date.now() * 1e6}&direction=backward`;
    const r     = await fetch(url, { timeout: 4000 });
    const data  = await r.json();

    // Normalize Loki log format → your dashboard log format
    const logs = [];
    if (data.data?.result) {
      for (const stream of data.data.result) {
        for (const [ts, line] of stream.values) {
          logs.push({
            timestamp: new Date(parseInt(ts) / 1e6).toISOString(),
            level: line.includes('ERROR') || line.includes('CRIT') ? 'CRITICAL'
                 : line.includes('WARN')  ? 'WARN'
                 : line.includes('OK')    ? 'SUCCESS'
                 : 'INFO',
            message: line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '') // strip duplicate timestamp
          });
        }
      }
    }
    res.json({ logs });
  } catch (e) {
    res.status(500).json({ error: 'Loki unreachable', detail: e.message });
  }
});
// ── START ──
app.listen(PORT, () => {
  console.log(`AEGIS running on http://localhost:${PORT}`);
});

// ── PROMETHEUS QUERY ──
app.get('/api/prometheus', async (req, res) => {
  try {
    const query = req.query.query;
    const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;

    const response = await fetch(url);
    const data = await response.json();

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Prometheus not reachable' });
  }
});

app.get('/api/prometheus/range', async (req, res) => {
  try {
    const { query, start, end, step } = req.query;

    const url = `${PROMETHEUS_URL}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${end}&step=${step}`;

    const response = await fetch(url);
    const data = await response.json();

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Prometheus range query failed' });
  }
});

// Add LOKI_URL to your .env:
// LOKI_URL=http://localhost:3100

app.get('/api/grafana/logs', requireAuth, async (req, res) => {
  const LOKI_URL = process.env.LOKI_URL || 'http://localhost:3100';
  try {
    const fetch = (await import('node-fetch')).default;
    const start = (Date.now() - 3600000) * 1e6;
    const url = `${LOKI_URL}/loki/api/v1/query_range?query={job="node"}&limit=50&start=${start}&end=${Date.now() * 1e6}&direction=backward`;
    const r = await fetch(url, { timeout: 4000 });
    const data = await r.json();
    const logs = [];
    for (const stream of data.data?.result || []) {
      for (const [ts, line] of stream.values) {
        logs.push({
          timestamp: new Date(parseInt(ts) / 1e6).toISOString(),
          level: line.includes('ERROR') || line.includes('CRIT') ? 'CRITICAL'
               : line.includes('WARN') ? 'WARN'
               : line.includes('OK')   ? 'SUCCESS' : 'INFO',
          message: line
        });
      }
    }
    res.json({ logs });
  } catch (e) {
    res.status(500).json({ error: 'Loki unreachable', detail: e.message });
  }
});