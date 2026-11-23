import { createLens, FILTERS, MODELS } from './lens.js';
import { loadFace, trackFace, faceReady, detectImage, resetTracks } from './face.js';
import { putItem, delItem, getItem, listMeta, persist } from './store.js';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const DEBUG = /[?&]debug/.test(location.search);
if (DEBUG) { const f = new URLSearchParams(location.search).get('fake'); if (f) window.__fakeCam = f; }

const DEF = { facing: 'user', mode: 'photo', flash: 'off', live: true, ratio: '3:4', timer: 0, grid: false, mirror: true, date: false, sound: true, model: 'raw', filter: 'soft', strength: 100, blur: 24, noise: 14, slim: 0 };
const S = { ...DEF };
try { Object.assign(S, JSON.parse(localStorage.getItem('softcam') || '{}')); } catch { }
S.model = 'raw'; S.filter = 'soft';
const save = () => { try { localStorage.setItem('softcam', JSON.stringify(S)); } catch { } };

const R = {
  stream: null, track: null, video: document.createElement('video'), ready: false, opening: false,
  devices: [], lens: 1, lensDev: null, dz: 1, frontWide: false, hwZoom: null,
  meter: null, evAuto: 0, evUser: 0, aeLock: false, sceneLum: .5,
  busy: false, rec: null, recT0: 0, countdown: null, live: [], liveJobs: [], lastLive: 0, mic: null
};
R.video.muted = true; R.video.playsInline = true; R.video.setAttribute('playsinline', ''); R.video.setAttribute('muted', '');

let lens = null, capLens = null;
try { lens = createLens($('gl')); capLens = createLens($('capgl'), { preserve: true }); } catch (e) { console.error(e); }

/* ---------- helpers ---------- */
let toastT;
function toast(msg, ms = 2200) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
function asheet(msg, btns) {
  return new Promise(res => {
    $('as-msg').textContent = msg || '';
    const box = $('as-btns'); box.innerHTML = '';
    btns.forEach(b => { const e = document.createElement('button'); e.textContent = b.label; if (b.danger) e.className = 'danger'; e.onclick = () => done(b.v); box.appendChild(e); });
    const done = v => { $('asheet').hidden = true; res(v); };
    $('as-cancel').onclick = () => done(null);
    $('asheet').onclick = e => { if (e.target === $('asheet')) done(null); };
    $('asheet').hidden = false;
  });
}
const ratioNum = r => { const [a, b] = r.split(':').map(Number); return a / b; };
const curRatio = () => S.mode === 'video' ? ratioNum('9:16') : ratioNum(S.ratio);
const model = id => MODELS.find(m => m.id === (id || S.model)) || MODELS[0];
const modelLong = (m, facing) => facing === 'user' ? m.front : m.rear;
const effZoom = () => (S.facing === 'user' && !R.frontWide ? 1.18 : 1) * (R.hwZoom ? 1 : R.dz);
function cropRect(sw, sh, asp, z) { let cw = 1, ch = 1; const s = sw / sh; if (s > asp) cw = asp / s; else ch = s / asp; cw /= z; ch /= z; return [(1 - cw) / 2, (1 - ch) / 2, cw, ch]; }
function outSize(asp, sw, sh, z, cap) {
  const [, , cw, ch] = cropRect(sw, sh, asp, z);
  const long = Math.max(cw * sw, ch * sh);
  const L = cap ? Math.min(cap, long) : long;
  const w = asp >= 1 ? L : L * asp, h = asp >= 1 ? L / asp : L;
  return [Math.max(2, Math.round(w / 2) * 2), Math.max(2, Math.round(h / 2) * 2)];
}
const lensOpts = (extra = {}) => ({ model: S.model, filter: S.filter, strength: S.strength / 100, blur: S.blur / 100, noise: S.noise / 100, slim: S.slim / 100, ...extra });
const stamp = d => `'${String(d.getFullYear()).slice(2)} ${d.getMonth() + 1} ${d.getDate()}`;
const fname = (t, ext) => { const d = new Date(t), p = n => String(n).padStart(2, '0'); return `IMG_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`; };
const extOf = type => /mp4/.test(type) ? 'mp4' : /quicktime/.test(type) ? 'mov' : /webm/.test(type) ? 'webm' : /png/.test(type) ? 'png' : 'jpg';
const pickMime = () => ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
const toBlob = (c, type = 'image/jpeg', q = .92) => new Promise(r => c.toBlob(r, type, q));
async function thumbOf(src, w, h, size = 360) {
  const s = Math.min(1, size / Math.min(w, h)), c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return toBlob(c, 'image/jpeg', .8);
}

/* ---------- sound ---------- */
let actx;
function ac() { try { actx ||= new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch { } return actx; }
function click() {
  if (!S.sound) return; const a = ac(); if (!a) return;
  const t = a.currentTime;
  [0, .075].forEach((d, i) => {
    const n = a.sampleRate * .05, b = a.createBuffer(1, n, a.sampleRate), ch = b.getChannelData(0);
    for (let k = 0; k < n; k++) ch[k] = (Math.random() * 2 - 1) * Math.pow(1 - k / n, 6);
    const s = a.createBufferSource(); s.buffer = b;
    const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = i ? 2400 : 3600; f.Q.value = .9;
    const g = a.createGain(); g.gain.value = i ? .5 : .8;
    s.connect(f).connect(g).connect(a.destination); s.start(t + d);
  });
}
const buzz = ms => { try { navigator.vibrate?.(ms); } catch { } };

/* ---------- camera ---------- */
async function listDevices() {
  try { R.devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); } catch { R.devices = []; }
}
const findDev = re => R.devices.find(d => re.test(d.label));
const ultraDev = () => findDev(/ultra|超广角/i);
const teleDev = () => findDev(/tele|长焦/i);

