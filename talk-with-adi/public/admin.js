/* ============================================================
   TALK WITH ADI — admin.js (admin dashboard)
   ============================================================ */
(() => {
  'use strict';

  const STUN = { urls: 'stun:stun.l.google.com:19302' };
  const SMALL_IMAGE_LIMIT = 700 * 1024; // bytes — smaller images go inline as base64

  /* ---------------- state ---------------- */
  let socket = null;
  let loggedIn = false;
  let userList = [];            // latest users payload from the server
  let selectedUserId = null;
  let lastRenderedTs = 0;

  // call state
  let pc = null;
  let localStream = null;
  let currentCallId = null;
  let currentCallPeer = null;   // userId of the visitor on the call
  let callActive = false;
  let pendingIncoming = null;   // { callId, userId, name } of ringing call
  let typingSent = false;
  let typingTimeout = null;

  /* ---------------- elements ---------------- */
  const $ = (id) => document.getElementById(id);
  const loginScreen = $('login-screen');
  const passwordInput = $('password-input');
  const loginBtn = $('login-btn');
  const loginError = $('login-error');
  const dashboard = $('dashboard');
  const userListEl = $('user-list');
  const logoutBtn = $('logout-btn');

  const emptyState = $('empty-state');
  const chatPanel = $('chat-panel');
  const peerAvatar = $('peer-avatar');
  const peerName = $('peer-name');
  const peerStatus = $('peer-status');
  const messagesEl = $('messages');
  const msgInput = $('msg-input');
  const sendBtn = $('send-btn');
  const imgBtn = $('img-btn');
  const imgInput = $('img-input');
  const typingIndicator = $('typing-indicator');
  const callBtn = $('call-btn');

  const incomingCallModal = $('incoming-call');
  const acceptCallBtn = $('accept-call-btn');
  const declineCallBtn = $('decline-call-btn');

  const callOverlay = $('call-overlay');
  const remoteVideo = $('remote-video');
  const localVideo = $('local-video');
  const callStatusEl = $('call-status');
  const toggleCamBtn = $('toggle-cam');
  const toggleMicBtn = $('toggle-mic');
  const endCallBtn = $('end-call-btn');

  const toastEl = $('toast');

  /* ---------------- helpers ---------------- */
  function toast(text, ms = 3000) {
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function safeImageSrc(content) {
    if (content.startsWith('/uploads/')) return content;
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/.test(content)) return content;
    return null;
  }

  function selectedUser() {
    return userList.find((u) => u.id === selectedUserId) || null;
  }

  function appendMessage(message) {
    // The admin is "me"; the visitor is "them".
    const mine = message.from === 'admin';
    const row = document.createElement('div');
    row.className = `msg ${mine ? 'me' : 'them'}`;

    if (message.type === 'image') {
      const src = safeImageSrc(message.content);
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.className = 'msg-img';
        img.alt = 'shared image';
        img.addEventListener('click', () => window.open(src, '_blank'));
        row.appendChild(img);
      }
    } else {
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      bubble.textContent = message.content; // textContent → no HTML injection
      row.appendChild(bubble);
    }

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = fmtTime(message.ts);
    row.appendChild(time);

    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /* ---------------- login ---------------- */
  function connect() {
    socket = io();

    socket.on('admin:logged-in', ({ users }) => {
      loggedIn = true;
      hide(loginScreen);
      show(dashboard);
      renderUserList(users);
      toast(`Welcome back, Adi 👋`);
    });

    socket.on('admin:users-updated', ({ users }) => {
      if (!loggedIn) return;
      renderUserList(users);
    });

    socket.on('admin:message', ({ userId, message }) => {
      if (!loggedIn) return;
      if (userId === selectedUserId && message.ts > lastRenderedTs) {
        appendMessage(message);
        lastRenderedTs = message.ts;
      }
    });

    socket.on('admin:typing', ({ userId, isTyping }) => {
      if (userId === selectedUserId) {
        typingIndicator.classList.toggle('hidden', !isTyping);
      }
    });

    socket.on('disconnect', () => {
      if (loggedIn) toast('Connection lost — reconnecting…');
    });

    /* ---- WebRTC signalling ---- */
    socket.on('call:incoming', onCallIncoming);
    socket.on('call:answered', onCallAnswered);
    socket.on('call:declined', onCallDeclined);
    socket.on('call:end', onCallEndedRemote);
    socket.on('rtc:signal', onRtcSignal);
  }

  function tryLogin() {
    const password = passwordInput.value;
    if (!password) return;
    socket.emit('admin-login', { password }, (res) => {
      if (res && res.ok) {
        hide(loginError);
        passwordInput.value = '';
        // Dashboard is revealed by the 'admin:logged-in' event.
      } else {
        loginError.textContent = (res && res.error) || 'Login failed.';
        show(loginError);
        passwordInput.select();
      }
    });
  }

  /* ---------------- sidebar ---------------- */
  function renderUserList(users) {
    userList = users || [];
    userListEl.innerHTML = '';

    if (!userList.length) {
      const li = document.createElement('li');
      li.className = 'sidebar-empty';
      li.textContent = 'No visitors yet. Share your link and wait for someone to say hi!';
      userListEl.appendChild(li);
      return;
    }

    for (const u of userList) {
      const li = document.createElement('li');
      li.className = 'user-item' + (u.id === selectedUserId ? ' active' : '');

      li.innerHTML = `
        <div class="avatar">${escapeHtml((u.name || '?').charAt(0).toUpperCase())}</div>
        <div class="user-meta">
          <div class="user-name">
            <span class="dot ${u.online ? 'on' : 'off'}"></span>
            ${escapeHtml(u.name)}
          </div>
          <div class="user-preview">${escapeHtml(u.preview || 'No messages yet')}</div>
        </div>
        ${u.unread ? `<span class="badge">${u.unread > 99 ? '99+' : u.unread}</span>` : ''}
      `;
      li.addEventListener('click', () => selectUser(u.id));
      userListEl.appendChild(li);
    }

    // Refresh header info if the selected user changed status.
    if (selectedUserId) refreshPeerHeader();
  }

  function refreshPeerHeader() {
    const u = selectedUser();
    if (!u) return;
    peerAvatar.textContent = (u.name || '?').charAt(0).toUpperCase();
    peerName.textContent = u.name;
    peerStatus.textContent = u.online ? 'online' : `last seen ${new Date(u.lastSeen).toLocaleString()}`;
    peerStatus.className = 'peer-status ' + (u.online ? 'online' : 'offline');
  }

  function selectUser(userId) {
    selectedUserId = userId;
    lastRenderedTs = 0;
    messagesEl.innerHTML = '';
    hide(typingIndicator);

    hide(emptyState);
    show(chatPanel);
    refreshPeerHeader();
    renderUserList(userList); // refresh the "active" highlight

    socket.emit('admin:read', { userId });
    socket.emit('admin:get-history', { userId }, (res) => {
      if (!res || !res.ok || selectedUserId !== userId) return;
      for (const m of res.history) {
        appendMessage(m);
        if (m.ts > lastRenderedTs) lastRenderedTs = m.ts;
      }
    });
    msgInput.focus();
  }

  /* ---------------- sending ---------------- */
  function sendMessage(type, content) {
    if (!loggedIn || !selectedUserId) return;
    socket.emit('admin:message', { userId: selectedUserId, type, content });
    stopTypingSignal();
  }

  function sendText() {
    const text = msgInput.value.trim();
    if (!text) return;
    if (!selectedUserId) { toast('Select a visitor first.'); return; }
    sendMessage('text', text);
    msgInput.value = '';
    msgInput.style.height = 'auto';
  }

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function sendImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    if (!selectedUserId) { toast('Select a visitor first.'); return; }
    toast('Sending photo…', 1500);
    try {
      if (file.size <= SMALL_IMAGE_LIMIT) {
        const dataUrl = await readFileAsDataURL(file);
        sendMessage('image', dataUrl);
        return;
      }
      const fd = new FormData();
      fd.append('image', file);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const json = await res.json();
      if (json.ok) sendMessage('image', json.url);
      else toast(json.error || 'Image upload failed.');
    } catch (err) {
      console.error(err);
      toast('Could not send image.');
    } finally {
      imgInput.value = '';
    }
  }

  function sendTypingSignal() {
    if (!selectedUserId) return;
    if (!typingSent) {
      typingSent = true;
      socket.emit('admin:typing', { userId: selectedUserId, isTyping: true });
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(stopTypingSignal, 1400);
  }

  function stopTypingSignal() {
    clearTimeout(typingTimeout);
    if (typingSent) {
      typingSent = false;
      if (selectedUserId) socket.emit('admin:typing', { userId: selectedUserId, isTyping: false });
    }
  }

  /* ============================================================
     WEBRTC VIDEO CALLING (admin side)
     getUserMedia is only called after an explicit button click,
     so the browser shows its normal permission prompt.
     ============================================================ */

  async function getMedia() {
    return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  }

  function newPeerConnection() {
    const p = new RTCPeerConnection({ iceServers: [STUN] });
    p.onicecandidate = (e) => {
      if (e.candidate && currentCallId && currentCallPeer) {
        socket.emit('rtc:signal', {
          callId: currentCallId,
          to: currentCallPeer,
          data: { type: 'candidate', candidate: e.candidate },
        });
      }
    };
    p.ontrack = (e) => {
      remoteVideo.srcObject = e.streams[0];
    };
    p.onconnectionstatechange = () => {
      if (!pc) return;
      if (p.connectionState === 'connected') setCallStatus('Connected');
      if (p.connectionState === 'failed') endCall('failed');
    };
    return p;
  }

  function setCallStatus(text) { callStatusEl.textContent = text; }

  function attachLocalStream() {
    if (!pc || !localStream) return;
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    localVideo.srcObject = localStream;
  }

  /* --- admin calls a visitor --- */
  async function startCall() {
    if (!selectedUserId) { toast('Select a visitor to call.'); return; }
    if (callActive || pendingIncoming) return;
    const u = selectedUser();
    if (u && !u.online) { toast(`${u.name} is offline right now.`); return; }

    try {
      localStream = await getMedia(); // browser permission prompt appears here
    } catch (err) {
      console.warn('getUserMedia denied', err);
      toast('Camera/microphone permission is needed to start a video call.');
      return;
    }

    currentCallId = 'call_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    currentCallPeer = selectedUserId;
    pc = newPeerConnection();
    attachLocalStream();
    setCallStatus(`Calling ${u ? u.name : 'visitor'}…`);
    show(callOverlay);

    socket.emit('call:initiate', { callId: currentCallId, to: selectedUserId }, (res) => {
      if (!res || !res.ok) {
        cleanupCall();
        toast(res && res.error === 'offline' ? 'That visitor is not online right now.' : 'Could not start the call.');
      }
    });
  }

  /* --- visitor calls admin (incoming) --- */
  function onCallIncoming({ callId, from }) {
    if (callActive || pendingIncoming) {
      socket.emit('call:decline', { callId, to: from.userId }); // busy
      return;
    }
    pendingIncoming = { callId, userId: from.userId, name: from.name };
    $('incoming-from').textContent = `${from.name} is calling you…`;
    show(incomingCallModal);
  }

  async function acceptIncoming() {
    const pending = pendingIncoming;
    hide(incomingCallModal);
    pendingIncoming = null;
    if (!pending) return;

    try {
      localStream = await getMedia(); // browser permission prompt appears here
    } catch (err) {
      console.warn('getUserMedia denied', err);
      socket.emit('call:decline', { callId: pending.callId, to: pending.userId });
      toast('Camera/microphone permission is needed to answer a call.');
      return;
    }

    currentCallId = pending.callId;
    currentCallPeer = pending.userId;
    callActive = true;
    pc = newPeerConnection();
    attachLocalStream();
    setCallStatus(`Connecting with ${pending.name}…`);
    show(callOverlay);
    socket.emit('call:answer', { callId: pending.callId, to: pending.userId });
  }

  function declineIncoming() {
    if (pendingIncoming) {
      socket.emit('call:decline', { callId: pendingIncoming.callId, to: pendingIncoming.userId });
    }
    pendingIncoming = null;
    hide(incomingCallModal);
  }

  /* --- signalling handlers --- */
  function onCallAnswered({ callId }) {
    if (callId !== currentCallId || !pc) return;
    setCallStatus('Connected — starting…');
    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('rtc:signal', {
          callId,
          to: currentCallPeer,
          data: { type: 'offer', sdp: pc.localDescription },
        });
      } catch (err) {
        console.error(err);
        endCall('failed');
      }
    })();
  }

  function onCallDeclined({ callId }) {
    if (callId !== currentCallId) return;
    cleanupCall();
    toast('Call declined.');
  }

  function onCallEndedRemote({ callId, reason }) {
    if (callId && callId !== currentCallId) return;
    const wasActive = callActive || pc !== null;
    cleanupCall();
    if (wasActive) toast(reason === 'failed' ? 'Call connection failed.' : 'Call ended.');
  }

  async function onRtcSignal({ callId, data }) {
    if (callId !== currentCallId || !pc || !data) return;
    try {
      if (data.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('rtc:signal', {
          callId,
          to: currentCallPeer,
          data: { type: 'answer', sdp: pc.localDescription },
        });
        setCallStatus('Connected');
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        setCallStatus('Connected');
      } else if (data.type === 'candidate' && data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (err) {
      console.error('RTC signalling error', err);
    }
  }

  /* --- hang up / cleanup --- */
  function endCall(reason) {
    if (currentCallId && currentCallPeer) {
      socket.emit('call:end', { callId: currentCallId, to: currentCallPeer, reason: reason || 'ended' });
    }
    cleanupCall();
  }

  function cleanupCall() {
    callActive = false;
    pendingIncoming = null;
    currentCallId = null;
    currentCallPeer = null;
    if (pc) { try { pc.close(); } catch (_) { /* noop */ } pc = null; }
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    hide(callOverlay);
    hide(incomingCallModal);
    toggleCamBtn.classList.remove('off');
    toggleMicBtn.classList.remove('off');
  }

  function toggleTrack(kind) {
    if (!localStream) return;
    const tracks = kind === 'video' ? localStream.getVideoTracks() : localStream.getAudioTracks();
    let anyOn = false;
    tracks.forEach((t) => { t.enabled = !t.enabled; if (t.enabled) anyOn = true; });
    const btn = kind === 'video' ? toggleCamBtn : toggleMicBtn;
    btn.classList.toggle('off', !anyOn);
  }

  /* ---------------- UI wiring ---------------- */
  loginBtn.addEventListener('click', tryLogin);
  passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });

  logoutBtn.addEventListener('click', () => {
    sessionStorage.clear();
    location.reload();
  });

  sendBtn.addEventListener('click', sendText);
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
  });
  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    if (msgInput.value.trim() && loggedIn) sendTypingSignal();
  });

  imgBtn.addEventListener('click', () => imgInput.click());
  imgInput.addEventListener('change', () => {
    if (imgInput.files && imgInput.files[0]) sendImageFile(imgInput.files[0]);
  });

  callBtn.addEventListener('click', startCall);
  acceptCallBtn.addEventListener('click', acceptIncoming);
  declineCallBtn.addEventListener('click', declineIncoming);
  endCallBtn.addEventListener('click', () => endCall('ended'));
  toggleCamBtn.addEventListener('click', () => toggleTrack('video'));
  toggleMicBtn.addEventListener('click', () => toggleTrack('audio'));

  /* ---------------- boot ---------------- */
  connect();
})();
