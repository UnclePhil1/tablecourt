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

  let pc = null;
  let localStream = null, remoteStream = null;
  let camOn = false, micOn = false, polite = false, running = false;
  // What the other player says they are sending. replaceTrack(null) stops the frames but leaves the
  // receiving track alive, so without being told we would keep showing a picture that had frozen.
  let theirCam = false, theirMic = false;
  let makingOffer = false, ignoreOffer = false, state = 'idle', restarted = false;
  let lastError = null, sentCount = 0, recvCount = 0, added = 0, gathered = 0;   // for report()
  // Candidates routinely arrive before the description they belong to, because they travel as separate
  // messages. Adding one early throws and the candidate is gone. On one machine that goes unnoticed,
  // since the local-network candidates alone are enough; between two houses the discarded ones are the
  // STUN candidates that were the only way through, and the call simply never connects.
  let waiting = [];
  // The other player can enter the arena first and start talking before we are listening. Dropping
  // what they said leaves both sides waiting for the other to speak, so it is kept and replayed.
  let early = [];
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
    waiting = []; restarted = false; added = 0; gathered = 0;
    // Only the leading side lays out the media lines. When both did it, two simultaneous offers
    // interleaved the two sets and a camera could end up streaming into a slot the other end had
    // negotiated as inactive: one direction worked, the other was silently dead.
    if (!polite) {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
    }

    pc.ontrack = ({ track }) => {
      remoteStream.addTrack(track);
      track.addEventListener('ended', fire);
      track.addEventListener('mute', fire);
      track.addEventListener('unmute', fire);
      fire();
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) { gathered++; sentCount++; Net.sendRtc({ candidate: candidate.toJSON() }); } };
    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        sentCount++;
        Net.sendRtc({ desc: pc.localDescription });
      } catch (e) { lastError = e; Err.log(e, 'offer video'); }
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
    if (!d) return;
    if (!running) { if (early.length < 40) early.push(d); return; }
    recvCount++;
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
    } catch (e) { lastError = e; Err.log(e, 'video signalling'); }
  }

  async function add(c) {
    // One unusable candidate must never stop the rest: there are always several, and only one has to work.
    try { await pc.addIceCandidate(c); added++; }
    catch (e) { if (!ignoreOffer) { lastError = e; Err.log(e, 'add a network route'); } }
  }

  // Everything needed to work out why a call is not connecting, without opening developer tools.
  function report() {
    const tracks = st => st ? st.getTracks().map(t => t.kind + ':' + t.readyState + (t.muted ? ':muted' : '')) : [];
    return {
      pageIsSecure: window.isSecureContext,
      browserCanCapture: available(),
      inAMatch: running,
      youAre: polite ? 'guest (yields)' : 'host (leads)',
      yourCamera: camOn, yourMic: micOn,
      theySayTheyAreSending: { camera: theirCam, mic: theirMic },
      connection: state,
      iceState: pc ? pc.iceConnectionState : 'no connection',
      iceGathering: pc ? pc.iceGatheringState : 'no connection',
      signalingState: pc ? pc.signalingState : 'no connection',
      haveLocalDescription: !!(pc && pc.localDescription),
      haveRemoteDescription: !!(pc && pc.remoteDescription),
      routesFound: gathered, routesFromThem: added,
      mediaLines: pc ? pc.getTransceivers().map(t => t.receiver.track.kind + ' ' + t.direction + '/' + (t.currentDirection || '-')) : [],
      yourTracks: tracks(localStream),
      tracksFromThem: tracks(remoteStream),
      candidatesHeldBack: waiting.length,
      signalsSent: sentCount, signalsReceived: recvCount,
      relayConfigured: ((window.TABLE_CONFIG && window.TABLE_CONFIG.ICE_EXTRA) || []).length > 0,
      lastProblem: lastError ? (lastError.name || '') + ': ' + (lastError.message || lastError) : null
    };
  }
  async function drain() {
    const q = waiting; waiting = [];
    for (const c of q) await add(c);
  }

  // The slot for this kind of media. The following side takes the one the leader's offer created,
  // rather than inventing a second.
  async function slot(kind) {
    const find = () => pc.getTransceivers()
      .find(t => t.receiver && t.receiver.track && t.receiver.track.kind === kind);
    let t = find();
    if (t) return t;
    if (polite) {
      // Wait briefly for the leader's offer rather than racing it with one of our own.
      for (let i = 0; i < 30 && !t; i++) {
        await new Promise(r => setTimeout(r, 100));
        t = find();
      }
      if (t) return t;
    }
    return pc.addTransceiver(kind, { direction: 'recvonly' });
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
    build();
    const tx = await slot(kind);
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
      lastError = e;
      if (kind === 'video') camOn = false; else micOn = false;
      fire();
      throw e;                                   // the caller turns this into a sentence on screen
    }
  }
  const setCamera = on => toggle('video', on);
  const setMic = on => toggle('audio', on);

  /* A match channel delivers to whoever is listening at that moment and keeps nothing. The host lays
     out the media lines as soon as it enters the arena, which is routinely before the other player has
     arrived, so that first offer is spoken to an empty room. Once presence says they are really there,
     say it again — and re-announce what is already switched on, which they also missed. */
  function peerHere() {
    if (!running) return;
    Net.sendRtc({ have: { cam: camOn, mic: micOn } });
    if (polite || !pc || pc.remoteDescription) return;      // the guest waits; an answered offer stands
    (async () => {
      try {
        if (pc.signalingState === 'stable') await pc.setLocalDescription();
        if (pc.localDescription) { sentCount++; Net.sendRtc({ desc: pc.localDescription }); }
      } catch (e) { lastError = e; Err.log(e, 'renew video offer'); }
    })();
  }

  // Called when a 1v1 begins. Nothing is captured here; it only decides who yields on a collision.
  function start(role) {
    if (!available()) return;
    polite = role !== 'host';                    // the guest backs down, the host presses on
    running = true; state = 'idle';
    theirCam = theirMic = false;
    build();
    fire();
    const held = early; early = [];
    held.forEach(d => onSignal(d));
  }
  function stop() {
    running = false; camOn = false; micOn = false; state = 'idle';
    theirCam = theirMic = false;
    drop('video'); drop('audio');
    localStream = null;
    waiting = []; early = [];
    if (pc) { try { pc.close(); } catch (e) { /* already closed */ } }
    pc = null;
    remoteStream = null;
    fire();
  }

  return {
    available, start, stop, setCamera, setMic, onSignal, peerHere, report,
    get state() { return read(); },
    get localStream() { return localStream; },
    get remoteStream() { return remoteStream; },
    onChange(f) { subs.push(f); }
  };
})();