function stopCam() {
  if (R.stream) R.stream.getTracks().forEach(t => t.stop());
  R.stream = null; R.track = null; R.ready = false; R.video.srcObject = null;
}
async function openCam() {
  if (R.opening) return; R.opening = true;
  try {
    stopCam();
    let stream;
    if (window.__fakeCam) {
      const v = document.createElement('video'); v.src = window.__fakeCam; v.loop = true; v.muted = true; v.playsInline = true; await v.play();
      R.video = v; R.ready = true; $('nocam').classList.add('gone'); afterOpen(); return;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no gum'), { name: 'NoGUM' });
    const v = { width: { ideal: 1920 }, height: { ideal: 1440 }, frameRate: { ideal: 30 } };
    if (R.lensDev && S.facing === 'environment') v.deviceId = { exact: R.lensDev }; else v.facingMode = S.facing;
    stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
    R.stream = stream; R.track = stream.getVideoTracks()[0];
    R.video.srcObject = stream;
    await R.video.play().catch(() => { });
    await new Promise(r => { if (R.video.videoWidth) r(); else R.video.onloadedmetadata = r; setTimeout(r, 1500); });
    R.ready = true; $('nocam').classList.add('gone');
    if (!R.devices.length || !R.devices[0].label) await listDevices();
    afterOpen();
  } catch (e) {
    console.warn(e);
    $('nocam').classList.remove('gone');
    const p = $('nocam').querySelector('small');
    p.textContent = e.name === 'NotAllowedError' ? '相机权限被拒绝了：去 设置 › Safari/浏览器 › 相机 改成"允许"，再点下面的按钮'
      : e.name === 'NoGUM' ? '这个浏览器不支持网页相机，请用 Safari 或 Chrome 打开（需要 https）'
      : e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? '没找到这个镜头' : e.name === 'NotReadableError' ? '相机被别的 App 占用了，关掉它再试' : '相机打不开（' + e.name + '）';
    if (R.lensDev) { R.lensDev = null; R.lens = 1; }
  } finally { R.opening = false; }
}
function afterOpen() {
  R.hwZoom = null;
  try { const c = R.track?.getCapabilities?.(); if (c?.zoom && S.facing === 'environment' && !R.lensDev) R.hwZoom = c.zoom; R.torch = !!c?.torch; } catch { R.torch = false; }
  resetTracks(); R.meter = null; R.evAuto = 0; R.evUser = 0; R.aeLock = false; R.dz = 1;
  applyZoom(); buildZoom(); syncUI();
  if (S.slim > 0) loadFace().catch(() => { });
}
async function setTorch(on) {
  if (!R.track || !R.torch) return false;
  try { await R.track.applyConstraints({ advanced: [{ torch: !!on }] }); return true; } catch { return false; }
}
function applyZoom() {
  if (R.hwZoom && R.track) { const z = clamp(R.dz, R.hwZoom.min || 1, R.hwZoom.max || 1); R.track.applyConstraints({ advanced: [{ zoom: z }] }).catch(() => { R.hwZoom = null; }); }
}
function zoomLabel() { const z = R.lens * R.dz; return (Math.round(z * 10) / 10).toString().replace(/^0/, '') + (Math.abs(z - Math.round(z)) < .05 && z >= 1 ? '×' : ''); }
function buildZoom() {
  const box = $('zoom'); box.innerHTML = '';
  $('vf').classList.toggle('front', S.facing === 'user');
  $('frontwide').classList.toggle('on', R.frontWide);
  $('frontwide').querySelector('use').setAttribute('href', R.frontWide ? '#i-narrow' : '#i-wide');
  if (S.facing === 'user') { box.style.display = R.dz > 1.05 ? '' : 'none'; if (R.dz > 1.05) { const b = document.createElement('button'); b.className = 'on'; b.textContent = zoomLabel(); b.onclick = () => { R.dz = 1; applyZoom(); buildZoom(); }; box.appendChild(b); } return; }
  box.style.display = '';
  const stops = [...(ultraDev() ? [.5] : []), 1, 2];
  const cur = R.lens * R.dz;
  let active = stops.reduce((a, s) => cur >= s - .01 ? s : a, stops[0]);
  for (const s of stops) {
    const b = document.createElement('button');
    const on = s === active;
    b.className = on ? 'on' : '';
    b.textContent = on ? zoomLabel() : (s === .5 ? '.5' : s + '');
    b.onclick = () => pickLens(s);
    box.appendChild(b);
  }
}
async function pickLens(s) {
  if (R.rec) return;
  if (s === .5) { const d = ultraDev(); if (d && R.lensDev !== d.deviceId) { R.lensDev = d.deviceId; R.lens = .5; await openCam(); } R.dz = 1; }
  else if (s === 2 && teleDev()) { const d = teleDev(); if (R.lensDev !== d.deviceId) { R.lensDev = d.deviceId; R.lens = 2; await openCam(); } R.dz = 1; }
  else {
    if (R.lensDev) { R.lensDev = null; R.lens = 1; await openCam(); }
    R.dz = s;
  }
  applyZoom(); buildZoom(); buzz(8);
}

/* ---------- layout ---------- */
function layout() {
  const st = $('stage').getBoundingClientRect();
  const a = curRatio(), W = st.width - 24, H = st.height - 16;
  let w = W, h = w / a; if (h > H) { h = H; w = h * a; }
  const vf = $('vf'); vf.style.width = w + 'px'; vf.style.height = h + 'px';
  R.vfW = w; R.vfH = h;
}
addEventListener('resize', layout);

/* ---------- metering ---------- */
const mc = document.createElement('canvas'); mc.width = 48; mc.height = 64;
const mx = mc.getContext('2d', { willReadFrequently: true });
let lastMeter = 0;
function meter(now) {
  if (now - lastMeter < 180 || !R.ready) return; lastMeter = now;
  const v = R.video, sw = v.videoWidth, sh = v.videoHeight; if (!sw) return;
  try { mx.drawImage(v, 0, 0, 48, 64); } catch { return; }
  const d = mx.getImageData(0, 0, 48, 64).data;
  const L = i => (d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114) / 255;
  let s = 0; for (let i = 0; i < d.length; i += 16) s += L(i); R.sceneLum = s / (d.length / 16);
  if (!R.meter || R.aeLock) { if (!R.meter) R.evAuto += (0 - R.evAuto) * .3; return; }
  const [rx, ry, rw, rh] = cropRect(sw, sh, curRatio(), effZoom());
  const mirror = S.facing === 'user' && S.mirror;
  const ux = rx + (mirror ? 1 - R.meter[0] : R.meter[0]) * rw, uy = ry + R.meter[1] * rh;
  const cx = Math.round(ux * 47), cy = Math.round((1 - uy) * 63);
  let a = 0, n = 0;
  for (let y = cy - 4; y <= cy + 4; y++) for (let x = cx - 3; x <= cx + 3; x++) { if (x < 0 || y < 0 || x > 47 || y > 63) continue; a += L((y * 48 + x) * 4); n++; }
  const lum = Math.max(.02, a / Math.max(1, n));
  const target = clamp(Math.log2(.36 / lum), -1.6, 1.5);
  R.evAuto += (target - R.evAuto) * .45;
}

/* ---------- live ring buffer ---------- */
const LIVE_FPS = 15, LIVE_PRE = 1.5, LIVE_POST = 1.5;
function liveDims() { const a = curRatio(), L = 540; return a >= 1 ? [L, Math.round(L / a / 2) * 2] : [Math.round(L * a / 2) * 2, L]; }
function pushLive(now) {
  const wanted = S.mode === 'photo' && S.live;
  if (!wanted) { if (R.live.length) R.live = []; return; }
  if (now - R.lastLive < 1000 / LIVE_FPS - 4) return; R.lastLive = now;
  const [w, h] = liveDims(), c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage($('gl'), 0, 0, w, h);
  R.live.push({ c, t: now });
  for (const j of R.liveJobs) if (!j.done && now <= j.until) j.frames.push(c);
  while (R.live.length && now - R.live[0].t > LIVE_PRE * 1000) R.live.shift();
  for (const j of R.liveJobs) if (!j.done && now > j.until) { j.done = true; encodeFrames(j.frames, LIVE_FPS).then(j.resolve, () => j.resolve(null)); }
  R.liveJobs = R.liveJobs.filter(j => !j.done);
}
async function encodeFrames(frames, fps) {
  const mime = pickMime(); if (!mime || !frames.length) return null;
  const c = document.createElement('canvas'); c.width = frames[0].width; c.height = frames[0].height;
  const x = c.getContext('2d'); x.drawImage(frames[0], 0, 0);
  const st = c.captureStream(fps), rec = new MediaRecorder(st, { mimeType: mime, videoBitsPerSecond: 3e6 }), parts = [];
  rec.ondataavailable = e => e.data.size && parts.push(e.data);
  const done = new Promise(r => rec.onstop = r);
  rec.start();
  const t0 = performance.now();
  for (let i = 0; i < frames.length; i++) { x.drawImage(frames[i], 0, 0); const due = t0 + (i + 1) * 1000 / fps; await sleep(Math.max(0, due - performance.now())); }
  rec.stop(); await done; st.getTracks().forEach(t => t.stop());
  return new Blob(parts, { type: mime.split(';')[0] });
}

/* ---------- render loop ---------- */
let faces = [];
function previewSize() {
  const a = curRatio(), dpr = Math.min(3, devicePixelRatio || 1);
  let L = Math.max(R.vfW || 300, R.vfH || 400) * dpr;
  L = Math.min(L, 1100);
  const ml = modelLong(model(), S.facing);
  const v = R.video;
  if (ml && v.videoWidth) { const [ow, oh] = outSize(a, v.videoWidth, v.videoHeight, effZoom(), ml); L = Math.min(L, Math.max(ow, oh)); }
  return a >= 1 ? [Math.round(L), Math.round(L / a)] : [Math.round(L * a), Math.round(L)];
}
function ev() { return clamp(R.evAuto + R.evUser, -2.5, 2.8); }
function frame() {
  requestAnimationFrame(frame);
  if (!R.ready || !lens || document.hidden || !$('cam').classList.contains('on')) return;
  const v = R.video; if (!v.videoWidth || v.readyState < 2) return;
  const now = performance.now();
  faces = S.slim > 0 && faceReady() ? trackFace(v, now) : [];
  meter(now);
  const [w, h] = R.rec ? [R.recW, R.recH] : previewSize();
  lens.render(v, v.videoWidth, v.videoHeight, lensOpts({ width: w, height: h, zoom: effZoom(), mirror: S.facing === 'user' && S.mirror, ev: ev(), faces, time: now / 1000 }));
  pushLive(now);
  if (R.wantThumb) { const r = R.wantThumb; R.wantThumb = null; r(thumbOf($('gl'), w, h)); }
}
requestAnimationFrame(frame);

/* ---------- photo ---------- */
function bigFaceCenter(sw, sh, rect, mirror) {
  let best = null; for (const f of faces) if (!best || f.r * (f.w ?? 1) > best.r * (best.w ?? 1)) best = f;
  if (!best) return null;
  const [rx, ry, rw, rh] = rect; let x = (best.c[0] - rx) / rw, y = (best.c[1] - ry) / rh; if (mirror) x = 1 - x;
  return [clamp(x, 0, 1), clamp(y + .02, 0, 1)];
}
async function shoot() {
  if (R.busy || !R.ready) return;
  if (R.countdown) { clearInterval(R.countdown.iv); R.countdown = null; $('count').textContent = ''; return; }
  if (S.timer) {
    let n = S.timer; $('count').textContent = n;
    await new Promise(res => { R.countdown = { iv: setInterval(() => { n--; if (n <= 0) { clearInterval(R.countdown.iv); R.countdown = null; $('count').textContent = ''; res(); } else { $('count').textContent = n; buzz(5); } }, 1000) }; });
    if (!R.ready) return;
  }
  R.busy = true; ac();
  try {
    const useFlash = S.flash === 'on' || (S.flash === 'auto' && R.sceneLum < .2);
    let flashAmt = 0;
    if (useFlash) {
      if (S.facing === 'user') { $('flashfill').classList.add('on'); await sleep(320); flashAmt = .35; }
      else if (await setTorch(true)) { await sleep(450); flashAmt = .2; }
      else flashAmt = .8;
    }
    const liveJob = S.live && S.mode === 'photo' && R.live.length ? new Promise(resolve => R.liveJobs.push({ frames: R.live.map(f => f.c), until: performance.now() + LIVE_POST * 1000, resolve })) : null;
    if (liveJob) { $('liveon').classList.add('show'); setTimeout(() => !S.liveHint && $('liveon').classList.remove('show'), (LIVE_POST + .3) * 1000); }
    const v = R.video, sw = v.videoWidth, sh = v.videoHeight, a = curRatio(), z = effZoom(), mirror = S.facing === 'user' && S.mirror;
    const rect = cropRect(sw, sh, a, z), fpos = bigFaceCenter(sw, sh, rect, mirror) || [.5, .56];
    const m = model(), now = Date.now();
    const [ow, oh] = outSize(a, sw, sh, z, modelLong(m, S.facing));
    const [rw, rh] = outSize(a, sw, sh, z, 2400);
    const base = { width: rw, height: rh, zoom: z, mirror, ev: ev(), flash: flashAmt, fpos, time: now / 1000, instant: true };
    capLens.render(v, sw, sh, { ...base, model: 'raw', filter: 'none' });
    const orig = await toBlob($('capgl'), 'image/jpeg', .93);
    const params = lensOpts();
    capLens.render(v, sw, sh, { ...base, ...lensOpts(), width: ow, height: oh, faces: faces.map(f => ({ ...f })) });
    $('flashfill').classList.remove('on'); if (flashAmt && S.facing !== 'user') setTorch(false);
    $('blink').classList.remove('go'); void $('blink').offsetWidth; $('blink').classList.add('go'); click(); buzz(12);
    const blob = await finishPhoto($('capgl'), ow, oh, m, S.date, now);
    const thumb = await thumbOf($('capgl'), ow, oh);
    const item = { id: now + '-' + Math.random().toString(36).slice(2, 6), t: now, type: 'photo', blob, orig, params: { ...params, date: S.date, flash: flashAmt }, thumb, w: ow, h: oh, model: m.id };
    await putItem(item); setThumb(thumb, true);
    if (liveJob) {
      $('thumb').classList.add('busy');
      liveJob.then(async lv => { $('thumb').classList.remove('busy'); if (lv) { item.live = lv; await putItem(item); } });
    }
    persist();
  } catch (e) { console.error(e); toast('拍摄失败：' + e.message); }
  finally { $('flashfill').classList.remove('on'); R.busy = false; }
}
async function finishPhoto(src, w, h, m, date, t) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
  x.drawImage(src, 0, 0, w, h);
  if (date) {
    const fs = Math.round(Math.min(w, h) * .045);
    x.font = `bold ${fs}px "Courier New",monospace`; x.textAlign = 'right'; x.textBaseline = 'bottom';
    x.shadowColor = 'rgba(255,120,30,.8)'; x.shadowBlur = fs * .35; x.fillStyle = '#FF9B3D';
    x.fillText(stamp(new Date(t)), w - fs * .9, h - fs * .8);
  }
  return toBlob(c, 'image/jpeg', m.jpg || .92);
}

