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

  // Shown instead of the video element when this person's camera is off
  // but they're still audible — makes clear they're present and can be
  // heard, rather than looking like a frozen black square or having them
  // disappear from the call entirely.
  const placeholder = document.createElement('div');
  placeholder.className = 'video-audio-only-placeholder';
  placeholder.id = `placeholder-${userId}`;
  const initials = (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  placeholder.innerHTML = `<div class="avatar-circle">${initials}</div><div class="audio-only-label">🎙 Audio only</div>`;

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
  tile.appendChild(placeholder);
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

function showAudioOnlyPlaceholder(userId, name) {
  if (!document.getElementById(`tile-${userId}`)) createVideoTile(userId, name, userId === CC_USER_ID);
  const tile = document.getElementById(`tile-${userId}`);
  if (tile) tile.classList.add('camera-off');
}

function hideAudioOnlyPlaceholder(userId) {
  const tile = document.getElementById(`tile-${userId}`);
  if (tile) tile.classList.remove('camera-off');
}

// ── Local media ───────────────────────────────────────────────────────────────

async function startCamera() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    currentVideoTrack = localStream.getVideoTracks()[0] || null;
    createVideoTile(CC_USER_ID, CC_USER_NAME + ' (You)', true);
    setVideoStream(CC_USER_ID, localStream);
    addLocalTracksToPeers();
    socket.emit('camera-state-changed', { session_id: CC_SESSION_ID, user_id: CC_USER_ID, camera_on: true });
    setStatus('Camera on.');
    document.getElementById('btn-camera').textContent = '📷 Stop Camera';
    document.getElementById('btn-camera').dataset.active = '1';
  } catch (e) {
    setStatus('Could not access camera/mic. Check browser permissions.');
    console.error(e);
  }
}

function stopCamera() {
  // IMPORTANT: this only stops the VIDEO. The mic keeps working — someone
  // with their camera off but mic unmuted should still be heard, the same
  // way Zoom/Meet/Teams behave. Previously this stopped every track
  // (audio included), which silently killed a student's mic the moment
  // they turned their camera off.
  if (localStream) {
    const videoTracks = localStream.getVideoTracks();
    videoTracks.forEach(t => { t.stop(); localStream.removeTrack(t); });
  }
  currentVideoTrack = null;

  // Stop sending video to peers specifically — leave every audio sender
  // completely alone.
  Object.values(peers).forEach(pc => {
    pc.getSenders().forEach(sender => {
      if (sender.track && sender.track.kind === 'video') {
        sender.track.stop();
        sender.replaceTrack(null);
      }
    });
  });

  // Keep the local tile if the mic is still active (audio-only), otherwise
  // remove it entirely (nothing left to show or send).
  if (localStream && localStream.getAudioTracks().length) {
    showAudioOnlyPlaceholder(CC_USER_ID, CC_USER_NAME + ' (You)');
  } else {
    removeVideoTile(CC_USER_ID);
  }
  socket.emit('camera-state-changed', { session_id: CC_SESSION_ID, user_id: CC_USER_ID, camera_on: false });
  setStatus('Camera off — your mic is still active if unmuted.');
  document.getElementById('btn-camera').textContent = '📷 Start Camera';
  document.getElementById('btn-camera').dataset.active = '0';
}

