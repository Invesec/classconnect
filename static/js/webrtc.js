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
let localStream   = null;   // camera / mic stream
let screenStream  = null;   // screen share stream
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

  tile.appendChild(video);
  tile.appendChild(label);
  getVideoGrid().appendChild(tile);
  return video;
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

    // Replace video track in all peer connections
    Object.values(peers).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(videoTrack);
    });

    // Show screen locally
    if (!document.getElementById(`tile-${CC_USER_ID}`)) {
      createVideoTile(CC_USER_ID, CC_USER_NAME + ' (Screen)', true);
    }
    setVideoStream(CC_USER_ID, screenStream);

    videoTrack.onended = stopScreenShare;   // browser's built-in "Stop sharing" button
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
    Object.values(peers).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender && camTrack) sender.replaceTrack(camTrack);
    });
    setVideoStream(CC_USER_ID, localStream);
  } else {
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

function addLocalTracksToPeers() {
  if (!localStream) return;
  Object.values(peers).forEach(pc => {
    localStream.getTracks().forEach(track => {
      // Avoid adding duplicate senders
      const alreadyAdded = pc.getSenders().find(s => s.track === track);
      if (!alreadyAdded) pc.addTrack(track, localStream);
    });
  });
}

// ── RTCPeerConnection factory ─────────────────────────────────────────────────

function createPeerConnection(remoteUserId, remoteName) {
  if (peers[remoteUserId]) return peers[remoteUserId];

  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers[remoteUserId]    = pc;
  peerNames[remoteUserId] = remoteName;

  // Add local tracks if we have them
  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
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
    btnScreen.dataset.active === '1' ? stopScreenShare() : shareScreen();
  });

  if (btnMute) btnMute.addEventListener('click', toggleMute);

  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    socket?.emit('leave-video-room', { session_id: CC_SESSION_ID, user_id: CC_USER_ID });
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
