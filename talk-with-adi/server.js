'use strict';

/* =====================================================================
   TALK WITH ADI — server.js
   ---------------------------------------------------------------------
   One-to-many broadcast chat: one admin ("Adi") talks privately with
   many visitors. Visitors can never see or message each other.

   Handled here:
   • visitor registration / session resume
   • admin login (password protected)
   • private message routing (admin ⇄ one specific visitor)
   • image sharing (uploaded files via /api/upload, or inline base64)
   • WebRTC signalling (offer / answer / ice-candidate relay)
   • online-user tracking for the admin sidebar
   ===================================================================== */

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

/* ---------------------------------------------------------------------
   ⚙️  CONFIG
--------------------------------------------------------------------- */

// 🔑 ADMIN PASSWORD — change this to whatever you like.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'adi123';

// Render.com (and most hosts) inject the port via process.env.PORT.
const PORT = process.env.PORT || 3000;

const ADMIN_ROOM = 'admin-room';
const HISTORY_LIMIT = 500;                    // messages kept in memory per visitor
const MAX_TEXT_LENGTH = 4000;
const MAX_INLINE_IMAGE = 9 * 1024 * 1024;     // max chars for base64 data-URL images
const MAX_UPLOAD_SIZE = 8 * 1024 * 1024;      // 8 MB uploaded image limit
const MAX_LOGIN_ATTEMPTS = 5;                 // per socket, before disconnect

/* ---------------------------------------------------------------------
   Express + Socket.io setup
--------------------------------------------------------------------- */
const app = express();
app.disable('x-powered-by');

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 25 * 1024 * 1024, // allow large base64 image packets
});

/* ---------------------------------------------------------------------
   Image uploads (multer → ./uploads, served at /uploads/...)
--------------------------------------------------------------------- */
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname).toLowerCase().match(/^\.(png|jpe?g|gif|webp)$/) || ['.png'])[0];
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files (png, jpg, gif, webp) are allowed'));
  },
});

/* ---------------------------------------------------------------------
   Static pages + routes
--------------------------------------------------------------------- */
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No image received' });
  res.json({ ok: true, url: `/uploads/${req.file.filename}` });
});

// Upload error handler (multer size/type errors)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ ok: false, error: err.message || 'Upload failed' });
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

/* ---------------------------------------------------------------------
   In-memory state
   (conversations live in RAM; they reset when the server restarts)
--------------------------------------------------------------------- */
const users = new Map(); // userId → conversation object

function newConversation(id, name) {
  return {
    id,
    name,
    connected: false,
    sockets: new Set(),
    history: [],           // { from:'user'|'admin', type:'text'|'image', content, ts }
    unread: 0,             // visitor → admin messages not yet opened by admin
    lastSeen: Date.now(),
    lastMessageAt: null,
  };
}

const userRoom = (userId) => `user:${userId}`;

function isValidUserId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(id);
}

function sanitizeMessage(type, content) {
  if (type === 'text') {
    if (typeof content !== 'string') return null;
    const text = content.trim();
    if (!text) return null;
    return { type: 'text', content: text.slice(0, MAX_TEXT_LENGTH) };
  }
  if (type === 'image') {
    if (typeof content !== 'string') return null;
    const isUpload = content.startsWith('/uploads/');
    const isDataUrl = /^data:image\/(png|jpe?g|gif|webp);base64,/.test(content);
    if (!isUpload && !isDataUrl) return null;
    if (content.length > MAX_INLINE_IMAGE) return null;
    return { type: 'image', content };
  }
  return null;
}

function storeMessage(conv, message) {
  conv.history.push(message);
  if (conv.history.length > HISTORY_LIMIT) conv.history.splice(0, conv.history.length - HISTORY_LIMIT);
  conv.lastMessageAt = message.ts;
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function usersPayload() {
  const list = [];
  for (const u of users.values()) {
    const last = u.history[u.history.length - 1];
    list.push({
      id: u.id,
      name: u.name,
      online: u.connected,
      lastSeen: u.lastSeen,
      unread: u.unread,
      lastMessageAt: u.lastMessageAt,
      preview: last ? (last.type === 'image' ? '📷 Photo' : truncate(last.content, 60)) : '',
    });
  }
  list.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (b.lastMessageAt || 0) - (a.lastMessageAt || 0);
  });
  return list;
}

function notifyAdminUserList() {
  io.to(ADMIN_ROOM).emit('admin:users-updated', { users: usersPayload() });
}