async function shareScreen() {
  // Chrome/Firefox on Android (and most mobile browsers) expose this API
  // but don't actually implement it — calling it always rejects. This is
  // a genuine platform limitation, not something fixable from this app;
  // catch it upfront with a clear message rather than a vague failure
  // after the fact.
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (isMobile) {
    setStatus('Screen sharing isn\'t supported by mobile browsers — try from a laptop or desktop instead.');
    return;
  }
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
let presenceHeartbeatTimer = null;

function startPresenceHeartbeat() {
  // Every 10s while connected, tell the server "still here". The roster
  // on the lecturer's side is built from this, not a one-time flag — so
  // someone who actually left (however that happened) simply stops
  // appearing within ~25s, without depending on catching an exact
  // disconnect moment.
  clearInterval(presenceHeartbeatTimer);
  presenceHeartbeatTimer = setInterval(() => {
    if (socket && socket.connected) {
      socket.emit('presence-heartbeat', { session_id: CC_SESSION_ID });
    }
  }, 10000);
}

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
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (isMobile) {
    setStatus('Screen sharing isn\'t supported by mobile browsers — try from a laptop or desktop instead.');
    return;
  }
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

function loadChatHistory() {
  // Replays everything sent so far in this session — this is what makes
  // refreshing the page, or leaving and re-entering an active session,
  // no longer lose the conversation.
  (CC_CHAT_HISTORY || []).forEach(renderChatMessage);
}

function renderChatMessage({ id, user_id, user_name, role, text, ts, edited }) {
  const list = document.getElementById('chat-messages');
  if (!list) return;
  const isOwn = user_id === CC_USER_ID;
  const row = document.createElement('div');
  row.className = 'chat-msg' + (isOwn ? ' chat-msg-own' : '');
  if (id != null) row.id = `chat-msg-${id}`;
  const roleTag = role === 'lecturer' ? ' 👨‍🏫' : '';

  const meta = document.createElement('div');
  meta.className = 'chat-msg-meta';
  meta.textContent = `${user_name}${roleTag} · ${ts}`;
  if (isOwn && id != null) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'chat-edit-btn';
    editBtn.textContent = '✏️ Edit';
    editBtn.addEventListener('click', () => startEditingMessage(id));
    meta.appendChild(editBtn);
  }

  const body = document.createElement('div');
  body.className = 'chat-msg-text';
  body.textContent = text; // textContent, never innerHTML, for the message body

  const editedTag = document.createElement('span');
  editedTag.className = 'chat-edited-tag';
  editedTag.textContent = edited ? ' (edited)' : '';
  editedTag.style.display = edited ? 'inline' : 'none';

  row.appendChild(meta);
  row.appendChild(body);
  body.appendChild(editedTag);
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

function startEditingMessage(messageId) {
  const row = document.getElementById(`chat-msg-${messageId}`);
  if (!row) return;
  const bodyEl = row.querySelector('.chat-msg-text');
  if (!bodyEl || row.querySelector('.chat-edit-input')) return; // already editing

  const currentText = bodyEl.firstChild ? bodyEl.firstChild.textContent : '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'form-input chat-edit-input';
  input.value = currentText;
  input.maxLength = 1000;
  bodyEl.style.display = 'none';
  row.insertBefore(input, bodyEl);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  const finish = (save) => {
    if (save) {
      const newText = input.value.trim();
      if (newText && newText !== currentText) {
        socket.emit('edit-chat-message', { message_id: messageId, text: newText });
      }
    }
    input.remove();
    bodyEl.style.display = '';
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function applyEditedMessage(messageId, newText) {
  const row = document.getElementById(`chat-msg-${messageId}`);
  if (!row) return;
  const bodyEl = row.querySelector('.chat-msg-text');
  if (!bodyEl) return;
  const editedTag = bodyEl.querySelector('.chat-edited-tag');
  bodyEl.textContent = newText;
  if (editedTag) { bodyEl.appendChild(editedTag); editedTag.style.display = 'inline'; }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Browse together ──────────────────────────────────────────────────────────
// Synced navigation, not screen capture — works on any device including
// phones, unlike screen sharing. See the server-side comment in app.py
// for the unavoidable "some sites block iframe embedding" caveat; the
// "Open in new tab" link is the guaranteed-to-work fallback for those.

function startBrowseTogether() {
  const input = document.getElementById('browse-url-input');
  if (!input) return;
  const url = input.value.trim();
  if (!url) return;
  socket.emit('browse-navigate', { session_id: CC_SESSION_ID, url });
}

function closeBrowseTogether() {
  socket.emit('browse-close', { session_id: CC_SESSION_ID });
}

function showSharedBrowseUrl(url) {
  const viewer = document.getElementById('browse-viewer');
  const frame  = document.getElementById('browse-frame');
  const link   = document.getElementById('browse-open-tab');
  if (!viewer || !frame) return;
  frame.src = url;
  if (link) link.href = url;
  viewer.style.display = 'block';

  const btn = document.getElementById('btn-browse');
  if (btn) { btn.textContent = '🌐 Change Page'; btn.dataset.active = '1'; }
  const urlInput = document.getElementById('browse-url-input');
  if (urlInput) urlInput.value = url;
}

function hideSharedBrowseUrl() {
  const viewer = document.getElementById('browse-viewer');
  const frame  = document.getElementById('browse-frame');
  if (viewer) viewer.style.display = 'none';
  if (frame) frame.src = 'about:blank';
  const btn = document.getElementById('btn-browse');
  if (btn) { btn.textContent = '🌐 Browse Together'; btn.dataset.active = '0'; }
}

function loadPersistedBrowseUrl() {
  // Restores the shared page on refresh or when re-entering an active
  // session — same persistence pattern as chat history.
  if (CC_CURRENT_BROWSE_URL) showSharedBrowseUrl(CC_CURRENT_BROWSE_URL);
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

  // "Perfect negotiation" pattern (see MDN): both sides can independently
  // decide to renegotiate (e.g. both turn cameras on around the same
  // moment), which can produce two colliding offers. Deterministically
  // picking one side as "polite" (backs off and accepts the incoming
  // offer) and the other as "impolite" (keeps its own offer, ignores the
  // incoming one) resolves the collision the same way on both ends
  // without any extra coordination.
  const polite = CC_USER_ID < remoteUserId;
  let makingOffer = false;
  let ignoreOffer = false;

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

  // CRITICAL: without this, tracks added AFTER the initial offer/answer
  // (e.g. the lecturer starts their camera only after a student has
  // already joined and connected) get added to the sender locally but
  // never actually reach the remote peer — the browser fires
  // 'negotiationneeded' precisely to request a fresh offer/answer round
  // for exactly this situation, but nothing was listening for it before.
  // This was the main cause of "sometimes I can't see/hear the student
  // and they can't see/hear me."
  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      socket.emit('offer', {
        session_id : CC_SESSION_ID,
        to         : remoteUserId,
        from       : CC_USER_ID,
        from_name  : CC_USER_NAME,
        sdp        : pc.localDescription.toJSON()
      });
    } catch (e) {
      console.warn('Renegotiation failed', e);
    } finally {
      makingOffer = false;
    }
  };

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

  // ICE connection health: 'disconnected' is often a brief, self-recovering
  // blip (a few dropped packets, a network handover) — tearing everything
  // down immediately on that state (as this used to do) is what made the
  // connection feel so fragile. Now: give it a few seconds to recover on
  // its own, then try an ICE restart before giving up entirely.
  let recoveryTimer = null;
  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    if (state === 'disconnected') {
      setStatus(`Connection to ${remoteName || 'a participant'} is unstable, trying to recover…`);
      clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
          try { pc.restartIce(); } catch (e) { console.warn('restartIce failed', e); }
        }
      }, 3000);
    } else if (state === 'failed') {
      try { pc.restartIce(); } catch (e) { console.warn('restartIce failed', e); }
    } else if (state === 'connected' || state === 'completed') {
      clearTimeout(recoveryTimer);
    } else if (state === 'closed') {
      clearTimeout(recoveryTimer);
      removeVideoTile(remoteUserId);
      delete peers[remoteUserId];
    }
  };

  pc._polite = polite;
  pc._isMakingOffer = () => makingOffer;
  pc._setIgnoreOffer = (v) => { ignoreOffer = v; };
  pc._shouldIgnoreOffer = () => ignoreOffer;

  return pc;
}