/* ---------- video ---------- */
async function getMic() {
  if (R.mic && R.mic.getAudioTracks().some(t => t.readyState === 'live')) return R.mic;
  try { R.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } }); } catch { R.mic = null; }
  return R.mic;
}
async function toggleRec() {
  if (R.rec) { R.rec.stop(); return; }
  if (!R.ready || R.busy) return;
  const mime = pickMime(); if (!mime) return toast('这个浏览器不支持录像');
  R.busy = true;
  const mic = window.__fakeCam ? null : await getMic();
  if (S.flash === 'on') { if (S.facing === 'user') document.body.classList.add('ringon'); else setTorch(true); }
  [R.recW, R.recH] = previewSize();
  const vs = $('gl').captureStream(30);
  const st = new MediaStream([...vs.getVideoTracks(), ...(mic ? mic.getAudioTracks() : [])]);
  const rec = new MediaRecorder(st, { mimeType: mime, videoBitsPerSecond: 8e6, audioBitsPerSecond: 160000 }), parts = [];
  rec.ondataavailable = e => e.data.size && parts.push(e.data);
  const thumbP = new Promise(r => R.wantThumb = r);
  rec.onstop = async () => {
    const dur = (performance.now() - R.recT0) / 1000;
    vs.getTracks().forEach(t => t.stop());
    R.rec = null; document.body.classList.remove('recording', 'ringon'); setTorch(false); clearInterval(R.recIv);
    const blob = new Blob(parts, { type: mime.split(';')[0] }), now = Date.now();
    const thumb = await thumbP;
    await putItem({ id: now + '-' + Math.random().toString(36).slice(2, 6), t: now, type: 'video', blob, thumb, w: R.recW, h: R.recH, dur, model: S.model });
    setThumb(thumb, true); persist();
  };
  R.rec = rec; R.recT0 = performance.now(); rec.start(1000); click(); buzz(15);
  document.body.classList.add('recording');
  const tick = () => { const s = Math.floor((performance.now() - R.recT0) / 1000); $('rectime').textContent = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  tick(); R.recIv = setInterval(tick, 250);
  R.busy = false;
}

/* ---------- UI: camera ---------- */
function setThumb(blob, pop) {
  const img = $('thumb').querySelector('img');
  if (!blob) { img.classList.remove('has'); img.removeAttribute('src'); return; }
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  img.src = img.dataset.url = URL.createObjectURL(blob); img.classList.add('has');
  if (pop) { $('thumb').classList.remove('pop'); void $('thumb').offsetWidth; $('thumb').classList.add('pop'); }
}
function buildModels(box, get, set) {
  box.innerHTML = '';
  for (const m of MODELS) {
    const b = document.createElement('button'); b.dataset.id = m.id;
    b.innerHTML = m.id === 'raw' ? m.name : `<svg><use href="#i-phone"/></svg>${m.name}`;
    b.onclick = () => { set(m.id); [...box.children].forEach(x => x.classList.toggle('on', x.dataset.id === m.id)); b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); };
    box.appendChild(b);
  }
  [...box.children].forEach(x => x.classList.toggle('on', x.dataset.id === get()));
}
function buildFilters(box, get, set) {
  box.innerHTML = '';
  for (const f of FILTERS) {
    const b = document.createElement('button'); b.dataset.id = f.id;
    b.innerHTML = `<i style="background:${f.sw}"></i>${f.name}`;
    b.onclick = () => { set(f.id); [...box.children].forEach(x => x.classList.toggle('on', x.dataset.id === f.id)); };
    box.appendChild(b);
  }
  [...box.children].forEach(x => x.classList.toggle('on', x.dataset.id === get()));
}
const SLIDERS = [['strength', '强度'], ['blur', '模糊'], ['noise', '噪点'], ['slim', '瘦脸']];
function buildSliders(box, P, onchange) {
  box.innerHTML = '';
  for (const [k, name] of SLIDERS) {
    const row = document.createElement('label'); row.className = 'sl';
    row.innerHTML = `<span>${name}</span><input type="range" min="0" max="100" step="1"><b></b>`;
    const inp = row.querySelector('input'), out = row.querySelector('b');
    const paint = () => { inp.value = P[k]; out.textContent = P[k]; inp.style.setProperty('--p', P[k] + '%'); };
    inp.oninput = () => { P[k] = +inp.value; paint(); onchange(k); };
    paint(); row.paint = paint; box.appendChild(row);
  }
}
function syncUI() {
  const app = document.body;
  app.classList.toggle('mode-video', S.mode === 'video');
  app.classList.toggle('showgrid', S.grid); app.classList.toggle('showdate', S.date && S.mode === 'photo');
  const fb = $('b-flash'); fb.classList.toggle('off', S.flash === 'off'); fb.classList.toggle('on', S.flash === 'on'); fb.classList.toggle('auto', S.flash === 'auto');
  $('b-live').classList.toggle('off', !S.live); $('b-live').classList.toggle('on', S.live);
  const tuned = S.strength !== DEF.strength || S.blur !== DEF.blur || S.noise !== DEF.noise || S.slim;
  $('b-tune').classList.toggle('mod', !!tuned);
  document.querySelectorAll('#tray .trow[data-k]').forEach(r => r.querySelectorAll('button').forEach(b => b.classList.toggle('on', String(S[r.dataset.k]) === b.dataset.v)));
  document.querySelectorAll('#tray [data-t]').forEach(b => b.classList.toggle('on', !!S[b.dataset.t]));
  $('tray').querySelector('[data-k=ratio]').style.display = S.mode === 'video' ? 'none' : '';
  document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.m === S.mode));
  const on = $('modes').querySelector('.on'); if (on) $('modes').querySelector('.track').style.transform = `translateX(${-(on.offsetLeft + on.offsetWidth / 2)}px)`;
  $('datestamp').textContent = stamp(new Date());
  const m = model(), tag = m.id === 'raw' ? '' : `${m.name} · ${S.facing === 'user' ? '前置 ' + m.mp[0] : '后置 ' + m.mp[1]}`;
  $('camtag').textContent = tag;
  layout(); save();
}

