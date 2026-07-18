/**
 * ClassConnect – WebRTC Video Module
 * Peer-to-peer video/audio with screen sharing.
 * Signalling is handled by Flask-SocketIO; all media flows P2P via WebRTC.
 *
 * Expected globals (injected by session_room.html):
 *   CC_SESSION_ID  – integer session id
 *   CC_USER_ID     – current user id (integer)
 *   CC_USER_NAME   – current user display name (string)
 */

// ICE servers (STUN + TURN) are fetched from the backend at startup rather
// than hardcoded, so a real TURN server can be used without embedding its
// secret API key in client-side JS. Falls back to STUN-only if the fetch
// fails, which still works fine for peers on the same network.
let ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

async function loadIceServers() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000); // never hang more than 6s
    const res = await fetch('/api/turn-credentials', { signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      if (data.iceServers && data.iceServers.length) {
        ICE_SERVERS = { iceServers: data.iceServers };
        console.log('TURN credentials loaded:', data.iceServers.length, 'servers');
      }
    }
  } catch (e) {
    console.warn('Could not load TURN credentials in time, using STUN-only fallback', e);
  }
}

let socket;
let localStream       = null;   // camera / mic stream
let screenStream       = null;   // screen share stream
let currentVideoTrack  = null;   // whichever video track is CURRENTLY being sent
                                  // (camera or screen) — new peer connections
                                  // must use this, not always localStream's
                                  // original camera track, or a peer that
                                  // joins mid-screen-share sees a stale/no
                                  // camera feed instead of the live screen.
const peers       = {};     // { user_id: RTCPeerConnection }
const peerNames   = {};     // { user_id: display_name }

// ── UI helpers ────────────────────────────────────────────────────────────────

function getVideoGrid()    { return document.getElementById('video-grid'); }
function getStatusBar()    { return document.getElementById('video-status'); }
function setStatus(msg)    { const s = getStatusBar(); if (s) s.textContent = msg; }