function adminOnlineCount() {
  return (io.sockets.adapter.rooms.get(ADMIN_ROOM) || new Set()).size;
}

function broadcastPresence() {
  io.emit('presence', { adminOnline: adminOnlineCount() > 0 });
}

function roomHasSockets(room) {
  return (io.sockets.adapter.rooms.get(room) || new Set()).size > 0;
}

/* ---------------------------------------------------------------------
   WebRTC call signalling helpers
   A visitor may only call the admin; the admin may call any visitor.
   The server never inspects SDP — it just relays it to the target room.
--------------------------------------------------------------------- */
function resolveCallTargetRoom(socket, to) {
  if (socket.data.isAdmin) {
    if (typeof to === 'string' && to !== 'admin' && users.has(to)) return userRoom(to);
    return null;
  }
  if (socket.data.userId && to === 'admin') return ADMIN_ROOM;
  return null; // visitors can never reach other visitors
}

function senderInfo(socket) {
  if (socket.data.isAdmin) return { kind: 'admin' };
  const conv = users.get(socket.data.userId);
  return { kind: 'user', userId: socket.data.userId, name: conv ? conv.name : 'Visitor' };
}

/* ---------------------------------------------------------------------
   Socket.io wiring
--------------------------------------------------------------------- */
io.on('connection', (socket) => {
  socket.data.userId = null;
  socket.data.isAdmin = false;
  socket.data.loginAttempts = 0;

  /* ================= VISITOR: register / resume ================= */
  socket.on('register', (payload, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    const data = payload || {};
    const name = typeof data.name === 'string' ? data.name.trim().slice(0, 40) : '';

    if (!socket.data.userId && !isValidUserId(data.userId) && !name) {
      return done({ ok: false, error: 'Please enter your name.' });
    }

    let conv;
    if (isValidUserId(data.userId) && users.has(data.userId)) {
      conv = users.get(data.userId);          // resume an existing conversation
      if (name) conv.name = name;
    } else {
      if (!name) return done({ ok: false, error: 'Please enter your name.' });
      const id = isValidUserId(data.userId)
        ? data.userId
        : crypto.randomBytes(6).toString('base64url');
      conv = newConversation(id, name);
      users.set(id, conv);
    }

    socket.data.userId = conv.id;
    socket.join(userRoom(conv.id));
    conv.sockets.add(socket.id);

    const wasConnected = conv.connected;
    conv.connected = true;
    conv.lastSeen = Date.now();
    if (!wasConnected) notifyAdminUserList();

    done({
      ok: true,
      userId: conv.id,
      name: conv.name,
      adminOnline: adminOnlineCount() > 0,
      history: conv.history,
    });
  });

  /* ================= VISITOR: send a chat message ================= */
  socket.on('chat-message', (payload) => {
    const conv = users.get(socket.data.userId);
    if (!conv) return;
    const msg = sanitizeMessage(payload && payload.type, payload && payload.content);
    if (!msg) return;

    const message = { from: 'user', type: msg.type, content: msg.content, ts: Date.now() };
    storeMessage(conv, message);
    conv.unread += 1;

    // Deliver to every tab of this visitor (echo-back keeps tabs in sync)…
    io.to(userRoom(conv.id)).emit('message', message);
    // …and to the admin dashboard.
    io.to(ADMIN_ROOM).emit('admin:message', { userId: conv.id, message });
    notifyAdminUserList();
  });

  /* ================= VISITOR: typing indicator ================= */
  socket.on('typing', (payload) => {
    if (!socket.data.userId) return;
    io.to(ADMIN_ROOM).emit('admin:typing', {
      userId: socket.data.userId,
      isTyping: !!(payload && payload.isTyping),
    });
  });

  /* ================= ADMIN: login ================= */
  socket.on('admin-login', (payload, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    if (socket.data.isAdmin) return done({ ok: true });

    const password = payload && typeof payload.password === 'string' ? payload.password : '';
    if (password !== ADMIN_PASSWORD) {
      socket.data.loginAttempts += 1;
      if (socket.data.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
        done({ ok: false, error: 'Too many failed attempts.' });
        return socket.disconnect(true);
      }
      return done({ ok: false, error: 'Wrong password. Try again.' });
    }

    socket.data.isAdmin = true;
    socket.join(ADMIN_ROOM);
    broadcastPresence();
    socket.emit('admin:logged-in', { users: usersPayload() });
    done({ ok: true });
  });

  /* Guard used by every admin-only event below */
  const requireAdmin = () => socket.data.isAdmin === true;

  socket.on('admin:get-users', (payload, ack) => {
    if (!requireAdmin()) return;
    const done = typeof ack === 'function' ? ack : typeof payload === 'function' ? payload : null;
    if (done) done({ ok: true, users: usersPayload() });
  });

  socket.on('admin:get-history', (payload, ack) => {
    if (!requireAdmin()) return;
    const done = typeof ack === 'function' ? ack : () => {};
    const conv = users.get(payload && payload.userId);
    if (!conv) return done({ ok: false, error: 'Unknown user.' });
    done({ ok: true, history: conv.history });
  });

  socket.on('admin:message', (payload) => {
    if (!requireAdmin()) return;
    const conv = users.get(payload && payload.userId);
    if (!conv) return;
    const msg = sanitizeMessage(payload && payload.type, payload && payload.content);
    if (!msg) return;

    const message = { from: 'admin', type: msg.type, content: msg.content, ts: Date.now() };
    storeMessage(conv, message);

    // Deliver to the visitor…
    io.to(userRoom(conv.id)).emit('message', message);
    // …and echo to every logged-in admin tab.
    io.to(ADMIN_ROOM).emit('admin:message', { userId: conv.id, message });
    notifyAdminUserList();
  });

  socket.on('admin:typing', (payload) => {
    if (!requireAdmin()) return;
    const conv = users.get(payload && payload.userId);
    if (!conv) return;
    io.to(userRoom(conv.id)).emit('typing', { isTyping: !!(payload && payload.isTyping) });
  });

  socket.on('admin:read', (payload, ack) => {
    if (!requireAdmin()) return;
    const conv = users.get(payload && payload.userId);
    if (conv) {
      conv.unread = 0;
      notifyAdminUserList();
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  /* ================= WEBRTC SIGNALLING (both directions) ================= */

  // "I want to start a call with <to>"
  socket.on('call:initiate', (payload, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    if (!socket.data.userId && !socket.data.isAdmin) return done({ ok: false, error: 'Not registered.' });
    const callId = payload && payload.callId;
    const room = resolveCallTargetRoom(socket, payload && payload.to);
    if (!callId || !room) return done({ ok: false, error: 'Invalid call target.' });
    if (!roomHasSockets(room)) return done({ ok: false, error: 'offline' });

    io.to(room).emit('call:incoming', { callId, from: senderInfo(socket) });
    done({ ok: true });
  });

  // "I accept the call"
  socket.on('call:answer', (payload) => {
    const room = resolveCallTargetRoom(socket, payload && payload.to);
    if (!room || !payload || !payload.callId) return;
    io.to(room).emit('call:answered', { callId: payload.callId });
  });

  // "I decline the call"
  socket.on('call:decline', (payload) => {
    const room = resolveCallTargetRoom(socket, payload && payload.to);
    if (!room || !payload || !payload.callId) return;
    io.to(room).emit('call:declined', { callId: payload.callId });
  });

  // "Hang up"
  socket.on('call:end', (payload) => {
    const room = resolveCallTargetRoom(socket, payload && payload.to);
    if (!room) return;
    io.to(room).emit('call:end', {
      callId: payload && payload.callId,
      reason: (payload && payload.reason) || 'ended',
    });
  });

  // offer / answer / ice-candidate relay
  socket.on('rtc:signal', (payload) => {
    const room = resolveCallTargetRoom(socket, payload && payload.to);
    if (!room || !payload || !payload.data) return;
    io.to(room).emit('rtc:signal', {
      callId: payload.callId,
      from: senderInfo(socket),
      data: payload.data,
    });
  });

  /* ================= DISCONNECT ================= */
  socket.on('disconnect', () => {
    // Visitor left
    if (socket.data.userId) {
      const conv = users.get(socket.data.userId);
      if (conv) {
        conv.sockets.delete(socket.id);
        if (conv.sockets.size === 0 && conv.connected) {
          conv.connected = false;
          conv.lastSeen = Date.now();
          notifyAdminUserList();
        }
      }
    }
    // Admin left
    if (socket.data.isAdmin) {
      // Room membership is already removed at this point; re-broadcast presence.
      setImmediate(broadcastPresence);
    }
  });
});

/* ---------------------------------------------------------------------
   Start
--------------------------------------------------------------------- */
httpServer.listen(PORT, () => {
  console.log(`✅ Talk with Adi running at http://localhost:${PORT}`);
  console.log(`   Visitor page : http://localhost:${PORT}/`);
  console.log(`   Admin panel  : http://localhost:${PORT}/admin.html`);
});