$('b-flash').onclick = () => {
  const seq = S.mode === 'video' ? ['off', 'on'] : ['auto', 'on', 'off'];
  S.flash = seq[(seq.indexOf(S.flash) + 1) % seq.length]; syncUI();
  toast(S.flash === 'on' ? (S.facing === 'user' ? '闪光灯：打开 · 前置用屏幕补光' : R.torch ? '闪光灯：打开' : '闪光灯：打开 · 这台设备网页无法控制闪光灯，用模拟闪光') : S.flash === 'auto' ? '闪光灯：自动' : '闪光灯：关闭', 1600);
};
$('b-live').onclick = () => { S.live = !S.live; syncUI(); const b = $('liveon'); b.textContent = S.live ? 'LIVE' : '实况 关闭'; b.classList.add('show'); setTimeout(() => { b.classList.remove('show'); setTimeout(() => b.textContent = 'LIVE', 300); }, 1300); };
$('b-more').onclick = () => { const t = $('tray'); t.hidden = !t.hidden; $('b-more').classList.toggle('open', !t.hidden); };
$('tray').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.t) S[b.dataset.t] = !S[b.dataset.t];
  else { const k = b.closest('.trow').dataset.k; S[k] = k === 'timer' ? +b.dataset.v : b.dataset.v; }
  syncUI();
};
$('b-tune').onclick = () => { $('tune').hidden = !$('tune').hidden; $('tray').hidden = true; $('b-more').classList.remove('open'); };
$('b-tunedone').onclick = () => { $('tune').hidden = true; };
$('b-reset').onclick = () => { Object.assign(S, { strength: DEF.strength, blur: DEF.blur, noise: DEF.noise, slim: 0 }); buildTune(); syncUI(); };
function buildTune() {
  buildSliders($('sliders'), S, k => { if (k === 'slim' && S.slim > 0) loadFace().catch(() => toast('瘦脸模型加载失败，检查网络')); syncUI(); });
}
buildTune();

