// ╔══════════════════════════════════════════════════════════════╗
// ║         AEGIS — Autonomous Cloud Control System v2.0         ║
// ║         AWS Multi-Region Failover Infrastructure             ║
// ╚══════════════════════════════════════════════════════════════╝

const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const os       = require('os');

const app    = express();
const PORT   = process.env.PORT   || 3000;
const REGION = process.env.REGION || 'us-east-1';

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'aegis-ultra-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 }
}));

// ── Metrics State ──────────────────────────────────────────────────────────────
const metrics = {
  loginCount:       0,
  activeUsers:      0,
  requestCount:     0,
  failoverCount:    0,
  startTime:        Date.now(),
  primaryStatus:    'healthy',
  secondaryStatus:  'standby',
  primaryRegion:    'us-east-1',
  secondaryRegion:  'ap-south-1',
  activityLog:      [],
  trafficHistory:   [],
  cpuHistory:       [],
  dockerContainers: [
    { id: 'a1b2c3d4', name: 'aegis-app',        status: 'running', region: 'us-east-1', port: '3000' },
    { id: 'e5f6g7h8', name: 'aegis-app-replica', status: 'running', region: 'ap-south-1', port: '3000' },
    { id: 'i9j0k1l2', name: 'prometheus',         status: 'running', region: 'us-east-1', port: '9090' },
    { id: 'm3n4o5p6', name: 'grafana',            status: 'running', region: 'us-east-1', port: '3001' },
  ],
  k8sPods: [
    { name: 'aegis-app-7d8b9c-xk2pq', status: 'Running', node: 'node-primary-1',   restarts: 0, age: '2d' },
    { name: 'aegis-app-7d8b9c-mn9rt', status: 'Running', node: 'node-primary-2',   restarts: 0, age: '2d' },
    { name: 'aegis-app-7d8b9c-pq7ws', status: 'Running', node: 'node-secondary-1', restarts: 1, age: '1d' },
  ]
};

function addLog(level, message) {
  metrics.activityLog.unshift({ time: new Date().toISOString(), level, message });
  if (metrics.activityLog.length > 80) metrics.activityLog.pop();
}

// Boot logs
addLog('INFO',    `AEGIS Control System v2.0 initialized — Region: ${REGION}`);
addLog('INFO',    'Docker containers: 4 running across 2 regions');
addLog('INFO',    'Kubernetes cluster: 3 pods healthy');
addLog('INFO',    'Prometheus metrics exporter active on /metrics');
addLog('INFO',    'Route 53 health check polling every 30s');
addLog('SUCCESS', 'Primary region us-east-1 is HEALTHY');
addLog('INFO',    'Secondary region ap-south-1 on STANDBY');
addLog('INFO',    'Terraform state: Infrastructure provisioned successfully');

// ── Background Simulation ─────────────────────────────────────────────────────
setInterval(() => {
  const req = Math.floor(Math.random() * 12) + 1;
  metrics.requestCount += req;
  metrics.trafficHistory.push({ t: Date.now(), v: req });
  if (metrics.trafficHistory.length > 60) metrics.trafficHistory.shift();

  const cpu = parseFloat((os.loadavg()[0] + Math.random() * 0.3).toFixed(2));
  metrics.cpuHistory.push({ t: Date.now(), v: cpu });
  if (metrics.cpuHistory.length > 60) metrics.cpuHistory.shift();

  const r = Math.random();
  if (r < 0.05)       addLog('WARN',    'Elevated latency on us-east-1 — P99 > 300ms');
  else if (r < 0.03)  addLog('INFO',    'K8s auto-scaling: +1 pod in us-east-1');
  else if (r < 0.02)  addLog('INFO',    'Docker image pull: aegis-app:latest synced to ap-south-1');
}, 4000);

// ── Request Counter ───────────────────────────────────────────────────────────
app.use((req, res, next) => { metrics.requestCount++; next(); });

// ── Auth ──────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'cloud123') {
    metrics.loginCount++;
    metrics.activeUsers++;
    req.session.user = { username, region: REGION, loginTime: new Date() };
    addLog('INFO', `Operator "${username}" authenticated — session started`);
    return res.json({ success: true });
  }
  addLog('WARN', `Failed login attempt — username: "${username}"`);
  return res.status(401).json({ success: false, message: 'Invalid credentials' });
});