function createVideoTile(userId, name, muted = false) {
  if (document.getElementById(`tile-${userId}`)) return;

  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${userId}`;

  const video = document.createElement('video');
  video.id        = `video-${userId}`;
  video.autoplay  = true;
  video.playsInline = true;
  video.muted     = muted;   // local preview must be muted to avoid echo

  const label = document.createElement('div');
  label.className  = 'video-label';
  label.textContent = name;

  // Fullscreen toggle — makes the tile fill the phone/laptop screen for a
  // much clearer view, especially useful on small mobile screens where the
  // default grid tile is quite small.
  const fsBtn = document.createElement('button');
  fsBtn.className = 'video-fullscreen-btn';
  fsBtn.type = 'button';
  fsBtn.title = 'Fullscreen';
  fsBtn.textContent = '⛶';
  fsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTileFullscreen(tile);
  });

  tile.appendChild(video);
  tile.appendChild(label);
  tile.appendChild(fsBtn);

  // Quick mute control right on the tile — lecturer only, and only on
  // OTHER people's tiles (not their own). The participant table below the
  // video grid has the same control too; this is just faster to reach
  // mid-call since it's right where the lecturer is already looking.
  if (CC_USER_ROLE === 'lecturer' && userId !== CC_USER_ID) {
    const muteBtn = document.createElement('button');
    muteBtn.className = 'video-tile-mute-btn';
    muteBtn.type = 'button';
    muteBtn.title = 'Mute this student';
    muteBtn.textContent = '🔇';
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      forceMuteStudent(userId);
    });
    tile.appendChild(muteBtn);
  }
  getVideoGrid().appendChild(tile);
  return video;
}

function toggleTileFullscreen(tile) {
  if (document.fullscreenElement === tile) {
    document.exitFullscreen();
  } else if (tile.requestFullscreen) {
    tile.requestFullscreen().catch(() => {});
  }
}

function removeVideoTile(userId) {
  const tile = document.getElementById(`tile-${userId}`);
  if (tile) tile.remove();
}

function setVideoStream(userId, stream) {
  const video = document.getElementById(`video-${userId}`);
  if (video) video.srcObject = stream;
}

// ── Local media ───────────────────────────────────────────────────────────────

async function startCamera() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    currentVideoTrack = localStream.getVideoTracks()[0] || null;
    createVideoTile(CC_USER_ID, CC_USER_NAME + ' (You)', true);
    setVideoStream(CC_USER_ID, localStream);
    addLocalTracksToPeers();
    setStatus('Camera on.');
    document.getElementById('btn-camera').textContent = '📷 Stop Camera';
    document.getElementById('btn-camera').dataset.active = '1';
  } catch (e) {
    setStatus('Could not access camera/mic. Check browser permissions.');
    console.error(e);
  }
}

function stopCamera() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  removeVideoTile(CC_USER_ID);
  // Replace tracks in existing peer connections with silence/black
  Object.values(peers).forEach(pc => {
    pc.getSenders().forEach(sender => {
      if (sender.track) sender.track.stop();
    });
  });
  setStatus('Camera off.');
  document.getElementById('btn-camera').textContent = '📷 Start Camera';
  document.getElementById('btn-camera').dataset.active = '0';
}

async function shareScreen() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const videoTrack = screenStream.getVideoTracks()[0];
    currentVideoTrack = videoTrack;

    // Replace video track in all EXISTING peer connections
    Object.values(peers).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(videoTrack);
    });

    // Show screen locally
    if (!document.getElementById(`tile-${CC_USER_ID}`)) {
      createVideoTile(CC_USER_ID, CC_USER_NAME + ' (Screen)', true);
    }
    setVideoStream(CC_USER_ID, screenStream);

    videoTrack.onended = () => {
      stopScreenShare();   // browser's built-in "Stop sharing" button
      if (CC_USER_ROLE === 'student') socket.emit('student-screen-share-ended', { session_id: CC_SESSION_ID });
    };
    setStatus('Screen sharing…');
    document.getElementById('btn-screen').textContent  = '🖥 Stop Sharing';
    document.getElementById('btn-screen').dataset.active = '1';
  } catch (e) {
    setStatus('Screen share cancelled or unavailable.');
    console.error(e);
  }
}

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  // Restore camera track if available
  if (localStream) {
    const camTrack = localStream.getVideoTracks()[0];
    currentVideoTrack = camTrack || null;
    Object.values(peers).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender && camTrack) sender.replaceTrack(camTrack);
    });
    setVideoStream(CC_USER_ID, localStream);
  } else {
    currentVideoTrack = null;
    removeVideoTile(CC_USER_ID);
  }
  setStatus('Screen share stopped.');
  document.getElementById('btn-screen').textContent   = '🖥 Share Screen';
  document.getElementById('btn-screen').dataset.active = '0';
}

function toggleMute() {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => {
    t.enabled = !t.enabled;
    document.getElementById('btn-mute').textContent = t.enabled ? '🎙 Mute' : '🔇 Unmute';
  });
}

// ── Raise hand (students) ───────────────────────────────────────────────────

let handRaised = false;

function toggleRaiseHand() {
  handRaised = !handRaised;
  socket.emit(handRaised ? 'raise-hand' : 'lower-hand', {
    session_id: CC_SESSION_ID, user_id: CC_USER_ID, user_name: CC_USER_NAME
  });
  const btn = document.getElementById('btn-raise-hand');
  if (btn) {
    btn.textContent = handRaised ? '🖐 Hand Raised' : '🖐 Raise Hand';
    btn.dataset.active = handRaised ? '1' : '0';
  }
}

// ── Spotlight & raised-hands panel (lecturer) ───────────────────────────────

function spotlightStudent(userId) {
  socket.emit('spotlight-student', { session_id: CC_SESSION_ID, user_id: userId });
}

function clearSpotlight() {
  socket.emit('spotlight-student', { session_id: CC_SESSION_ID, user_id: null });
}

function applySpotlight(userId) {
  document.querySelectorAll('.video-tile.spotlight').forEach(t => t.classList.remove('spotlight'));
  if (userId != null) {
    const tile = document.getElementById(`tile-${userId}`);
    if (tile) tile.classList.add('spotlight');
  }
}

function addRaisedHandEntry(userId, userName) {
  const panel = document.getElementById('raised-hands-panel');
  const list  = document.getElementById('raised-hands-list');
  if (!panel || !list) return;
  panel.style.display = 'block';
  if (document.getElementById(`hand-${userId}`)) return;
  const row = document.createElement('div');
  row.id = `hand-${userId}`;
  row.className = 'raised-hand-row';
  row.innerHTML = `<span>🖐 ${userName}</span>`;
  const spotlightBtn = document.createElement('button');
  spotlightBtn.className = 'btn btn-sm btn-primary';
  spotlightBtn.textContent = 'Spotlight';
  spotlightBtn.addEventListener('click', () => spotlightStudent(userId));
  row.appendChild(spotlightBtn);
  list.appendChild(row);
}

function removeRaisedHandEntry(userId) {
  const row = document.getElementById(`hand-${userId}`);
  if (row) row.remove();
  const list = document.getElementById('raised-hands-list');
  const panel = document.getElementById('raised-hands-panel');
  if (list && panel && list.children.length === 0) panel.style.display = 'none';
}

// ── Remote mute (lecturer controls a specific student's mic) ───────────────

function forceMuteStudent(userId) {
  socket.emit('force-mute', { session_id: CC_SESSION_ID, target_user_id: userId });
}

function forceUnmuteStudent(userId) {
  socket.emit('force-unmute', { session_id: CC_SESSION_ID, target_user_id: userId });
}

function applyForcedMute(muted) {
  // Runs on the STUDENT's own browser when the lecturer requests a mute/
  // unmute — the server only relays the request, the client enforces it
  // on their own mic track (same pattern Zoom/Meet/Teams use for host
  // mute controls, since a mesh WebRTC server never has direct control
  // over another peer's outgoing media).
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  const btn = document.getElementById('btn-mute');
  if (btn) btn.textContent = muted ? '🔇 Unmute' : '🎙 Mute';
  setStatus(muted ? 'Your lecturer muted your mic.' : 'Your lecturer unmuted your mic.');
}

// ── Student screen-share approval ───────────────────────────────────────────

function requestScreenShareApproval() {
  setStatus('Requesting permission to share your screen…');
  socket.emit('request-screen-share', { session_id: CC_SESSION_ID });
}

function respondToScreenShareRequest(userId, approved) {
  socket.emit('respond-screen-share', { session_id: CC_SESSION_ID, target_user_id: userId, approved });
  removeScreenShareRequestEntry(userId);
}

function addScreenShareRequestEntry(userId, userName) {
  const panel = document.getElementById('screen-requests-panel');
  const list  = document.getElementById('screen-requests-list');
  if (!panel || !list || document.getElementById(`screen-req-${userId}`)) return;
  panel.style.display = 'block';
  const row = document.createElement('div');
  row.id = `screen-req-${userId}`;
  row.className = 'raised-hand-row';
  row.innerHTML = `<span>🖥 ${userName} wants to share their screen</span>`;
  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn btn-sm btn-success';
  approveBtn.textContent = 'Approve';
  approveBtn.addEventListener('click', () => respondToScreenShareRequest(userId, true));
  const denyBtn = document.createElement('button');
  denyBtn.className = 'btn btn-sm btn-danger';
  denyBtn.textContent = 'Deny';
  denyBtn.style.marginLeft = '.4rem';
  denyBtn.addEventListener('click', () => respondToScreenShareRequest(userId, false));
  row.appendChild(approveBtn);
  row.appendChild(denyBtn);
  list.appendChild(row);
}

function removeScreenShareRequestEntry(userId) {
  const row = document.getElementById(`screen-req-${userId}`);
  if (row) row.remove();
  const list = document.getElementById('screen-requests-list');
  const panel = document.getElementById('screen-requests-panel');
  if (list && panel && list.children.length === 0) panel.style.display = 'none';
}

// ── Live chat ────────────────────────────────────────────────────────────────

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat-message', { session_id: CC_SESSION_ID, text });
  input.value = '';
}

function addEmojiToChat(emoji) {
  const input = document.getElementById('chat-input');
  if (input) { input.value += emoji; input.focus(); }
}

function renderChatMessage({ user_id, user_name, role, text, ts }) {
  const list = document.getElementById('chat-messages');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'chat-msg' + (user_id === CC_USER_ID ? ' chat-msg-own' : '');
  const roleTag = role === 'lecturer' ? ' 👨‍🏫' : '';
  row.innerHTML = `<div class="chat-msg-meta">${escapeHtml(user_name)}${roleTag} · ${ts}</div>
                    <div class="chat-msg-text"></div>`;
  row.querySelector('.chat-msg-text').textContent = text; // textContent, never innerHTML, for the message body
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Session recording (lecturer) ────────────────────────────────────────────
// IMPORTANT LIMITATION: this records only the LECTURER's own outgoing
// audio/video (camera or screen, whichever is currently active) — it does
// NOT capture students' video/audio. This app uses a mesh WebRTC
// architecture (every participant connects directly to every other one);
// there is no central media server that ever sees a combined stream of
// everyone, so a true multi-party recording isn't possible without adding
// one (e.g. an SFU). Recording the lecturer's own screen/camera is what's
// achievable client-side, and covers the common case of recording a
// lecture presentation to review later.
let mediaRecorder = null;
let recordedChunks = [];

function startRecording() {
  if (!currentVideoTrack) {
    setStatus('Turn on your camera or screen share before recording.');
    return;
  }
  const audioTrack = localStream ? localStream.getAudioTracks()[0] : null;
  const tracks = audioTrack ? [currentVideoTrack, audioTrack] : [currentVideoTrack];
  const recordStream = new MediaStream(tracks);

  recordedChunks = [];
  try {
    mediaRecorder = new MediaRecorder(recordStream, { mimeType: 'video/webm' });
  } catch (e) {
    setStatus('Recording is not supported in this browser.');
    return;
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = uploadRecording;
  mediaRecorder.start();

  const btn = document.getElementById('btn-record');
  if (btn) { btn.textContent = '⏺ Stop Recording'; btn.dataset.active = '1'; }
  setStatus('Recording started — this captures your own camera/screen only.');
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  const btn = document.getElementById('btn-record');
  if (btn) { btn.textContent = '⏺ Record Session'; btn.dataset.active = '0'; }
}

async function uploadRecording() {
  if (!recordedChunks.length) return;
  setStatus('Uploading recording as a course material…');
  const blob = new Blob(recordedChunks, { type: 'video/webm' });
  recordedChunks = [];

  const defaultTitle = `Recording — ${document.title.replace(' – ClassConnect', '')} — ${new Date().toLocaleDateString()}`;
  const title = prompt('Title for this recording (saved as a course material):', defaultTitle) || defaultTitle;

  const form = new FormData();
  form.append('title', title);
  form.append('file', blob, `recording_${Date.now()}.webm`);

  try {
    const res = await fetch(`/courses/${CC_COURSE_ID}/materials/upload`, { method: 'POST', body: form });
    setStatus(res.ok ? 'Recording saved to course materials.' : 'Could not save the recording — try again.');
  } catch (e) {
    setStatus('Could not upload the recording — check your connection.');
  }
}

function addLocalTracksToPeers() {
  if (!localStream) return;
  Object.values(peers).forEach(pc => {
    // Audio always comes from the mic (localStream)
    localStream.getAudioTracks().forEach(track => {
      const alreadyAdded = pc.getSenders().find(s => s.track === track);
      if (!alreadyAdded) pc.addTrack(track, localStream);
    });
    // Video: use whatever is CURRENTLY live (camera or screen), not always
    // localStream's original camera track — otherwise a peer this function
    // runs for after screen-sharing has started would get the stale camera
    // feed instead of the actual screen content.
    if (currentVideoTrack) {
      const alreadyAdded = pc.getSenders().find(s => s.track === currentVideoTrack);
      if (!alreadyAdded) pc.addTrack(currentVideoTrack, localStream);
    }
  });
}

// ── RTCPeerConnection factory ─────────────────────────────────────────────────

function createPeerConnection(remoteUserId, remoteName) {
  if (peers[remoteUserId]) return peers[remoteUserId];

  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers[remoteUserId]    = pc;
  peerNames[remoteUserId] = remoteName;

  // Add local tracks if we have them — audio from the mic, video from
  // whatever is CURRENTLY live (camera or screen). This matters when a
  // remote peer joins/connects after screen-sharing has already started:
  // without this, they'd get the original camera track instead of the
  // live screen content.
  if (localStream) {
    localStream.getAudioTracks().forEach(t => pc.addTrack(t, localStream));
  }
  if (currentVideoTrack) {
    pc.addTrack(currentVideoTrack, localStream || new MediaStream([currentVideoTrack]));
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('ice-candidate', {
        session_id : CC_SESSION_ID,
        to         : remoteUserId,
        from       : CC_USER_ID,
        candidate  : candidate.toJSON()
      });
    }
  };

  pc.ontrack = ({ streams }) => {
    if (!document.getElementById(`tile-${remoteUserId}`)) {
      createVideoTile(remoteUserId, remoteName || `User ${remoteUserId}`);
    }
    setVideoStream(remoteUserId, streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      removeVideoTile(remoteUserId);
      delete peers[remoteUserId];
    }
  };

  return pc;
}

// ── Signalling ────────────────────────────────────────────────────────────────

function initSocket() {
  socket = io();

  socket.on('connect', () => {
    socket.emit('join-video-room', {
      session_id : CC_SESSION_ID,
      user_id    : CC_USER_ID,
      user_name  : CC_USER_NAME
    });
    setStatus('Connected. Use the buttons below to enable camera or share screen.');
  });

  // A new peer joined → we initiate the offer
  socket.on('peer-joined', async ({ user_id, user_name }) => {
    if (user_id === CC_USER_ID) return;
    setStatus(`${user_name} joined.`);
    const pc    = createPeerConnection(user_id, user_name);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', {
      session_id : CC_SESSION_ID,
      to         : user_id,
      from       : CC_USER_ID,
      from_name  : CC_USER_NAME,
      sdp        : pc.localDescription.toJSON()
    });
  });

  // Incoming offer → create peer connection and send answer
  socket.on('offer', async ({ from, from_name, sdp }) => {
    if (from === CC_USER_ID) return;
    const pc = createPeerConnection(from, from_name);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', {
      session_id : CC_SESSION_ID,
      to         : from,
      from       : CC_USER_ID,
      sdp        : pc.localDescription.toJSON()
    });
  });

  // Incoming answer
  socket.on('answer', async ({ from, sdp }) => {
    if (from === CC_USER_ID) return;
    const pc = peers[from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  });

  // Incoming ICE candidate
  socket.on('ice-candidate', async ({ from, candidate }) => {
    if (from === CC_USER_ID) return;
    const pc = peers[from];
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (e) { console.warn('ICE candidate error', e); }
    }
  });

  // A peer left
  socket.on('peer-left', ({ user_id }) => {
    removeVideoTile(user_id);
    if (peers[user_id]) {
      peers[user_id].close();
      delete peers[user_id];
    }
    setStatus(`${peerNames[user_id] || 'A participant'} left the video.`);
  });

  socket.on('disconnect', () => setStatus('Disconnected from video server.'));

  // ── Live-session interaction events ──────────────────────────────────────
  socket.on('hand-raised', ({ user_id, user_name }) => addRaisedHandEntry(user_id, user_name));
  socket.on('hand-lowered', ({ user_id }) => removeRaisedHandEntry(user_id));
  socket.on('spotlight-changed', ({ user_id }) => applySpotlight(user_id));
  socket.on('force-mute', ({ user_id }) => { if (user_id === CC_USER_ID) applyForcedMute(true); });
  socket.on('force-unmute', ({ user_id }) => { if (user_id === CC_USER_ID) applyForcedMute(false); });

  socket.on('chat-message', renderChatMessage);

  socket.on('screen-share-requested', ({ user_id, user_name }) => {
    if (CC_USER_ROLE === 'lecturer') addScreenShareRequestEntry(user_id, user_name);
  });
  socket.on('screen-share-response', ({ approved, user_id }) => {
    if (user_id !== CC_USER_ID) return;
    if (approved) {
      setStatus('Screen share approved — starting…');
      shareScreen();
    } else {
      setStatus('Your lecturer denied the screen share request.');
    }
  });
  socket.on('screen-share-revoked', ({ user_id }) => {
    if (user_id === CC_USER_ID && screenStream) {
      stopScreenShare();
      setStatus('Your lecturer ended your screen share.');
    }
  });
}

// ── Button wiring (called after DOM ready) ────────────────────────────────────

function wireButtons() {
  const btnCamera = document.getElementById('btn-camera');
  const btnScreen = document.getElementById('btn-screen');
  const btnMute   = document.getElementById('btn-mute');

  if (btnCamera) btnCamera.addEventListener('click', () => {
    btnCamera.dataset.active === '1' ? stopCamera() : startCamera();
  });

  if (btnScreen) btnScreen.addEventListener('click', () => {
    if (btnScreen.dataset.active === '1') {
      stopScreenShare();
      if (CC_USER_ROLE === 'student') socket.emit('student-screen-share-ended', { session_id: CC_SESSION_ID });
      return;
    }
    if (CC_USER_ROLE === 'student') {
      requestScreenShareApproval();
    } else {
      shareScreen();
    }
  });

  if (btnMute) btnMute.addEventListener('click', toggleMute);

  const btnHand = document.getElementById('btn-raise-hand');
  if (btnHand) btnHand.addEventListener('click', toggleRaiseHand);

  const btnRecord = document.getElementById('btn-record');
  if (btnRecord) btnRecord.addEventListener('click', () => {
    btnRecord.dataset.active === '1' ? stopRecording() : startRecording();
  });

  const chatSendBtn = document.getElementById('chat-send-btn');
  if (chatSendBtn) chatSendBtn.addEventListener('click', sendChatMessage);
  const chatInput = document.getElementById('chat-input');
  if (chatInput) chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); }
  });
  document.querySelectorAll('.emoji-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => addEmojiToChat(btn.textContent));
  });

  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    socket?.emit('leave-video-room', { session_id: CC_SESSION_ID, user_id: CC_USER_ID });
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    stopCamera();
    stopScreenShare();
    Object.values(peers).forEach(pc => pc.close());
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // Buttons and signalling must work immediately regardless of network
  // speed — TURN credentials aren't needed until an actual peer connection
  // is created (later, when someone joins), so loading them must never
  // block basic page interactivity like the Camera button.
  initSocket();
  wireButtons();
  loadIceServers(); // fires in the background, has its own 6s timeout
});