$('modes').onclick = e => { const b = e.target.closest('button'); if (!b || R.rec) return; setMode(b.dataset.m); };
function setMode(m) {
  if (m === S.mode) return;
  S.mode = m; if (m === 'video' && S.flash === 'auto') S.flash = 'off';
  R.live = []; syncUI(); buzz(6);
}
$('shutter').onclick = () => { if (S.mode === 'video') toggleRec(); else shoot(); };
addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter' || e.key === 'AudioVolumeUp' || e.key === 'AudioVolumeDown') && $('cam').classList.contains('on') && !e.target.closest('input')) { e.preventDefault(); $('shutter').click(); } });
$('b-flip').onclick = async () => {
  if (R.rec || R.busy) return;
  S.facing = S.facing === 'user' ? 'environment' : 'user'; R.lensDev = null; R.lens = 1; R.frontWide = false;
  $('b-flip').classList.toggle('spin'); save(); await openCam(); syncUI();
};
$('frontwide').onclick = e => { e.stopPropagation(); R.frontWide = !R.frontWide; buildZoom(); buzz(6); };
$('b-start').onclick = () => openCam();
$('b-import2').onclick = () => $('importer').click();
$('thumb').onclick = () => openAlbum(true);

/* gestures on viewfinder: tap = focus/exposure, hold = AE lock, drag = EV, pinch = zoom, swipe = mode */
(() => {
  const vf = $('vf'), pts = new Map(); let g = null, holdT = null, hideT = null;
  const showFocus = (x, y) => {
    const f = $('focus'); f.style.left = x + 'px'; f.style.top = y + 'px';
    f.classList.toggle('left', x > R.vfW - 70);
    f.classList.remove('pop'); void f.offsetWidth; f.classList.add('show', 'pop'); sunPos();
    clearTimeout(hideT); hideT = setTimeout(() => { if (!R.aeLock) f.classList.remove('show'); }, 2600);
  };
  const sunPos = () => { $('focus').querySelector('.sun').style.top = `calc(50% - 12px - ${R.evUser * 26}px)`; };
  vf.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    vf.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) { clearTimeout(holdT); const [a, b] = [...pts.values()]; g = { pinch: Math.hypot(a[0] - b[0], a[1] - b[1]), dz: R.dz }; return; }
    const r = vf.getBoundingClientRect();
    g = { x0: e.clientX, y0: e.clientY, x: e.clientX - r.left, y: e.clientY - r.top, ev0: R.evUser, moved: false, focusVisible: $('focus').classList.contains('show'), t0: performance.now() };
    holdT = setTimeout(() => {
      if (!g || g.moved) return;
      R.meter = [g.x / R.vfW, 1 - g.y / R.vfH]; R.evUser = 0; meterNow();
      R.aeLock = true; $('aelock').classList.add('show'); showFocus(g.x, g.y); buzz(20); g.held = true;
    }, 650);
  });
  const meterNow = () => { lastMeter = 0; meter(performance.now()); R.evAuto = R.evAuto; };
  vf.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId) || !g) return; pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (g.pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const max = S.facing === 'user' ? 3 : (R.hwZoom?.max || 6);
      R.dz = clamp(g.dz * d / g.pinch, 1, max); applyZoom(); buildZoom(); return;
    }
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.moved && Math.hypot(dx, dy) > 8) { g.moved = true; clearTimeout(holdT); g.kind = g.focusVisible && Math.abs(dy) > Math.abs(dx) ? 'ev' : Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'none'; }
    if (g.kind === 'ev') {
      R.evUser = clamp(g.ev0 - dy / 90, -2, 2); $('focus').classList.add('drag'); sunPos();
      $('evtip').textContent = (R.evUser >= 0 ? '+' : '') + R.evUser.toFixed(1); $('evtip').classList.add('show');
      clearTimeout(hideT); hideT = setTimeout(() => { if (!R.aeLock) $('focus').classList.remove('show'); }, 2600);
    }
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId); clearTimeout(holdT);
    if (!g) return;
    if (g.pinch) { if (!pts.size) g = null; return; }
    $('focus').classList.remove('drag'); setTimeout(() => $('evtip').classList.remove('show'), 700);
    if (g.kind === 'swipe' && !R.rec) { const dx = e.clientX - g.x0; if (Math.abs(dx) > 50) setMode(dx < 0 ? 'photo' : 'video'); }
    else if (!g.moved && !g.held) {
      R.aeLock = false; $('aelock').classList.remove('show');
      R.meter = [g.x / R.vfW, 1 - g.y / R.vfH]; R.evUser = 0; meterNow(); showFocus(g.x, g.y); buzz(5);
    }
    g = null;
  };
  vf.addEventListener('pointerup', end); vf.addEventListener('pointercancel', end);
})();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (R.rec) R.rec.stop(); if (!window.__fakeCam) stopCam(); }
  else if ($('cam').classList.contains('on')) openCam();
});

