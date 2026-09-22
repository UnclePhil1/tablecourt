/* Table – 3D scene. Draws the table, paddles and ball, moves the camera, and plays the visual effects. */
const Scene = (function () {
  const RED = 0xe5322d;
  let renderer, scene, camera, ballMesh, pMesh, cMesh, netMesh, fillLight;
  const view = { az: 0, el: Math.atan2(1.6, 4.6) };            // arena camera turns around the table
  const par = { x: 0, y: 0 };                                     // pointer parallax on the landing page
  const cam = { p: new THREE.Vector3(), t: new THREE.Vector3(), fov: 30, ready: false };
  const goalP = new THREE.Vector3(), goalT = new THREE.Vector3();
  const sw = { '1': 0, '-1': 0 };                                 // paddle swing, 1 = just hit
  let mode = 'landing', time = 0, shake = 0, netWob = 0;
  let mySide = 1;                                                 // which end the person at this screen plays from (build() has its own local `side` material)
  const sparks = [], ripples = [], trail = [], hist = [];
  const tmp = new THREE.Vector3(), axis = new THREE.Vector3(), dq = new THREE.Quaternion();

  const mat = (color, rough = .6, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  const canvasTex = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); return new THREE.CanvasTexture(c); };

  function tableTexture() {
    const t = canvasTex(1024, 1840, (g, W, Hh) => {
      g.fillStyle = '#0e3d2c'; g.fillRect(0, 0, W, Hh);
      const gr = g.createRadialGradient(W / 2, Hh / 2, 60, W / 2, Hh / 2, Hh * .62);
      gr.addColorStop(0, 'rgba(70,170,120,.20)'); gr.addColorStop(1, 'rgba(0,0,0,.35)'); g.fillStyle = gr; g.fillRect(0, 0, W, Hh);
      g.fillStyle = 'rgba(255,255,255,.10)';                       // fine dot grid, like the board in the reference
      for (let y = 20; y < Hh; y += 32) for (let x = 20; x < W; x += 32) { g.beginPath(); g.arc(x, y, 1.7, 0, 6.3); g.fill(); }
      g.fillStyle = '#efebe0'; const m = 10, lw = 13;                // white lines, 2 cm wide
      g.fillRect(m, m, W - 2 * m, lw); g.fillRect(m, Hh - m - lw, W - 2 * m, lw); g.fillRect(m, m, lw, Hh - 2 * m); g.fillRect(W - m - lw, m, lw, Hh - 2 * m);
      g.fillRect(W / 2 - 2, m, 4, Hh - 2 * m);
    });
    t.anisotropy = renderer.capabilities.getMaxAnisotropy(); return t;
  }
  const ballTexture = () => canvasTex(256, 128, (g) => {
    g.fillStyle = '#f7f4ec'; g.fillRect(0, 0, 256, 128);
    g.strokeStyle = '#2a800e'; g.lineWidth = 6; g.fillStyle = '#2a800e';
    [64, 192].forEach(x => { g.beginPath(); g.arc(x, 64, 17, 0, 6.3); g.stroke(); g.beginPath(); g.arc(x, 64, 5, 0, 6.3); g.fill(); });
    g.fillRect(0, 62, 256, 4);
  });
  const netTexture = () => canvasTex(256, 32, (g) => {
    g.strokeStyle = 'rgba(232,232,228,.6)'; g.lineWidth = 1; g.beginPath();
    for (let i = 0; i < 256; i += 5) { g.moveTo(i + .5, 0); g.lineTo(i + .5, 32); }
    for (let j = 0; j < 32; j += 5) { g.moveTo(0, j + .5); g.lineTo(256, j + .5); }
    g.stroke();
  });
  const glowTexture = () => canvasTex(256, 256, (g) => {
    const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    gr.addColorStop(0, 'rgba(229,50,45,.55)'); gr.addColorStop(.5, 'rgba(229,50,45,.16)'); gr.addColorStop(1, 'rgba(229,50,45,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  });

  function box(w, h, d, m, x, y, z, shadow = true) {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z); o.castShadow = shadow; o.receiveShadow = true; scene.add(o); return o;
  }
  function paddle(rubber, rough) {
    const wood = mat(0xd6b382, .55), rim = mat(0x18181a, .5), g = new THREE.Group();
    const face = () => { const m = mat(rubber, rough); m.emissive = new THREE.Color(rubber).multiplyScalar(.16); return m; };
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(.16, .16, .018, 56), [rim, face(), face()]);
    disc.rotation.x = Math.PI / 2;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(.04, .13, .02), wood); handle.position.y = -.21;
    g.add(disc, handle); g.traverse(o => { o.castShadow = true; }); scene.add(g); return g;
  }

  function build() {
    scene = new THREE.Scene(); scene.background = new THREE.Color(0x050506); scene.fog = new THREE.Fog(0x050506, 9, 25);
    scene.add(new THREE.HemisphereLight(0x9aa4b4, 0x140606, .38));
    const key = new THREE.SpotLight(0xfff3e4, 1.5, 16, .62, .75, 1);
    key.position.set(.6, 5.2, 1.4); key.target.position.set(0, 0, -.1); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -.0004; key.shadow.camera.near = 2; key.shadow.camera.far = 12;
    scene.add(key, key.target);
    const rimL = new THREE.PointLight(0xff2a1c, .95, 10, 1.6); rimL.position.set(-3.4, .9, .6); scene.add(rimL);
    fillLight = new THREE.PointLight(0xffe6d2, 1.5, 16, 1); fillLight.position.set(1.4, 1.8, 4.6); scene.add(fillLight);   // lights the paddle faces that point at the camera
    const rimR = new THREE.PointLight(0xff3a2a, .7, 9, 1.6); rimR.position.set(3.2, .7, -2.6); scene.add(rimR);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), mat(0x0a0a0c, .9, .05));
    floor.rotation.x = -Math.PI / 2; floor.position.y = FLOOR; floor.receiveShadow = true; scene.add(floor);
    const grid = new THREE.GridHelper(40, 80, 0x6a1a16, 0x2c0e0c); grid.position.y = FLOOR + .003;
    grid.material.transparent = true; grid.material.opacity = .28; scene.add(grid);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(8, 10), new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .9 }));
    glow.rotation.x = -Math.PI / 2; glow.position.set(-.4, FLOOR + .006, 0); scene.add(glow);

    // table
    const side = mat(0x0b1210, .6, .2), top = new THREE.MeshStandardMaterial({ map: tableTexture(), roughness: .42, metalness: .05 });
    box(2 * HW, .04, 2 * HL, [side, side, top, side, side, side], 0, -.02, 0);
    box(2 * HW - .14, .1, 2 * HL - .14, side, 0, -.09, 0);
    const led = new THREE.MeshBasicMaterial({ color: 0xff3a2e });
    box(2 * HW + .006, .012, .006, led, 0, -.03, HL + .002, false); box(2 * HW + .006, .012, .006, led, 0, -.03, -HL - .002, false);
    box(.006, .012, 2 * HL + .006, led, HW + .002, -.03, 0, false); box(.006, .012, 2 * HL + .006, led, -HW - .002, -.03, 0, false);
    const leg = mat(0x0d0e10, .4, .6);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => box(.07, .68, .07, leg, a * (HW - .12), -.4, b * (HL - .22)));

    // net
    netMesh = new THREE.Group();
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(2 * HW + .12, NET), new THREE.MeshBasicMaterial({ map: netTexture(), transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    cloth.position.y = NET / 2;
    const band = new THREE.Mesh(new THREE.BoxGeometry(2 * HW + .12, .014, .006), new THREE.MeshBasicMaterial({ color: 0xf1eee6 }));
    band.position.y = NET; netMesh.add(cloth, band); scene.add(netMesh);
    [-1, 1].forEach(s => { box(.02, NET + .035, .02, leg, s * (HW + .06), NET / 2, 0); box(.026, .01, .026, led, s * (HW + .06), NET + .04, 0, false); });

    // ball and paddles
    ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BR, 28, 18), new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: .35, emissive: 0x2a2620 }));
    ballMesh.castShadow = true; scene.add(ballMesh);
    pMesh = paddle(RED, .32); cMesh = paddle(0xeae5d8, .4);

    // effects: trail, ripples, sparks
    const ballGlow = new THREE.MeshBasicMaterial({ color: 0xfff1de, transparent: true, depthWrite: false });
    for (let i = 0; i < 14; i++) { const m = new THREE.Mesh(new THREE.SphereGeometry(BR * .8, 10, 8), ballGlow.clone()); m.visible = false; scene.add(m); trail.push(m); }
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(new THREE.RingGeometry(.86, 1, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      m.rotation.x = -Math.PI / 2; m.visible = false; m.userData = { life: 0, max: .5, size: .1 }; scene.add(m); ripples.push(m);
    }
    for (let i = 0; i < 30; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(.011, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
      m.visible = false; m.userData = { life: 0, max: .4, v: new THREE.Vector3() }; scene.add(m); sparks.push(m);
    }
  }

  function init(canvas) {
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }); }
    catch (e1) { try { renderer = new THREE.WebGLRenderer({ canvas }); } catch (e2) { return false; } }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    camera = new THREE.PerspectiveCamera(30, 1, .1, 60);
    build(); resize(); addEventListener('resize', resize);
    return true;
  }
  function resize() {
    renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  }

  /* ---------- camera ---------- */
  function goals() {
    const asp = innerWidth / innerHeight, k = 1 + Math.max(0, 1.5 / asp - 1) * .6;   // pull back on tall phone screens
    if (mode === 'landing') {
      goalT.set(par.x * .1, .9 + par.y * .05, -.1);
      goalP.set(.45 + par.x * .5, 2.7 + par.y * .16, 6.0).sub(goalT).multiplyScalar(k).add(goalT);
      return 33;
    }
    const R = Math.hypot(1.6, 4.6) * (1 + Math.max(0, 1.4 / asp - 1) * .65), ce = Math.cos(view.el);
    goalT.set(0, -.1, mySide * .2);
    goalP.set(R * Math.sin(view.az) * ce, -.1 + R * Math.sin(view.el), mySide * .2 + R * Math.cos(view.az) * ce);
    return 30;
  }
  function updateCamera(dt) {
    const fov = goals(), a = cam.ready ? 1 - Math.exp(-dt * 3.2) : 1;
    cam.p.lerp(goalP, a); cam.t.lerp(goalT, a); cam.fov += (fov - cam.fov) * a; cam.ready = true;
    camera.position.copy(cam.p);
    if (shake > .0005) { camera.position.x += (Math.random() - .5) * shake; camera.position.y += (Math.random() - .5) * shake; shake *= Math.exp(-dt * 9); }
    if (Math.abs(camera.fov - cam.fov) > .01) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
    camera.lookAt(cam.t); camera.updateMatrixWorld();
  }
  const setMode = m => { mode = m; if (m === 'arena') resetView(); };
  // Online, the guest plays the far end, so their camera starts behind it and the aiming plane moves too.
  const setSide = s => {
    mySide = s < 0 ? -1 : 1;
    plane.constant = -mySide * PZ;
    // The fill light exists so your own paddle is not a silhouette. Online, the guest sits at the far
    // end, so the light has to move with them or they play behind a black disc.
    if (fillLight) fillLight.position.set(1.4 * mySide, 1.8, 4.6 * mySide);
    resetView();
  };
  const resetView = () => { view.az = mySide > 0 ? 0 : Math.PI; view.el = Math.atan2(1.6, 4.6); };
  const relAz = () => mySide > 0 ? view.az : view.az - Math.PI;   // azimuth measured from behind your own paddle
  const orbit = (dx, dy) => {
    view.az = Math.atan2(Math.sin(view.az - dx * .006), Math.cos(view.az - dx * .006));
    view.el = clamp(view.el + dy * .005, .12, 1.4);
  };
  const wideAngle = () => Math.cos(relAz()) * Math.cos(view.el) < .45;   // too far from behind the paddle for pointer control
  const flip = () => Math.cos(view.az) < 0 ? -1 : 1;
  const parallax = (x, y) => { par.x = x; par.y = y; };

  const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -PZ), pt = new THREE.Vector3(), ndc = new THREE.Vector2();
  function aim(cx, cy, touch) {        // put the paddle under the pointer
    ndc.set(cx / innerWidth * 2 - 1, -(cy / innerHeight * 2 - 1) + (touch ? .14 : 0));
    ray.setFromCamera(ndc, camera);
    const me = mySide > 0 ? P : C;
    if (ray.ray.intersectPlane(plane, pt)) { me.tx = clamp(pt.x, -1.2, 1.2); me.ty = clamp(pt.y, -.05, .85); }
  }
  function project(x, y, z) {
    tmp.set(x, y, z).project(camera);
    return { x: (tmp.x * .5 + .5) * innerWidth, y: (-tmp.y * .5 + .5) * innerHeight, front: tmp.z < 1 };
  }

  /* ---------- effects ---------- */
  function burst(x, y, z, n, color, speed) {
    for (let i = 0; i < n; i++) {
      const m = sparks.find(s => s.userData.life <= 0); if (!m) break;
      m.visible = true; m.material.color.setHex(color); m.position.set(x, y, z);
      m.userData.life = m.userData.max = rnd(.18, .36);
      m.userData.v.set((Math.random() - .5) * 2 * speed, (.2 + Math.random()) * speed, (Math.random() - .5) * 2 * speed);
    }
  }
  function ripple(x, z, v) {
    const m = ripples.find(r => r.userData.life <= 0) || ripples[0];
    m.visible = true; m.position.set(x, .004, z); m.userData.life = m.userData.max = .55; m.userData.size = .08 + Math.min(.12, v * .03);
  }
  function event(n, d) {
    if (n === 'hit') {
      sw[d.s] = 1;
      const big = d.kind === 'smash';
      burst(d.x, d.y, d.z - d.s * .05, big ? 16 : 8, big ? 0xff4a3a : 0xfff1de, big ? 1.5 : .9);
      if (big) shake = Math.max(shake, mode === 'arena' ? .03 : .012);
    } else if (n === 'bounce') { ripple(d.x, d.z, d.v); burst(d.x, .01, d.z, 3, 0xbfe8d2, .4); }
    else if (n === 'net') { netWob = 1; burst(d.x, d.y, d.z, 6, 0xffffff, .6); }
    else if (n === 'restart') { hist.length = 0; }
  }

  function updateEffects(dt) {
    sparks.forEach(m => {
      const u = m.userData; if (u.life <= 0) return;
      u.life -= dt; if (u.life <= 0) { m.visible = false; return; }
      u.v.y -= 6 * dt; m.position.addScaledVector(u.v, dt); m.material.opacity = u.life / u.max; m.scale.setScalar(.5 + u.life / u.max);
    });
    ripples.forEach(m => {
      const u = m.userData; if (u.life <= 0) return;
      u.life -= dt; if (u.life <= 0) { m.visible = false; return; }
      const k = 1 - u.life / u.max; m.scale.setScalar(.02 + k * u.size); m.material.opacity = (1 - k) * .8;
    });
    netWob = Math.max(0, netWob - dt * 2.2);
    netMesh.rotation.x = Math.sin(time * 42) * netWob * netWob * .12;
  }

  function frame(dt) {
    time += dt;
    updateCamera(dt);
    // ball, with a spin you can see
    ballMesh.position.set(ball.x, ball.y, ball.z);
    const w = Math.hypot(ball.wx, ball.wy, ball.wz);
    if (w > 1 && !S.paused) { axis.set(ball.wx / w, ball.wy / w, ball.wz / w); dq.setFromAxisAngle(axis, w * dt * .12); ballMesh.quaternion.premultiply(dq); }
    // trail behind fast balls
    const fast = S.state === 'rally' && Math.hypot(ball.vx, ball.vy, ball.vz) > 2.6;
    if (!S.paused) { hist.unshift(ball.x, ball.y, ball.z); if (hist.length > 90) hist.length = 90; }
    trail.forEach((m, i) => {
      const j = (i + 1) * 6;
      if (!fast || hist.length <= j + 2) { m.visible = false; return; }
      m.visible = true; m.position.set(hist[j], hist[j + 1], hist[j + 2]);
      m.scale.setScalar(1 - i / trail.length * .7); m.material.opacity = (1 - i / trail.length) * .16;
    });
    // paddles swing when they hit
    [[pMesh, 1, P], [cMesh, -1, C]].forEach(([m, s, o]) => {
      sw[s] = Math.max(0, sw[s] - dt * 4.5); const e = sw[s] * sw[s];
      m.position.set(o.x, o.y, s * PZ - s * e * .3);
      m.rotation.set(-s * e * .75 + clamp(-o.vy * .04, -.25, .25), 0, clamp(-o.vx * .06, -.4, .4));
    });
    updateEffects(dt);
    renderer.render(scene, camera);
  }

  return { init, frame, event, setMode, setSide, resetView, orbit, wideAngle, flip, parallax, aim, project,
    get side() { return mySide; }, get az() { return view.az; } };
})();
