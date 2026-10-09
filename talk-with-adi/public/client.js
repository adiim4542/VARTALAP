/* ============================================================
   TALK WITH ADI — client.js (visitor side)
   ============================================================ */
(() => {
  'use strict';

  const STUN = { urls: 'stun:stun.l.google.com:19302' };
  const SMALL_IMAGE_LIMIT = 700 * 1024; // bytes — smaller images go inline as base64

  /* ---------------- state ---------------- */
  let socket = null;
  let joined = false;
  let userId = localStorage.getItem('twa_userId') || null;
  let userName = localStorage.getItem('twa_name') || null;
  let lastRenderedTs = 0;

  // call state
  let pc = null;
  let localStream = null;
  let currentCallId = null;
  let currentCallPeer = null; // visitors only ever call 'admin'
  let callActive = false;
  let pendingIncoming = null; // callId of a ringing incoming call
  let typingSent = false;
  let typingTimeout = null;

  /* ---------------- elements ---------------- */
  const $ = (id) => document.getElementById(id);
  const joinScreen = $('join-screen');
  const chatScreen = $('chat-screen');
  const nameInput = $('name-input');
  const joinBtn = $('join-btn');
  const joinError = $('join-error');
  const messagesEl = $('messages');
  const msgInput = $('msg-input');
  const sendBtn = $('send-btn');
  const imgBtn = $('img-btn');
  const imgInput = $('img-input');
  const typingIndicator = $('typing-indicator');
  const connStatus = $('conn-status');
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

  function safeImageSrc(content) {
    if (content.startsWith('/uploads/')) return content;
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/.test(content)) return content;
    return null;
  }

  function appendMessage(message) {
    const mine = message.from === 'user';
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

  function renderHistory(history) {
    for (const m of history) {
      if (m.ts > lastRenderedTs) {
        appendMessage(m);
        lastRenderedTs = m.ts;
      }
    }
  }

  /* ---------------- socket + registration ---------------- */
  function connect() {
    socket = io();

    socket.on('connect', () => {
      connStatus.textContent = 'connected';
      connStatus.className = 'peer-status online';
      if (joined) {
        // Reconnected — re-register so the server knows who we are again.
        socket.emit('register', { name: userName, userId }, (res) => {
          if (res && res.ok) renderHistory(res.history || []);
        });
      }
    });

    socket.on('disconnect', () => {
      connStatus.textContent = 'reconnecting…';
      connStatus.className = 'peer-status offline';
    });

    socket.on('presence', ({ adminOnline }) => setPresence(adminOnline));

    socket.on('message', (message) => {
      if (message.ts > lastRenderedTs) {
        appendMessage(message);
        lastRenderedTs = message.ts;
      }
    });

    socket.on('typing', ({ isTyping }) => {
      typingIndicator.classList.toggle('hidden', !isTyping);
    });

    /* ---- WebRTC signalling ---- */
    socket.on('call:incoming', onCallIncoming);
    socket.on('call:answered', onCallAnswered);
    socket.on('call:declined', onCallDeclined);
    socket.on('call:end', onCallEndedRemote);
    socket.on('rtc:signal', onRtcSignal);
  }

  function setPresence(adminOnline) {
    const status = $('conn-status');
    if (adminOnline) {
      status.textContent = 'Adi is online';
      status.className = 'peer-status online';
    } else {
      status.textContent = 'Adi is offline — messages will be delivered later';
      status.className = 'peer-status offline';
    }
  }

  function register(name) {
    socket.emit('register', { name, userId }, (res) => {
      if (!res || !res.ok) {
        joinError.textContent = (res && res.error) || 'Something went wrong.';
        show(joinError);
        return;
      }
      joined = true;
      userId = res.userId;
      userName = res.name;
      localStorage.setItem('twa_userId', userId);
      localStorage.setItem('twa_name', userName);
      hide(joinError);
      hide(joinScreen);
      show(chatScreen);
      renderHistory(res.history || []);
      setPresence(res.adminOnline);
      msgInput.focus();
    });
  }

  /* ---------------- sending ---------------- */
  function sendMessage(type, content) {
    if (!joined || !socket) return;
    socket.emit('chat-message', { userId, type, content });
    stopTypingSignal();
  }

  function sendText() {
    const text = msgInput.value.trim();
    if (!text) return;
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
    toast('Sending photo…', 1500);
    try {
      if (file.size <= SMALL_IMAGE_LIMIT) {
        // Small image → send inline as base64 data URL.
        const dataUrl = await readFileAsDataURL(file);
        sendMessage('image', dataUrl);
        return;
      }
      // Bigger image → upload, then send the URL.
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
    if (!typingSent) {
      typingSent = true;
      socket.emit('typing', { userId, isTyping: true });
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(stopTypingSignal, 1400);
  }

  function stopTypingSignal() {
    clearTimeout(typingTimeout);
    if (typingSent) {
      typingSent = false;
      socket.emit('typing', { userId, isTyping: false });
    }
  }

  /* ============================================================
     WEBRTC VIDEO CALLING
     The browser shows its normal camera/mic permission prompt —
     getUserMedia is only ever called after a user clicks a button.
     ============================================================ */

  async function getMedia() {
    // ⚠️ This triggers the browser's standard permission prompt.
    return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  }

  function newPeerConnection() {
    const p = new RTCPeerConnection({ iceServers: [STUN] });
    p.onicecandidate = (e) => {
      if (e.candidate && currentCallId) {
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

  function showCallOverlay(statusText) {
    setCallStatus(statusText);
    show(callOverlay);
  }

  function attachLocalStream() {
    if (!pc || !localStream) return;
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    localVideo.srcObject = localStream;
  }

  /* --- visitor calls admin --- */
  async function startCall() {
    if (callActive || pendingIncoming) return;
    try {
      localStream = await getMedia(); // browser permission prompt appears here
    } catch (err) {
      console.warn('getUserMedia denied', err);
      toast('Camera/microphone permission is needed to start a video call.');
      return;
    }
    currentCallId = 'call_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    currentCallPeer = 'admin';
    pc = newPeerConnection();
    attachLocalStream();
    showCallOverlay('Calling Adi…');

    socket.emit('call:initiate', { callId: currentCallId, to: 'admin' }, (res) => {
      if (!res || !res.ok) {
        cleanupCall();
        toast(res && res.error === 'offline' ? 'Adi is not online right now.' : 'Could not start the call.');
      }
    });
  }

  /* --- admin calls visitor (incoming) --- */
  function onCallIncoming({ callId, from }) {
    if (callActive || pendingIncoming) {
      socket.emit('call:decline', { callId, to: 'admin' }); // busy
      return;
    }
    pendingIncoming = callId;
    $('incoming-from').textContent = `${from.kind === 'admin' ? 'Adi' : from.name} is calling you…`;
    show(incomingCallModal);
  }

  async function acceptIncoming() {
    const callId = pendingIncoming;
    hide(incomingCallModal);
    pendingIncoming = null;
    if (!callId) return;

    try {
      localStream = await getMedia(); // browser permission prompt appears here
    } catch (err) {
      console.warn('getUserMedia denied', err);
      socket.emit('call:decline', { callId, to: 'admin' });
      toast('Camera/microphone permission is needed to answer a call.');
      return;
    }

    currentCallId = callId;
    currentCallPeer = 'admin';
    callActive = true;
    pc = newPeerConnection();
    attachLocalStream();
    showCallOverlay('Connecting…');
    socket.emit('call:answer', { callId, to: 'admin' });
  }

  function declineIncoming() {
    if (pendingIncoming) socket.emit('call:decline', { callId: pendingIncoming, to: 'admin' });
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
  joinBtn.addEventListener('click', () => register(nameInput.value));
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') register(nameInput.value); });

  sendBtn.addEventListener('click', sendText);
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
  });
  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    if (msgInput.value.trim() && joined) sendTypingSignal();
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
  if (userId && userName) {
    // Returning visitor → skip the join screen and resume the session.
    register(userName);
  }
})();