/* ---------- screens ---------- */
function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id)); }

/* ---------- album ---------- */
let items = [], urls = new Map(), selecting = false, sel = new Set();
const thumbUrl = it => { if (!urls.has(it.id)) urls.set(it.id, URL.createObjectURL(it.thumb)); return urls.get(it.id); };
async function refresh() {
  items = await listMeta();
  const last = items[items.length - 1]; setThumb(last?.thumb || null);
  return items;
}
async function openAlbum() {
  await refresh(); renderGrid(); show('album');
}
function renderGrid() {
  const g = $('agrid'); g.innerHTML = '';
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  [...items].reverse().forEach(it => {
    const c = document.createElement('div'); c.className = 'cell' + (sel.has(it.id) ? ' sel' : ''); c.dataset.id = it.id;
    c.innerHTML = `<img src="${thumbUrl(it)}" loading="lazy" alt="">${it.type === 'video' ? `<span class="k">${fmt(it.dur || 0)}</span>` : ''}${it.live ? '<span class="lv"><svg><use href="#i-live"/></svg></span>' : ''}<i class="ck"></i>`;
    g.appendChild(c);
  });
  $('al-count').textContent = items.length ? items.length + ' 项' : '';
  $('aempty').classList.toggle('show', !items.length);
  $('album').classList.toggle('selecting', selecting);
  $('abar').hidden = selecting; $('abar-sel').hidden = !selecting;
  $('al-sel').textContent = selecting ? '取消' : '选择';
  $('al-selcount').textContent = sel.size ? `已选择 ${sel.size} 项` : '选择项目';
  $('al-share').disabled = $('al-del').disabled = !sel.size;
}
$('agrid').onclick = e => {
  const c = e.target.closest('.cell'); if (!c) return;
  if (selecting) { sel.has(c.dataset.id) ? sel.delete(c.dataset.id) : sel.add(c.dataset.id); renderGrid(); return; }
  openViewer(items.findIndex(i => i.id === c.dataset.id));
};
$('al-sel').onclick = () => { selecting = !selecting; sel.clear(); renderGrid(); };
$('al-back').onclick = () => { selecting = false; sel.clear(); show('cam'); if (!R.ready) openCam(); };
$('al-import').onclick = () => $('importer').click();
$('al-del').onclick = async () => {
  const n = sel.size; if (!n) return;
  if (await asheet(`这些项目将从 Soft Cam 相册中删除，无法恢复`, [{ label: `删除 ${n} 项`, v: 1, danger: true }])) {
    for (const id of sel) { await delItem(id); urls.delete(id); }
    sel.clear(); selecting = false; await refresh(); renderGrid(); toast(`已删除 ${n} 项`);
  }
};
$('al-share').onclick = async () => { const full = await Promise.all([...sel].map(getItem)); shareItems(full); };

async function shareItems(list) {
  const files = [];
  for (const it of list) {
    files.push(new File([it.blob], fname(it.t, extOf(it.blob.type)), { type: it.blob.type || 'image/jpeg' }));
    if (it.live) files.push(new File([it.live], fname(it.t, extOf(it.live.type)).replace('IMG_', 'LIVE_'), { type: it.live.type }));
  }
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); await sleep(250); }
  toast('已下载到本机');
}

