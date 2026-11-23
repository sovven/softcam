const JAW = [132, 172, 150, 361, 397, 379];
const MAXF = 6, HOLD = 900;
let mod = null, fsP = null, vidP = null, imgP = null, vid = null, img = null;
let tracks = [], lastTs = 0;

const base = new URL('../vendor/mp/', import.meta.url).href;
const model = new URL('../vendor/face_landmarker.task', import.meta.url).href;
async function fileset() {
  return fsP ||= (async () => { mod = await import(base + 'vision_bundle.js'); return mod.FilesetResolver.forVisionTasks(base + 'wasm'); })().catch(e => { fsP = null; throw e; });
}
async function make(mode) {
  const fs = await fileset();
  const mk = delegate => mod.FaceLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: model, delegate }, runningMode: mode, numFaces: MAXF, minFaceDetectionConfidence: .3, minFacePresenceConfidence: .3, minTrackingConfidence: .3 });
  try { return await mk('GPU'); } catch { return await mk('CPU'); }
}
export const faceReady = () => !!vid;
export function loadFace() { return vidP ||= make('VIDEO').then(f => (vid = f, true)).catch(e => { vidP = null; throw e; }); }

function toFace(lm, asp) {
  const P = i => [lm[i].x, 1 - lm[i].y];
  return { c: P(2), p: JAW.flatMap(P), r: Math.hypot((lm[234].x - lm[454].x) * asp, lm[234].y - lm[454].y) * .42 };
}

export async function detectImage(source, w, h) {
  imgP ||= make('IMAGE').then(f => (img = f));
  await imgP;
  let res = null; try { res = img.detect(source); } catch (e) { console.warn(e); }
  return ((res && res.faceLandmarks) || []).map(lm => ({ ...toFace(lm, w / h), w: 1 }));
}

export function resetTracks() { tracks = []; lastTs = 0; }

export function trackFace(video, ts) {
  if (!vid || !video.videoWidth) return tracks;
  let res = null; try { res = vid.detectForVideo(video, ts); } catch { }
  const dt = lastTs ? Math.min(200, Math.max(0, ts - lastTs)) : 16; lastTs = ts;
  const asp = video.videoWidth / video.videoHeight;
  const dets = ((res && res.faceLandmarks) || []).map(lm => toFace(lm, asp));
  const dist = (a, b) => Math.hypot((a.c[0] - b.c[0]) * asp, a.c[1] - b.c[1]);
  const pairs = [];
  tracks.forEach((t, ti) => dets.forEach((d, di) => { const e = dist(t, d); if (e < Math.max(t.r, d.r) * 1.6) pairs.push([e, ti, di]); }));
  pairs.sort((a, b) => a[0] - b[0]);
  const tU = new Set(), dU = new Set();
  for (const [, ti, di] of pairs) {
    if (tU.has(ti) || dU.has(di)) continue;
    tU.add(ti); dU.add(di);
    const t = tracks[ti], f = dets[di];
    const k = Math.min(1, .45 + dist(t, f) / (f.r || 1) * 6);
    const c = f.c.map((x, i) => t.c[i] + (x - t.c[i]) * k);
    t.vel = [(c[0] - t.c[0]) * .5, (c[1] - t.c[1]) * .5];
    t.c = c; t.p = f.p.map((x, i) => t.p[i] + (x - t.p[i]) * k); t.r += (f.r - t.r) * k; t.seen = ts;
  }
  dets.forEach((f, di) => { if (!dU.has(di) && tracks.length < MAXF) tracks.push({ ...f, vel: null, seen: ts, w: 0 }); });
  const fade = 1 - Math.exp(-dt / 90);
  for (const t of tracks) {
    const alive = ts - t.seen < HOLD;
    if (alive && t.seen !== ts && t.vel) { const d = Math.max(0, 1 - (ts - t.seen) / 250); t.c = t.c.map((x, i) => x + t.vel[i] * d); t.p = t.p.map((x, i) => x + t.vel[i % 2] * d); }
    t.w += ((alive ? 1 : 0) - t.w) * fade;
  }
  tracks = tracks.filter(t => ts - t.seen < HOLD || t.w > .01);
  return tracks;
}
