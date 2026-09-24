/* Table – seeing and hearing the other player during a 1v1.

   The video and audio go straight from one browser to the other over WebRTC. Nothing passes through
   Supabase: the match channel that already carries paddle positions is reused to introduce the two
   browsers to each other, and after that the media is a direct connection between them.

   Both off until you press the button. Nothing is captured, and no permission is asked for, until
   then — turning the camera on is always a deliberate act, never something a match does to you.

   Public STUN is enough for most home connections. Roughly one pair in six sits behind a network
   that needs a paid TURN relay; for those the video simply never connects and the match carries on.
   Add a relay in js/config.js as ICE_EXTRA and it will be used without any other change.

   Two browsers can decide to renegotiate at the same instant, which leaves the connection stuck
   unless somebody yields. This uses the standard "perfect negotiation" arrangement: the guest is
   polite and backs down, the host is not and carries on. */
const Vid = (function () {
  const SIZE = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 20 } };
  const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

  let pc = null, audioTx = null, videoTx = null;
  let localStream = null, remoteStream = null;
  let camOn = false, micOn = false, polite = false, running = false;
  // What the other player says they are sending. replaceTrack(null) stops the frames but leaves the
  // receiving track alive, so without being told we would keep showing a picture that had frozen.
  let theirCam = false, theirMic = false;
  let makingOffer = false, ignoreOffer = false, state = 'idle', restarted = false;
  // Candidates routinely arrive before the description they belong to, because they travel as separate
  // messages. Adding one early throws and the candidate is gone. On one machine that goes unnoticed,
  // since the local-network candidates alone are enough; between two houses the discarded ones are the
  // STUN candidates that were the only way through, and the call simply never connects.
  let waiting = [];
  const subs = [];
  const fire = () => subs.forEach(f => { try { f(read()); } catch (e) { Err.log(e, 'video state'); } });

  // getUserMedia only exists where the page is secure. Over plain http on a phone it is simply absent,
  // which is why this has to be checked rather than assumed.
  const available = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection);

  const read = () => ({
    available: available(), running: running,
    camera: camOn, mic: micOn, state: state,
    hasRemote: !!(remoteStream && remoteStream.getTracks().length),
    remoteVideo: theirCam && flowing('video'),
    remoteAudio: theirMic && flowing('audio')
  });
  // A track that is live but muted is one the far end has stopped feeding, which is the backstop for
  // a browser that never told us.
  const flowing = kind => !!(remoteStream && remoteStream.getTracks()
    .some(t => t.kind === kind && t.readyState === 'live' && !t.muted));
  const iceServers = () => STUN.concat((window.TABLE_CONFIG && window.TABLE_CONFIG.ICE_EXTRA) || []);

  function build() {
    if (pc) return pc;
    remoteStream = new MediaStream();
    pc = new RTCPeerConnection({ iceServers: iceServers() });
    // Both directions are set up now, empty. Turning a camera on later then only swaps a track in,
    // rather than rebuilding the connection each time somebody changes their mind.
    waiting = [];
    restarted = false;
    audioTx = pc.addTransceiver('audio', { direction: 'recvonly' });
    videoTx = pc.addTransceiver('video', { direction: 'recvonly' });

    pc.ontrack = ({ track }) => {
      remoteStream.addTrack(track);
      track.addEventListener('ended', fire);
      track.addEventListener('mute', fire);
      track.addEventListener('unmute', fire);
      fire();
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) Net.sendRtc({ candidate: candidate.toJSON() }); };
    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        Net.sendRtc({ desc: pc.localDescription });
      } catch (e) { Err.log(e, 'offer video'); }
      finally { makingOffer = false; }
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      state = s === 'connected' || s === 'completed' ? 'connected'
        : s === 'failed' ? 'failed'
        : s === 'disconnected' ? 'dropped' : 'connecting';
      if (s === 'failed' && !restarted) {
        // Worth one automatic retry: re-gathering often succeeds where the first attempt did not.
        // Only the impolite side restarts, so the two do not fight over it.
        restarted = true;
        if (!polite) { try { pc.restartIce(); } catch (e) { Err.log(e, 'restart video'); } }
      } else if (s === 'failed') {
        Err.log(new Error('Direct video connection failed — this network probably needs a TURN relay.'), 'video');
      }
      fire();
    };
    return pc;
  }

  async function onSignal(d) {
    if (!d || !running) return;
    if (d.have) { theirCam = !!d.have.cam; theirMic = !!d.have.mic; fire(); return; }
    build();
    try {
      if (d.desc) {
        const collision = d.desc.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
        ignoreOffer = !polite && collision;
        if (ignoreOffer) return;               // we are the impolite one; our own offer stands
        await pc.setRemoteDescription(d.desc);
        await drain();                           // whatever arrived early can go in now
        if (d.desc.type === 'offer') {
          await pc.setLocalDescription();
          Net.sendRtc({ desc: pc.localDescription });
        }
      } else if (d.candidate) {
        if (!pc.remoteDescription || !pc.remoteDescription.type) { waiting.push(d.candidate); return; }
        await add(d.candidate);
      }
    } catch (e) { Err.log(e, 'video signalling'); }
  }

  async function add(c) {
    // One unusable candidate must never stop the rest: there are always several, and only one has to work.
    try { await pc.addIceCandidate(c); }
    catch (e) { if (!ignoreOffer) Err.log(e, 'add a network route'); }
  }
  async function drain() {
    const q = waiting; waiting = [];
    for (const c of q) await add(c);
  }

  async function capture(kind) {
    const want = kind === 'video' ? { video: SIZE } : {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    };
    const s = await navigator.mediaDevices.getUserMedia(want);
    const track = s.getTracks()[0];
    // A device another application is already holding can hand back a track that is dead on arrival.
    if (!track || track.readyState === 'ended') {
      throw new Error(kind === 'video'
        ? 'The camera closed straight away. Check nothing else is using it.'
        : 'The microphone closed straight away. Check nothing else is using it.');
    }
    if (!localStream) localStream = new MediaStream();
    localStream.addTrack(track);
    track.addEventListener('ended', () => {        // the browser or the operating system pulled it
      if (kind === 'video') setCamera(false); else setMic(false);
    });
    return track;
  }
  function drop(kind) {
    if (!localStream) return;
    localStream.getTracks()
      .filter(t => t.kind === kind)
      .forEach(t => { t.stop(); localStream.removeTrack(t); });
  }

  async function toggle(kind, on) {
    if (!running || !available()) return;
    const tx = kind === 'video' ? videoTx : audioTx;
    build();
    try {
      if (on) {
        const track = await capture(kind);
        await tx.sender.replaceTrack(track);
        tx.direction = 'sendrecv';
      } else {
        await tx.sender.replaceTrack(null);
        tx.direction = 'recvonly';
        drop(kind);
      }
      if (kind === 'video') camOn = on; else micOn = on;
      Net.sendRtc({ have: { cam: camOn, mic: micOn } });   // tell them at once, rather than waiting to time out
      fire();
    } catch (e) {
      if (kind === 'video') camOn = false; else micOn = false;
      fire();
      throw e;                                   // the caller turns this into a sentence on screen
    }
  }
  const setCamera = on => toggle('video', on);
  const setMic = on => toggle('audio', on);

  // Called when a 1v1 begins. Nothing is captured here; it only decides who yields on a collision.
  function start(role) {
    if (!available()) return;
    polite = role !== 'host';                    // the guest backs down, the host presses on
    running = true; state = 'idle';
    theirCam = theirMic = false;
    build();
    fire();
  }
  function stop() {
    running = false; camOn = false; micOn = false; state = 'idle';
    theirCam = theirMic = false;
    drop('video'); drop('audio');
    localStream = null;
    waiting = [];
    if (pc) { try { pc.close(); } catch (e) { /* already closed */ } }
    pc = audioTx = videoTx = null;
    remoteStream = null;
    fire();
  }

  return {
    available, start, stop, setCamera, setMic, onSignal,
    get state() { return read(); },
    get localStream() { return localStream; },
    get remoteStream() { return remoteStream; },
    onChange(f) { subs.push(f); }
  };
})();