app.post('/logout', (req, res) => {
  if (req.session.user) {
    addLog('INFO', `Operator "${req.session.user.username}" logged out`);
    metrics.activeUsers = Math.max(0, metrics.activeUsers - 1);
  }
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── Health Check (Route 53 pings this) ───────────────────────────────────────
app.get('/health', (req, res) => {
  const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
  const mem    = process.memoryUsage();
  res.status(200).json({
    status: 'healthy', region: REGION, uptime: `${uptime}s`,
    timestamp: new Date().toISOString(),
    primaryStatus: metrics.primaryStatus,
    secondaryStatus: metrics.secondaryStatus,
    failoverCount: metrics.failoverCount,
    activeUsers: metrics.activeUsers,
    memory: {
      used:  Math.round(mem.heapUsed  / 1024 / 1024),
      total: Math.round(mem.heapTotal / 1024 / 1024), unit: 'MB'
    },
    cpu: parseFloat(os.loadavg()[0].toFixed(2))
  });
});

// ── Prometheus Metrics ────────────────────────────────────────────────────────
app.get('/metrics', (req, res) => {
  const uptime  = Math.floor((Date.now() - metrics.startTime) / 1000);
  const mem     = process.memoryUsage();
  const memUsed = Math.round(mem.heapUsed / 1024 / 1024);
  const cpuLoad = os.loadavg()[0];
  const body = `
# HELP app_login_total Total successful logins
# TYPE app_login_total counter
app_login_total{region="${REGION}"} ${metrics.loginCount}

# HELP app_active_users Currently active users
# TYPE app_active_users gauge
app_active_users{region="${REGION}"} ${metrics.activeUsers}

# HELP app_request_total Total HTTP requests
# TYPE app_request_total counter
app_request_total{region="${REGION}"} ${metrics.requestCount}

# HELP app_uptime_seconds Application uptime in seconds
# TYPE app_uptime_seconds gauge
app_uptime_seconds{region="${REGION}"} ${uptime}

# HELP app_memory_mb Heap memory used in MB
# TYPE app_memory_mb gauge
app_memory_mb{region="${REGION}"} ${memUsed}

# HELP app_cpu_load_avg CPU load average 1m
# TYPE app_cpu_load_avg gauge
app_cpu_load_avg{region="${REGION}"} ${cpuLoad.toFixed(4)}

# HELP app_failover_total Total failover events
# TYPE app_failover_total counter
app_failover_total{region="${REGION}"} ${metrics.failoverCount}

# HELP app_docker_containers_running Running containers
# TYPE app_docker_containers_running gauge
app_docker_containers_running{region="${REGION}"} ${metrics.dockerContainers.filter(c=>c.status==='running').length}

# HELP app_k8s_pods_running Running Kubernetes pods
# TYPE app_k8s_pods_running gauge
app_k8s_pods_running{region="${REGION}"} ${metrics.k8sPods.filter(p=>p.status==='Running').length}
`.trim();
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(body);
});

// ── API Endpoints ─────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
  const mem    = process.memoryUsage();
  res.json({
    region: REGION, primaryStatus: metrics.primaryStatus,
    secondaryStatus: metrics.secondaryStatus,
    primaryRegion: metrics.primaryRegion, secondaryRegion: metrics.secondaryRegion,
    uptime, loginCount: metrics.loginCount, activeUsers: metrics.activeUsers,
    requestCount: metrics.requestCount, failoverCount: metrics.failoverCount,
    memory: { used: Math.round(mem.heapUsed/1024/1024), total: Math.round(mem.heapTotal/1024/1024) },
    cpu: parseFloat(os.loadavg()[0].toFixed(2)),
    timestamp: new Date().toISOString(),
    trafficHistory: metrics.trafficHistory.slice(-30),
    cpuHistory: metrics.cpuHistory.slice(-30)
  });
});

app.get('/api/activity', requireAuth, (req, res) => {
  res.json({ logs: metrics.activityLog.slice(0, 25) });
});

app.get('/api/containers', requireAuth, (req, res) => {
  res.json({ containers: metrics.dockerContainers });
});

app.get('/api/pods', requireAuth, (req, res) => {
  res.json({ pods: metrics.k8sPods });
});

app.post('/api/failover', requireAuth, (req, res) => {
  const { action } = req.body;
  if (action === 'trigger') {
    if (metrics.primaryStatus === 'down')
      return res.json({ success: false, message: 'Primary already down' });
    metrics.primaryStatus   = 'down';
    metrics.secondaryStatus = 'active';
    metrics.failoverCount++;
    metrics.dockerContainers[0].status = 'stopped';
    metrics.k8sPods[0].status = 'Terminating';
    addLog('CRITICAL', 'DISASTER EVENT: us-east-1 health check FAILED');
    addLog('WARN',     'Route 53 failover policy activated');
    addLog('INFO',     'DNS TTL expiring — rerouting traffic to ap-south-1');
    addLog('INFO',     'Kubernetes rescheduling pods to secondary node pool');
    setTimeout(() => {
      addLog('SUCCESS', 'Failover COMPLETE — ap-south-1 now serving 100% traffic');
      addLog('INFO',    'Docker container aegis-app-replica promoted to primary');
    }, 1500);
  } else if (action === 'recover') {
    if (metrics.primaryStatus === 'healthy')
      return res.json({ success: false, message: 'Primary already healthy' });
    metrics.primaryStatus   = 'healthy';
    metrics.secondaryStatus = 'standby';
    metrics.dockerContainers[0].status = 'running';
    metrics.k8sPods[0].status = 'Running';
    addLog('INFO',    'us-east-1 instance back ONLINE — health check passing');
    addLog('INFO',    'Docker container aegis-app restarted successfully');
    addLog('INFO',    'Route 53 switching DNS back to primary region');
    addLog('SUCCESS', 'Self-healing COMPLETE — us-east-1 resumed as primary');
  } else {
    return res.status(400).json({ success: false, message: 'Unknown action' });
  }
  res.json({ success: true, primaryStatus: metrics.primaryStatus, secondaryStatus: metrics.secondaryStatus });
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  AEGIS v2.0 running at http://localhost:${PORT}`);
  console.log(`  Region: ${REGION} | Health: /health | Metrics: /metrics`);
  console.log(`  Login: admin / cloud123\n`);
});