// ── Signalling ────────────────────────────────────────────────────────────────

function initSocket() {
  socket = io();
  let hasConnectedBefore = false;

  socket.on('connect', () => {
    if (hasConnectedBefore) {
      // This is a RECONNECT (network blip, phone woke back up, etc.), not
      // the first connection. Any peer connections from before are now
      // almost certainly stale/broken — tear them down so the fresh
      // 'peer-joined' events every other participant's server-side
      // handler will emit (once they see us rejoin) rebuild clean ones,
      // instead of us hanging onto dead connections that will never
      // recover on their own.
      Object.values(peers).forEach(pc => pc.close());
      Object.keys(peers).forEach(id => delete peers[id]);
      document.querySelectorAll('.video-tile').forEach(t => {
        if (t.id !== `tile-${CC_USER_ID}`) t.remove();
      });
      setStatus('Reconnected — restoring video…');
    } else {
      setStatus('Connected. Use the buttons below to enable camera or share screen.');
    }
    hasConnectedBefore = true;
    socket.emit('join-video-room', {
      session_id : CC_SESSION_ID,
      user_id    : CC_USER_ID,
      user_name  : CC_USER_NAME
    });
    startPresenceHeartbeat();
  });

  // A new peer joined → just create the connection; onnegotiationneeded
  // (added in createPeerConnection) automatically sends an offer once
  // there are tracks to negotiate. This also means a LATER camera start
  // triggers the same path, so it no longer matters whether someone turns
  // their camera on before or after another participant joins.
  socket.on('peer-joined', ({ user_id, user_name }) => {
    if (user_id === CC_USER_ID) return;
    setStatus(`${user_name} joined.`);
    createPeerConnection(user_id, user_name);
    // Let the newcomer know our current camera state right away — they'd
    // otherwise only find out the next time we happen to toggle it.
    const camBtn = document.getElementById('btn-camera');
    socket.emit('camera-state-changed', {
      session_id: CC_SESSION_ID, user_id: CC_USER_ID, camera_on: camBtn ? camBtn.dataset.active === '1' : false
    });
  });

  // Incoming offer → create peer connection and send answer. Implements
  // the "perfect negotiation" collision rule: if both sides happen to
  // send an offer at nearly the same time, the polite side backs off and
  // accepts the other's offer instead of both getting stuck.
  socket.on('offer', async ({ from, from_name, sdp }) => {
    if (from === CC_USER_ID) return;
    const pc = createPeerConnection(from, from_name);
    const offerCollision = (pc._isMakingOffer() || pc.signalingState !== 'stable');
    pc._setIgnoreOffer(!pc._polite && offerCollision);
    if (pc._shouldIgnoreOffer()) return;   // impolite: our own offer will win, ignore theirs

    try {
      if (offerCollision) {
        // polite peer: roll back our own pending offer to accept theirs
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }),
          pc.setRemoteDescription(new RTCSessionDescription(sdp)),
        ]);
      } else {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', {
        session_id : CC_SESSION_ID,
        to         : from,
        from       : CC_USER_ID,
        sdp        : pc.localDescription.toJSON()
      });
    } catch (e) {
      console.warn('Failed to handle incoming offer', e);
    }
  });

  // Incoming answer
  socket.on('answer', async ({ from, sdp }) => {
    if (from === CC_USER_ID) return;
    const pc = peers[from];
    if (!pc) return;
    try { await pc.setRemoteDescription(new RTCSessionDescription(sdp)); }
    catch (e) { console.warn('Failed to apply answer', e); }
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
  socket.on('camera-state-changed', ({ user_id, camera_on }) => {
    if (user_id === CC_USER_ID) return;
    if (camera_on) hideAudioOnlyPlaceholder(user_id);
    else showAudioOnlyPlaceholder(user_id, peerNames[user_id] || 'Participant');
  });
  socket.on('force-unmute', ({ user_id }) => { if (user_id === CC_USER_ID) applyForcedMute(false); });

  socket.on('chat-message', renderChatMessage);
  socket.on('chat-message-edited', ({ id, text }) => applyEditedMessage(id, text));
  socket.on('browse-navigate', ({ url }) => showSharedBrowseUrl(url));
  socket.on('browse-closed', () => hideSharedBrowseUrl());

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

  const btnBrowse = document.getElementById('btn-browse');
  const browsePanel = document.getElementById('browse-panel');
  if (btnBrowse && browsePanel) {
    btnBrowse.addEventListener('click', () => {
      browsePanel.style.display = browsePanel.style.display === 'none' ? 'block' : 'none';
    });
  }
  const browseGoBtn = document.getElementById('browse-go-btn');
  if (browseGoBtn) browseGoBtn.addEventListener('click', startBrowseTogether);
  const browseUrlInput = document.getElementById('browse-url-input');
  if (browseUrlInput) browseUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); startBrowseTogether(); }
  });
  const browseCloseBtn = document.getElementById('browse-close-btn');
  if (browseCloseBtn) browseCloseBtn.addEventListener('click', closeBrowseTogether);

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
    clearInterval(presenceHeartbeatTimer);
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
  loadChatHistory();
  loadPersistedBrowseUrl();
  loadIceServers(); // fires in the background, has its own 6s timeout
});