/* ---------- viewer ---------- */
let vIdx = 0, vUrls = [];
async function openViewer(i) { vIdx = i; show('viewer'); await renderViewer(); }
async function renderViewer() {
  const strip = $('vstrip'); strip.innerHTML = ''; vUrls.forEach(u => URL.revokeObjectURL(u)); vUrls = [];
  if (!items.length) { show('album'); renderGrid(); return; }
  vIdx = clamp(vIdx, 0, items.length - 1);
  for (let k = vIdx - 1; k <= vIdx + 1; k++) {
    const s = document.createElement('div'); s.className = 'vslide';
    if (k >= 0 && k < items.length) {
      const it = await getItem(items[k].id); if (!it) continue;
      const u = URL.createObjectURL(it.blob); vUrls.push(u);
      if (it.type === 'video') { const v = document.createElement('video'); v.src = u; v.controls = true; v.playsInline = true; v.setAttribute('playsinline', ''); s.appendChild(v); }
      else {
        const img = new Image(); img.src = u; s.appendChild(img);
        if (it.live) { const lu = URL.createObjectURL(it.live); vUrls.push(lu); const v = document.createElement('video'); v.className = 'lv'; v.src = lu; v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); s.appendChild(v); }
      }
      if (k === vIdx) s.dataset.cur = 1;
    }
    strip.appendChild(s);
  }
  strip.style.transition = 'none'; strip.style.transform = 'translateX(-100%)';
  const it = items[vIdx], d = new Date(it.t);
  $('vw-date').textContent = `${d.getMonth() + 1}月${d.getDate()}日`;
  $('vw-time').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  $('vw-live').classList.toggle('show', !!it.live);
  $('vw-edit').style.visibility = it.type === 'photo' ? '' : 'hidden';
  const m = MODELS.find(x => x.id === it.model);
  $('vw-info').textContent = `${m && m.id !== 'raw' ? m.name + ' · ' : ''}${it.w}×${it.h}`;
}
(() => {
  const st = $('vstage'); let g = null, holdT = null;
  const cur = () => $('vstrip').querySelector('[data-cur]');
  const playLive = on => { const s = cur(), v = s?.querySelector('video.lv'); if (!v) return; if (on) { v.currentTime = 0; v.play().catch(() => { }); s.classList.add('playing'); v.onended = () => s.classList.remove('playing'); } else { s.classList.remove('playing'); v.pause(); } };
  st.addEventListener('pointerdown', e => {
    if (e.target.closest('video:not(.lv)') && e.clientY > st.getBoundingClientRect().bottom - 60) return;
    g = { x0: e.clientX, y0: e.clientY, dx: 0 }; st.setPointerCapture(e.pointerId);
    holdT = setTimeout(() => { if (g && Math.abs(g.dx) < 8) { g.live = true; playLive(true); buzz(10); } }, 300);
  });
  st.addEventListener('pointermove', e => {
    if (!g) return; g.dx = e.clientX - g.x0;
    if (Math.abs(g.dx) > 8) { clearTimeout(holdT); $('vstrip').style.transition = 'none'; $('vstrip').style.transform = `translateX(calc(-100% + ${g.dx}px))`; }
  });
  const end = async () => {
    if (!g) return; clearTimeout(holdT);
    if (g.live) playLive(false);
    const dx = g.dx, w = st.clientWidth; g = null;
    const strip = $('vstrip'); strip.style.transition = 'transform .25s ease-out';
    if (dx < -w * .2 && vIdx < items.length - 1) { strip.style.transform = 'translateX(-200%)'; await sleep(250); vIdx++; renderViewer(); }
    else if (dx > w * .2 && vIdx > 0) { strip.style.transform = 'translateX(0)'; await sleep(250); vIdx--; renderViewer(); }
    else strip.style.transform = 'translateX(-100%)';
  };
  st.addEventListener('pointerup', end); st.addEventListener('pointercancel', end);
})();
$('vw-back').onclick = () => { vUrls.forEach(u => URL.revokeObjectURL(u)); vUrls = []; $('vstrip').innerHTML = ''; renderGrid(); show('album'); };
$('vw-share').onclick = async () => shareItems([await getItem(items[vIdx].id)]);
$('vw-del').onclick = async () => {
  const it = items[vIdx];
  if (await asheet(it.live ? '这张实况照片将被删除' : '', [{ label: it.type === 'video' ? '删除视频' : '删除照片', v: 1, danger: true }])) {
    await delItem(it.id); urls.delete(it.id); await refresh(); renderViewer();
  }
};
$('vw-edit').onclick = async () => { const it = await getItem(items[vIdx].id); openEditor({ kind: 'image', blob: it.orig || it.blob, item: it }); };

/* ---------- editor (import + re-edit) ---------- */
let edLens = null; try { edLens = createLens($('ed-gl')); } catch { }
const E = { queue: [], cur: null, P: null, src: null, faces: [], raf: 0, video: null };
$('importer').onchange = async e => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  E.queue.push(...files.map(f => ({ kind: f.type.startsWith('video') ? 'video' : 'image', blob: f, name: f.name })));
  if (!E.cur) nextEdit();
};
function nextEdit() { const j = E.queue.shift(); if (j) openEditor(j); else { E.cur = null; openAlbum(); } }
async function openEditor(job) {
  E.cur = job; cancelAnimationFrame(E.raf);
  const base = job.item?.params || { model: S.model, filter: S.filter, strength: S.strength / 100, blur: S.blur / 100, noise: S.noise / 100, slim: S.slim / 100 };
  E.P = { model: 'raw', filter: 'soft', strength: Math.round(base.strength * 100), blur: Math.round(base.blur * 100), noise: Math.round(base.noise * 100), slim: Math.round(base.slim * 100), date: !!base.date };
  $('ed-title').textContent = job.item ? '编辑' : job.kind === 'video' ? '导入视频' : '导入照片' + (E.queue.length ? `（还有 ${E.queue.length}）` : '');
  $('ed-save').textContent = job.item ? '完成' : '存储';
  buildSliders($('ed-sliders'), E.P, k => { if (k === 'slim') ensureFaces(); draw(); });
  show('editor');
  E.faces = []; E.facesFor = null;
  if (job.kind === 'image') {
    const img = new Image(); img.decoding = 'async';
    img.src = URL.createObjectURL(job.blob);
    try { await img.decode(); } catch { toast('这张图打不开'); return nextEdit(); }
    E.src = img; E.sw = img.naturalWidth; E.sh = img.naturalHeight; E.video = null;
    ensureFaces(); draw();
  } else {
    const v = document.createElement('video'); v.src = URL.createObjectURL(job.blob); v.muted = true; v.loop = true; v.playsInline = true; v.setAttribute('playsinline', '');
    try { await v.play(); } catch { await new Promise(r => v.onloadeddata = r); }
    E.src = v; E.video = v; E.sw = v.videoWidth; E.sh = v.videoHeight;
    const loop = () => { E.raf = requestAnimationFrame(loop); if (v.readyState >= 2) draw(true); };
    loop();
  }
}
async function ensureFaces() {
  if (E.P.slim <= 0 || E.video || E.facesFor === E.src) return;
  E.facesFor = E.src;
  try { E.faces = await detectImage(E.src, E.sw, E.sh); if (!E.faces.length) toast('没找到人脸'); draw(); } catch { toast('瘦脸模型加载失败'); }
}
function edOpts(w, h, extra) {
  return { model: E.P.model, filter: E.P.filter, strength: E.P.strength / 100, blur: E.P.blur / 100, noise: E.P.noise / 100, slim: E.P.slim / 100, faces: E.faces, width: w, height: h, zoom: 1, instant: true, ...extra };
}
function draw() {
  if (!edLens || !E.src) return;
  const a = E.sw / E.sh, box = $('ed-gl').parentElement.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  let L = Math.min(1200, Math.max(box.width, box.height) * dpr);
  const ml = model(E.P.model).rear; if (ml) L = Math.min(L, ml);
  const w = a >= 1 ? L : L * a, h = a >= 1 ? L / a : L;
  edLens.render(E.src, E.sw, E.sh, edOpts(Math.round(w), Math.round(h), { time: performance.now() / 1000 }));
  const c = $('ed-gl'), sc = Math.min((box.width - 32) / w, (box.height - 12) / h);
  c.style.width = w * sc + 'px'; c.style.height = h * sc + 'px';
}
addEventListener('resize', () => $('editor').classList.contains('on') && !E.video && draw());
function closeEditor() { cancelAnimationFrame(E.raf); if (E.video) { E.video.pause(); URL.revokeObjectURL(E.video.src); } E.video = null; E.src = null; }
$('ed-cancel').onclick = () => { const back = E.cur?.item; closeEditor(); if (back) { E.cur = null; show('viewer'); } else nextEdit(); };
$('ed-save').onclick = async () => {
  const job = E.cur; if (!job || !E.src) return;
  const m = model(E.P.model), now = Date.now(), params = { model: E.P.model, filter: E.P.filter, strength: E.P.strength / 100, blur: E.P.blur / 100, noise: E.P.noise / 100, slim: E.P.slim / 100, date: job.item?.params?.date };
  try {
    if (job.kind === 'image') {
      const [w, h] = outSize(E.sw / E.sh, E.sw, E.sh, 1, m.rear || 4032);
      capLens.render(E.src, E.sw, E.sh, edOpts(w, h, { time: now / 1000 }));
      const blob = await finishPhoto($('capgl'), w, h, m, params.date, job.item?.t || now);
      const thumb = await thumbOf($('capgl'), w, h);
      if (job.item) { Object.assign(job.item, { blob, thumb, params, w, h, model: m.id }); await putItem(job.item); urls.delete(job.item.id); closeEditor(); E.cur = null; await refresh(); show('viewer'); renderViewer(); toast('已存储'); return; }
      const orig = job.blob.size < 12e6 ? job.blob : null;
      await putItem({ id: now + '-' + Math.random().toString(36).slice(2, 6), t: now, type: 'photo', blob, orig, params, thumb, w, h, model: m.id });
    } else await exportVideo(m, params, now);
    closeEditor(); toast('已存到相册'); persist(); nextEdit();
  } catch (e) { console.error(e); toast('保存失败：' + e.message); $('eprog').classList.remove('show'); }
};
async function exportVideo(m, params, now) {
  const v = E.video, mime = pickMime(); if (!mime) throw new Error('浏览器不支持导出视频');
  cancelAnimationFrame(E.raf);
  const a = E.sw / E.sh, L = Math.min(1280, Math.max(E.sw, E.sh), m.rear || 1e9), w = Math.round((a >= 1 ? L : L * a) / 2) * 2, h = Math.round((a >= 1 ? L / a : L) / 2) * 2;
  const prog = $('eprog'); prog.classList.add('show');
  v.loop = false; v.pause(); v.currentTime = 0; await new Promise(r => { v.onseeked = r; setTimeout(r, 800); });
  let audio = [];
  try { const a2 = ac(); E.asrc ||= a2.createMediaElementSource(v); const dest = a2.createMediaStreamDestination(); E.asrc.connect(dest); audio = dest.stream.getAudioTracks(); v.muted = false; } catch { }
  const vs = $('capgl').captureStream(30), st = new MediaStream([...vs.getVideoTracks(), ...audio]);
  const rec = new MediaRecorder(st, { mimeType: mime, videoBitsPerSecond: 8e6 }), parts = [];
  rec.ondataavailable = e => e.data.size && parts.push(e.data);
  const done = new Promise(r => rec.onstop = r);
  let thumb = null;
  rec.start(500); await v.play();
  await new Promise(res => {
    const step = () => {
      if (v.ended || v.paused && v.currentTime > 0) return res();
      capLens.render(v, E.sw, E.sh, edOpts(w, h, { time: performance.now() / 1000 }));
      if (!thumb) thumb = thumbOf($('capgl'), w, h);
      prog.querySelector('i').style.setProperty('--p', (v.currentTime / (v.duration || 1) * 100) + '%');
      requestAnimationFrame(step);
    };
    step(); v.onended = res;
  });
  rec.stop(); await done; vs.getTracks().forEach(t => t.stop()); v.muted = true;
  prog.classList.remove('show');
  await putItem({ id: now + '-' + Math.random().toString(36).slice(2, 6), t: now, type: 'video', blob: new Blob(parts, { type: mime.split(';')[0] }), thumb: await thumb, w, h, dur: v.duration, model: m.id });
}

/* ---------- boot ---------- */
syncUI(); refresh();
requestAnimationFrame(() => { syncUI(); layout(); });
if (!lens) { $('nocam').querySelector('small').textContent = '这台设备不支持 WebGL'; }
else openCam();
if (S.slim > 0 || !navigator.connection?.saveData) setTimeout(() => loadFace().catch(() => { }), 1500);
if ('serviceWorker' in navigator && !DEBUG && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
if (DEBUG) window.__cam = { E, capLens, edOpts, S, R, openCam, shoot, toggleRec, refresh, items: () => items, setMode, pickLens };
