// april25th.date — was it light jacket weather?
//
// Custom canvas renderer: each year is a TW×TH equirectangular texture of
// classes (built in js/texture-worker.js), reprojected every frame through
// a projection that morphs Google-Maps-style between an orthographic globe
// (zoomed out) and a flat equal-earth map (zoomed in). Pan is rotation, so
// it is continuous and wraps forever. Styled like pen on a notebook.

// --- tweakables -----------------------------------------------------------
const JACKET_MIN = 55; // °F — below this is "too cold" (keep worker in sync)
const JACKET_MAX = 70; // °F — above this is "too hot"
const MAX_STATION_KM = 500; // beyond this from any station → "no data"
const K_NEIGHBORS = 5; // stations used for tooltip interpolation + CI
const TEX_W = 1800; // texture resolution: 0.2° cells
const TEX_H = 900;
const K_MIN = 0.9; // zoom range; k=1 fits the globe on screen
const K_MAX = 60;
const K_GLOBE = 1.25; // below this: pure globe
const K_FLAT = 2.75; // above this: pure flat map; between: the morph
const LOCATE_K = 6; // zoom after geolocating (≈ continental scale)

// palette — pen on a parchment notebook
const COLOR_BG = "#f0efeb"; // parchment page
const COLOR_OCEAN = "#f0efeb"; // ocean is just the page
const COLOR_COLD = "#cddafd"; // periwinkle
const COLOR_JACKET = "#bee1e6"; // light blue — open skies, pure calm
const COLOR_HOT = "#fad2e1"; // petal frost — warm pink
const COLOR_UNKNOWN = "#eae4e9"; // alabaster grey, hatched
const COLOR_HATCH = "#cfc7bc"; // hatch stroke over unknown
const INK = "#3f3a33";
const INK_BORDER = "rgba(63,58,51,0.55)";
const INK_STATE = "rgba(63,58,51,0.32)";
const INK_GRID = "rgba(63,58,51,0.10)";
const TEXT_COLD = "#6b83c4"; // legible ink versions for tooltip text
const TEXT_JACKET = "#4f8a96";
const TEXT_HOT = "#c96f88";
// ---------------------------------------------------------------------------

const DEG = 180 / Math.PI;
const DPR_CAP = 1.5;

let land = null;
let countryBorders = null;
let admin1Lines = null;
let countryLabels = [];
let stateLabels = [];
let cityLabels = [];
let manifest = null;
let landMask = null;
let texture = null; // current year's class grid
let currentRows = []; // current year's stations, for the tooltip
let view = { lon: -30, lat: 25, k: 1 };
let canvas = null;
let ctx = null;
let off = null; // offscreen canvas the raster is rendered into
let offCtx = null;
let cssW = 0;
let cssH = 0;
let stars = [];
let interacting = false;
let idleTimer = 0;
let drawQueued = false;
let wantFull = false;
let worker = null;

const yearCache = new Map(); // year -> row promise
const texCache = new Map(); // year -> Uint8Array (small LRU)

function loadYear(year) {
  if (!yearCache.has(year)) {
    yearCache.set(
      year,
      d3.csv(`./data/${year}.csv`, d3.autoType).catch((err) => {
        yearCache.delete(year);
        throw err;
      })
    );
  }
  return yearCache.get(year);
}

// --- projection ------------------------------------------------------------

// Normalize equal-earth so its scale at the map center matches the unit
// sphere of the orthographic raw — the morph then keeps the center steady.
const E_NORM = d3.geoEqualEarthRaw(1e-4, 0)[0] / 1e-4;
const normEqualEarthRaw = (l, p) => {
  const q = d3.geoEqualEarthRaw(l, p);
  return [q[0] / E_NORM, q[1] / E_NORM];
};
normEqualEarthRaw.invert = (x, y) =>
  d3.geoEqualEarthRaw.invert(x * E_NORM, y * E_NORM);

function morphT(k) {
  const u = Math.max(0, Math.min(1, (k - K_GLOBE) / (K_FLAT - K_GLOBE)));
  return u * u * (3 - 2 * u); // smoothstep
}

function blendRaw(t) {
  if (t <= 0) return d3.geoOrthographicRaw;
  if (t >= 1) return normEqualEarthRaw;
  const o = d3.geoOrthographicRaw;
  const e = normEqualEarthRaw;
  const raw = (l, p) => {
    const a = o(l, p);
    const b = e(l, p);
    return [(1 - t) * a[0] + t * b[0], (1 - t) * a[1] + t * b[1]];
  };
  // Numeric Newton inversion of the blend. The visible longitude range
  // grows from a hemisphere (t=0) to the whole world (t=1) as it unrolls.
  const lonLimit = Math.PI * (0.5 + 0.5 * t);
  raw.invert = (x, y) => {
    let g = t < 0.5 ? o.invert(x, y) : e.invert(x, y);
    if (!g || !isFinite(g[0]) || !isFinite(g[1])) g = [0, 0];
    let l = g[0];
    let p = g[1];
    for (let i = 0; i < 10; i++) {
      const f = raw(l, p);
      const dx = x - f[0];
      const dy = y - f[1];
      if (dx * dx + dy * dy < 1e-12) break;
      const h = 1e-5;
      const fl = raw(l + h, p);
      const fp = raw(l, p + h);
      const a = (fl[0] - f[0]) / h;
      const b = (fp[0] - f[0]) / h;
      const c = (fl[1] - f[1]) / h;
      const d = (fp[1] - f[1]) / h;
      const det = a * d - b * c;
      if (!det) break;
      l += Math.max(-0.5, Math.min(0.5, (dx * d - dy * b) / det));
      p += Math.max(-0.5, Math.min(0.5, (dy * a - dx * c) / det));
    }
    if (Math.abs(l) > lonLimit || Math.abs(p) > Math.PI / 2 + 1e-6)
      return [NaN, NaN];
    return [l, p];
  };
  return raw;
}

// px per radian at the view center, in css pixels
function centerScale() {
  return (Math.min(cssW, cssH) / 2 - 8) * view.k;
}

function makeProjection(w, h, pxScale) {
  const t = morphT(view.k);
  const p = d3
    .geoProjection(blendRaw(t))
    .rotate([-view.lon, -view.lat])
    .scale(centerScale() * pxScale)
    .translate([w / 2, h / 2])
    .precision(0.5);
  if (t < 1) p.clipAngle(Math.min(179.9, 90 + 90 * t));
  p.morphT = t;
  return p;
}

function invertClient(clientX, clientY) {
  if (!canvas) return null;
  const r = canvas.getBoundingClientRect();
  const proj = makeProjection(cssW, cssH, 1);
  const ll = proj.invert([clientX - r.left, clientY - r.top]);
  if (!ll || !isFinite(ll[0]) || !isFinite(ll[1])) return null;
  const rt = proj(ll); // round-trip: reject off-globe junk
  if (
    !rt ||
    Math.hypot(rt[0] - (clientX - r.left), rt[1] - (clientY - r.top)) > 2
  )
    return null;
  return ll;
}

// --- raster renderer -------------------------------------------------------

function hexToU32(hex) {
  const v = parseInt(hex.slice(1), 16);
  return (255 << 24) | ((v & 255) << 16) | (v & 0xff00) | (v >> 16);
}
const PALETTE = new Uint32Array([
  hexToU32(COLOR_OCEAN),
  hexToU32(COLOR_COLD),
  hexToU32(COLOR_JACKET),
  hexToU32(COLOR_HOT),
  hexToU32(COLOR_UNKNOWN),
]);
const BG_U32 = hexToU32(COLOR_BG);
const HATCH_U32 = hexToU32(COLOR_HATCH);

let imgCache = { w: 0, h: 0, img: null, pix: null };

function texLookup(lonRad, latRad) {
  let u = (((lonRad * DEG + 180) / 360) * TEX_W) | 0;
  let v = (((90 - latRad * DEG) / 180) * TEX_H) | 0;
  if (u < 0) u = 0;
  else if (u >= TEX_W) u = TEX_W - 1;
  if (v < 0) v = 0;
  else if (v >= TEX_H) v = TEX_H - 1;
  return texture[v * TEX_W + u];
}

// class → pixel, with a diagonal pen hatch over "no data"
function shade(cls, px, py) {
  if (cls === 4 && (px + py) % 6 === 0) return HATCH_U32;
  return PALETTE[cls];
}

function renderRaster(w, h, proj) {
  if (imgCache.w !== w || imgCache.h !== h) {
    const img = offCtx.createImageData(w, h);
    imgCache = { w, h, img, pix: new Uint32Array(img.data.buffer) };
  }
  const pix = imgCache.pix;
  const Q = 16; // mesh cell size in raster px
  const nx = Math.floor(w / Q) + 2;
  const ny = Math.floor(h / Q) + 2;
  const vx = new Float32Array(nx * ny);
  const vy = new Float32Array(nx * ny);
  const vz = new Float32Array(nx * ny);
  const ok = new Uint8Array(nx * ny);
  const pt = [0, 0];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      pt[0] = i * Q;
      pt[1] = j * Q;
      const ll = proj.invert(pt);
      if (!ll || !isFinite(ll[0]) || !isFinite(ll[1])) continue;
      const rt = proj(ll);
      if (!rt || Math.hypot(rt[0] - pt[0], rt[1] - pt[1]) > 1.5) continue;
      const m = j * nx + i;
      const lo = ll[0] / DEG;
      const la = ll[1] / DEG;
      vx[m] = Math.cos(la) * Math.cos(lo);
      vy[m] = Math.cos(la) * Math.sin(lo);
      vz[m] = Math.sin(la);
      ok[m] = 1;
    }
  }
  const COS_MAX = Math.cos(12 / DEG);
  for (let j = 0; j < ny - 1; j++) {
    const y0 = j * Q;
    const y1 = Math.min(h, y0 + Q);
    for (let i = 0; i < nx - 1; i++) {
      const x0 = i * Q;
      const x1 = Math.min(w, x0 + Q);
      if (x0 >= w || y0 >= h) continue;
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      const nOk = ok[a] + ok[b] + ok[c] + ok[d];
      if (nOk === 0) {
        for (let py = y0; py < y1; py++)
          for (let px = x0, k = py * w + x0; px < x1; px++, k++)
            pix[k] = BG_U32;
        continue;
      }
      const flat =
        nOk === 4 &&
        vx[a] * vx[d] + vy[a] * vy[d] + vz[a] * vz[d] > COS_MAX &&
        vx[b] * vx[c] + vy[b] * vy[c] + vz[b] * vz[c] > COS_MAX;
      if (flat) {
        // bilinear interpolation of unit vectors across the mesh cell
        for (let py = y0; py < y1; py++) {
          const fy = (py - y0) / Q;
          const lx = vx[a] + (vx[c] - vx[a]) * fy;
          const ly = vy[a] + (vy[c] - vy[a]) * fy;
          const lz = vz[a] + (vz[c] - vz[a]) * fy;
          const rx = vx[b] + (vx[d] - vx[b]) * fy;
          const ry = vy[b] + (vy[d] - vy[b]) * fy;
          const rz = vz[b] + (vz[d] - vz[b]) * fy;
          for (let px = x0, k = py * w + x0; px < x1; px++, k++) {
            const fx = (px - x0) / Q;
            const X = lx + (rx - lx) * fx;
            const Y = ly + (ry - ly) * fx;
            const Z = lz + (rz - lz) * fx;
            const lonR = Math.atan2(Y, X);
            const latR = Math.asin(Z / Math.sqrt(X * X + Y * Y + Z * Z));
            pix[k] = shade(texLookup(lonR, latR), px, py);
          }
        }
      } else {
        // horizon/edge cells: exact per-pixel inversion
        for (let py = y0; py < y1; py++) {
          for (let px = x0, k = py * w + x0; px < x1; px++, k++) {
            pt[0] = px + 0.5;
            pt[1] = py + 0.5;
            const ll = proj.invert(pt);
            if (!ll || !isFinite(ll[0]) || !isFinite(ll[1])) {
              pix[k] = BG_U32;
              continue;
            }
            const rt = proj(ll);
            if (!rt || Math.hypot(rt[0] - pt[0], rt[1] - pt[1]) > 1.5) {
              pix[k] = BG_U32;
              continue;
            }
            pix[k] = shade(texLookup(ll[0] / DEG, ll[1] / DEG), px, py);
          }
        }
      }
    }
  }
  offCtx.putImageData(imgCache.img, 0, 0);
}

// --- overlays: stars, grid, borders, labels --------------------------------

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeStars() {
  const rand = mulberry32(425); // deterministic, made-up sky
  const n = Math.round((cssW * cssH) / 9000);
  stars = [];
  for (let i = 0; i < n; i++) {
    stars.push({
      x: rand(),
      y: rand(),
      r: 0.4 + rand() * 1.1,
      a: 0.2 + rand() * 0.5,
      sparkle: rand() < 0.09,
    });
  }
}

function drawStars(dpr, t) {
  if (t >= 1) return;
  const R = centerScale() * dpr + 10 * dpr; // stay outside the horizon
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const fade = (1 - t) ** 2;
  ctx.save();
  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;
  for (const s of stars) {
    const x = s.x * canvas.width;
    const y = s.y * canvas.height;
    if (Math.hypot(x - cx, y - cy) < R) continue;
    ctx.globalAlpha = s.a * fade;
    ctx.beginPath();
    ctx.arc(x, y, s.r * dpr, 0, 2 * Math.PI);
    ctx.fill();
    if (s.sparkle) {
      const L = 3.5 * dpr;
      ctx.globalAlpha = s.a * fade * 0.6;
      ctx.lineWidth = 0.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(x - L, y);
      ctx.lineTo(x + L, y);
      ctx.moveTo(x, y - L);
      ctx.lineTo(x, y + L);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function gridStep(k) {
  return k < 3 ? 10 : k < 6 ? 5 : k < 12 ? 2 : k < 22 ? 1 : k < 40 ? 0.5 : 0.2;
}

// visible lon/lat window (lon may extend past ±180); null = whole world
function visibleBounds(proj) {
  let dMin = Infinity;
  let dMax = -Infinity;
  let laMin = 90;
  let laMax = -90;
  for (let j = 0; j <= 4; j++) {
    for (let i = 0; i <= 4; i++) {
      const x = (canvas.width * i) / 4;
      const y = (canvas.height * j) / 4;
      const ll = proj.invert([x, y]);
      if (!ll || !isFinite(ll[0]) || !isFinite(ll[1])) return null;
      const rt = proj(ll);
      if (!rt || Math.hypot(rt[0] - x, rt[1] - y) > 3) return null;
      const d = wrapLon(ll[0] - view.lon);
      if (d < dMin) dMin = d;
      if (d > dMax) dMax = d;
      if (ll[1] < laMin) laMin = ll[1];
      if (ll[1] > laMax) laMax = ll[1];
    }
  }
  return {
    lon0: view.lon + dMin - 2,
    lon1: view.lon + dMax + 2,
    lat0: Math.max(-90, laMin - 2),
    lat1: Math.min(90, laMax + 2),
  };
}

function drawLabels(proj, dpr) {
  const k = view.k;
  const clipRad = (90 + 90 * proj.morphT) / DEG - 0.06;
  const center = [view.lon, view.lat];
  const placed = [];
  const collides = (r) => {
    for (const q of placed)
      if (
        r[0] < q[0] + q[2] &&
        r[0] + r[2] > q[0] &&
        r[1] < q[1] + q[3] &&
        r[1] + r[3] > q[1]
      )
        return true;
    return false;
  };
  const put = (lon, lat, text, font, color, dot) => {
    if (d3.geoDistance([lon, lat], center) > clipRad) return;
    const p = proj([lon, lat]);
    if (
      !p ||
      p[0] < -60 ||
      p[0] > canvas.width + 60 ||
      p[1] < -20 ||
      p[1] > canvas.height + 20
    )
      return;
    ctx.font = font;
    const w = ctx.measureText(text).width;
    const hh = 9 * dpr;
    const rect = dot
      ? [p[0] - 3 * dpr, p[1] - hh, w + 9 * dpr, hh * 2]
      : [p[0] - w / 2 - 3, p[1] - hh, w + 6, hh * 2];
    if (collides(rect)) return;
    placed.push(rect);
    ctx.fillStyle = color;
    if (dot) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], 1.4 * dpr, 0, 2 * Math.PI);
      ctx.fill();
      ctx.textAlign = "left";
      ctx.fillText(text, p[0] + 5 * dpr, p[1] - 1 * dpr);
    } else {
      ctx.textAlign = "center";
      ctx.fillText(text, p[0], p[1]);
    }
  };
  ctx.textBaseline = "middle";
  try {
    ctx.letterSpacing = `${0.8 * dpr}px`;
  } catch (e) {}
  if (k < 30) {
    const maxN = k < 2 ? 40 : k < 4 ? 90 : 300;
    const size = Math.round(Math.min(16, 10.5 + k * 0.6) * dpr);
    const font = `600 ${size}px Georgia, serif`;
    for (const c of countryLabels.slice(0, maxN))
      put(c.lon, c.lat, c.name.toUpperCase(), font, "rgba(63,58,51,0.78)");
  }
  try {
    ctx.letterSpacing = "0px";
  } catch (e) {}
  if (k >= 4.5) {
    const font = `italic ${Math.round(12 * dpr)}px Georgia, serif`;
    for (const s of stateLabels)
      put(s.lon, s.lat, s.name, font, "rgba(63,58,51,0.6)");
  }
  if (k >= 5) {
    const maxRank = k < 8 ? 0 : k < 11 ? 1 : k < 15 ? 3 : k < 22 ? 5 : k < 32 ? 7 : 10;
    const font = `italic ${Math.round(11 * dpr)}px Georgia, serif`;
    let drawn = 0;
    for (const c of cityLabels) {
      if (c.rank > maxRank) break; // sorted by rank, then population
      put(c.lon, c.lat, c.name, font, INK, true);
      if (++drawn >= 90) break;
    }
  }
}

function drawVectors(dpr) {
  const proj = makeProjection(canvas.width, canvas.height, dpr);
  const path = d3.geoPath(proj, ctx);
  drawStars(dpr, proj.morphT);
  // the grid — notebook ruling that densifies as you zoom in
  const step = gridStep(view.k);
  const grat = d3.geoGraticule().step([step, step]);
  if (step < 10) {
    const b = visibleBounds(proj);
    if (b) grat.extent([[b.lon0, b.lat0], [b.lon1, b.lat1]]);
  }
  ctx.beginPath();
  path(grat());
  ctx.lineWidth = 0.55 * dpr;
  ctx.strokeStyle = INK_GRID;
  ctx.stroke();
  // state/province borders: dashed pen lines
  if (view.k >= 3.5 && admin1Lines) {
    ctx.save();
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.beginPath();
    path(admin1Lines);
    ctx.lineWidth = 0.6 * dpr;
    ctx.strokeStyle = INK_STATE;
    ctx.stroke();
    ctx.restore();
  }
  // country borders
  ctx.beginPath();
  path(countryBorders);
  ctx.lineWidth = 0.7 * dpr;
  ctx.strokeStyle = INK_BORDER;
  ctx.stroke();
  // coastlines
  ctx.beginPath();
  path(land);
  ctx.lineWidth = 0.8 * dpr;
  ctx.strokeStyle = INK;
  ctx.stroke();
  // the horizon
  ctx.beginPath();
  path({ type: "Sphere" });
  ctx.lineWidth = 1 * dpr;
  ctx.strokeStyle = "rgba(63,58,51,0.7)";
  ctx.stroke();
  drawLabels(proj, dpr);
}

function draw(full) {
  if (!canvas || !texture) return;
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  const scale = full ? dpr : 0.5; // fast frames render the raster at half res
  const w = Math.max(2, Math.round(cssW * scale));
  const h = Math.max(2, Math.round(cssH * scale));
  if (off.width !== w || off.height !== h) {
    off.width = w;
    off.height = h;
  }
  renderRaster(w, h, makeProjection(w, h, scale));
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  drawVectors(dpr);
}

function requestDraw(full) {
  wantFull = wantFull || full;
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    const f = wantFull;
    wantFull = false;
    draw(f);
  });
}

// --- hover -----------------------------------------------------------------

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// Brute-force k-nearest — ~11k haversines is well under a millisecond.
function kNearest(rows, lat, lon, k) {
  const best = [];
  for (const r of rows) {
    const dist = haversineKm(lat, lon, r.lat, r.lon);
    if (best.length < k || dist < best[best.length - 1].dist) {
      let i = best.length;
      while (i > 0 && best[i - 1].dist > dist) i--;
      best.splice(i, 0, { ...r, dist });
      if (best.length > k) best.pop();
    }
  }
  return best;
}

function classify(temp) {
  if (temp < JACKET_MIN) return { label: "Too cold", color: TEXT_COLD };
  if (temp > JACKET_MAX) return { label: "Too hot", color: TEXT_HOT };
  return { label: "All you need is a light jacket ✓", color: TEXT_JACKET };
}

// IDW estimate at a cell from this year's stations, with CI and nearest
function cellEstimate(lat, lon, rows) {
  const near = kNearest(rows, lat, lon, K_NEIGHBORS);
  if (near.length === 0 || near[0].dist > MAX_STATION_KM) return null;
  const w = near.map((n) => 1 / Math.max(n.dist, 1) ** 2);
  const W = d3.sum(w);
  const temp = d3.sum(near, (n, i) => w[i] * n.temp) / W;
  const precip = d3.sum(near, (n, i) => w[i] * n.precip) / W;
  const sd = Math.sqrt(d3.sum(near, (n, i) => w[i] * (n.temp - temp) ** 2) / W);
  const ci = 1.96 * sd * (1 + near[0].dist / MAX_STATION_KM);
  return { temp, precip, ci, nearest: near[0] };
}

// one pen-note line: "62.4 °F — all you need is a light jacket"
function tooltipHtml(lat, lon, rows) {
  const est = cellEstimate(lat, lon, rows);
  if (!est) return null;
  const v = classify(est.temp);
  return `${est.temp.toFixed(1)} °F — ${v.label.toLowerCase().replace(" ✓", "")}`;
}

// --- click history ---------------------------------------------------------

let hist = null;
let histPromise = null;

// data/history.bin: per-station lat/lon + int8 temps for 1930-2025
function ensureHistory() {
  if (!histPromise) {
    histPromise = fetch("./data/history.bin")
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const dv = new DataView(buf);
        const n = dv.getUint32(0, true);
        const y0 = dv.getUint16(4, true);
        const ny = dv.getUint16(6, true);
        const lats = new Float32Array(n);
        const lons = new Float32Array(n);
        const temps = new Int8Array(n * ny);
        const stride = 8 + ny;
        for (let i = 0; i < n; i++) {
          const off = 8 + i * stride;
          lats[i] = dv.getFloat32(off, true);
          lons[i] = dv.getFloat32(off + 4, true);
          temps.set(new Int8Array(buf, off + 8, ny), i * ny);
        }
        hist = { n, y0, ny, lats, lons, temps };
        return hist;
      });
  }
  return histPromise;
}

// yearly IDW estimate at a cell from the k nearest reporting stations
function historySeries(lat, lon) {
  const n = hist.n;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++)
    d[i] = haversineKm(lat, lon, hist.lats[i], hist.lons[i]);
  const idx = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => d[a] - d[b])
    .slice(0, 40);
  const out = [];
  for (let y = 0; y < hist.ny; y++) {
    let wsum = 0;
    let tsum = 0;
    let used = 0;
    for (const i of idx) {
      if (d[i] > MAX_STATION_KM) break; // idx is sorted by distance
      const v = hist.temps[i * hist.ny + y];
      if (v === -128) continue;
      const w = 1 / Math.max(d[i], 1) ** 2;
      wsum += w;
      tsum += w * v;
      if (++used >= K_NEIGHBORS) break;
    }
    if (used > 0) out.push({ year: hist.y0 + y, temp: tsum / wsum });
  }
  return out;
}

const QUIPS = {
  perfect: [
    (p) => `Exactly what Miss Rhode Island had in mind: ${p.j}% of April 25ths here called for just a light jacket.`,
    (p) => `The perfect date, practically guaranteed. Light-jacket weather ${p.j}% of the time.`,
    (p) => `This spot LOVEs April 25th. Bring the light jacket, need nothing else.`,
  ],
  usuallyJacket: [
    (p) => `Most years, all you need here is a light jacket (${p.j}% of Aprils on record).`,
    (p) => `Usually just right. Pack the light jacket with confidence.`,
  ],
  alwaysHot: [
    () => `Historically too hot. Less light jacket and more sun screen.`,
    (p) => `Leave the jacket at home. It's been too hot ${p.h}% of Aprils.`,
  ],
  usuallyHot: [
    (p) => `More often than not, too hot (${p.h}% of years). The jacket would be a choice.`,
    () => `Usually too hot. Maybe a linen overshirt.`,
  ],
  alwaysCold: [
    () => `Historically too cold. Maybe bring a fur coat instead?`,
    (p) => `Don't be caught in a light jacket. It's too cold ${p.c}% of Aprils on record.`,
  ],
  usuallyCold: [
    (p) => `Usually too cold (${p.c}% of years). The light jacket will need backup.`,
    () => `Most Aprils, the light jacket alone won't cut it. Bring layers.`,
  ],
  mixed: [
    (p) => `${p.c}% too cold, ${p.h}% too hot, ${p.j}% light jacket weather. Pack options.`,
    () => `April 25th here is a coin flip. Layers are your friend.`,
  ],
  sparse: [
    (p) => `Only ${p.n} Aprils on record near here. Not enough to call it.`,
  ],
};

function quipFor(series, lat, lon) {
  const n = series.length;
  if (n === 0) return "No weather stations close enough. Terra incognita.";
  const c = series.filter((s) => s.temp < JACKET_MIN).length;
  const h = series.filter((s) => s.temp > JACKET_MAX).length;
  const j = n - c - h;
  const p = {
    n,
    c: Math.round((100 * c) / n),
    j: Math.round((100 * j) / n),
    h: Math.round((100 * h) / n),
  };
  let pool;
  if (n < 8) pool = QUIPS.sparse;
  else if (j / n >= 0.85) pool = QUIPS.perfect;
  else if (h / n >= 0.85) pool = QUIPS.alwaysHot;
  else if (c / n >= 0.85) pool = QUIPS.alwaysCold;
  else if (j / n >= 0.55) pool = QUIPS.usuallyJacket;
  else if (h / n >= 0.55) pool = QUIPS.usuallyHot;
  else if (c / n >= 0.55) pool = QUIPS.usuallyCold;
  else pool = QUIPS.mixed;
  const hash = Math.abs(
    (Math.round(lat * 10) * 73856093) ^ (Math.round(lon * 10) * 19349663)
  );
  let text = pool[hash % pool.length](p);
  // a wry climate note when the record has drifted
  if (n >= 30) {
    const half = Math.floor(n / 2);
    const early = d3.mean(series.slice(0, half), (s) => s.temp);
    const late = d3.mean(series.slice(-half), (s) => s.temp);
    if (late - early >= 2.5) text += " It has been running warmer lately.";
    else if (early - late >= 2.5) text += " It has been running colder lately.";
  }
  return text;
}

function renderHistoryChart(series) {
  const el = document.getElementById("history-chart");
  if (series.length === 0) {
    el.replaceChildren();
    return;
  }
  const temps = series.map((s) => s.temp);
  const lo = Math.min(Math.min(...temps) - 4, JACKET_MIN - 6);
  const hi = Math.max(Math.max(...temps) + 4, JACKET_MAX + 6);
  const w = el.clientWidth || 330;
  const fig = Plot.plot({
    width: w,
    height: Math.round(Math.max(170, Math.min(w * 0.52, 380))),
    marginLeft: 32,
    marginBottom: 22,
    style: {
      background: "transparent",
      fontFamily: "Georgia, serif",
      color: "#6d675e",
      fontSize: "10px",
    },
    x: { domain: [1928, 2027], tickFormat: (d) => String(d), label: null },
    y: { domain: [lo, hi], label: "°F", grid: false },
    marks: [
      Plot.rect([{ y1: lo, y2: JACKET_MIN }], {
        x1: 1928, x2: 2027, y1: "y1", y2: "y2",
        fill: COLOR_COLD, fillOpacity: 0.45,
      }),
      Plot.rect([{ y1: JACKET_MIN, y2: JACKET_MAX }], {
        x1: 1928, x2: 2027, y1: "y1", y2: "y2",
        fill: COLOR_JACKET, fillOpacity: 0.5,
      }),
      Plot.rect([{ y1: JACKET_MAX, y2: hi }], {
        x1: 1928, x2: 2027, y1: "y1", y2: "y2",
        fill: COLOR_HOT, fillOpacity: 0.45,
      }),
      Plot.line(series, {
        x: "year", y: "temp",
        stroke: INK, strokeWidth: 0.8, strokeOpacity: 0.7,
      }),
      Plot.dot(series, { x: "year", y: "temp", r: 1.2, fill: INK }),
    ],
  });
  el.replaceChildren(fig);
}

// --- helpers ---------------------------------------------------------------

function debounce(fn, ms) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

function wrapLon(l) {
  return ((((l + 180) % 360) + 360) % 360) - 180;
}

function clampLat(l) {
  return Math.max(-85, Math.min(85, l));
}

function interactingPulse() {
  interacting = true;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    interacting = false;
    requestDraw(true);
  }, 200);
}

function buildLandMask() {
  const c = document.createElement("canvas");
  c.width = TEX_W;
  c.height = TEX_H;
  const cx = c.getContext("2d", { willReadFrequently: true });
  const eq = d3
    .geoEquirectangular()
    .scale(TEX_W / (2 * Math.PI))
    .translate([TEX_W / 2, TEX_H / 2]);
  cx.fillStyle = "#000";
  cx.beginPath();
  d3.geoPath(eq, cx)(land);
  cx.fill();
  const data = cx.getImageData(0, 0, TEX_W, TEX_H).data;
  landMask = new Uint8Array(TEX_W * TEX_H);
  for (let i = 0; i < landMask.length; i++)
    landMask[i] = data[i * 4 + 3] > 127 ? 1 : 0;
}

// --- app -------------------------------------------------------------------

document.addEventListener("alpine:init", () => {
  Alpine.data("april25", () => ({
    year: 2025,
    stationCount: 0,
    loading: true,
    tooltip: { show: false, x: 0, y: 0, html: "" },
    panel: { show: false, title: "", summary: "", detail: "", note: "" },

    async init() {
      const [topo, mf, admin1, states, cities] = await Promise.all([
        d3.json("./data/countries-50m.json"),
        d3.json("./data/manifest.json"),
        d3.json("./data/admin1-lines.json"),
        d3.csv("./data/states.csv", d3.autoType),
        d3.csv("./data/cities.csv", d3.autoType),
      ]);
      land = topojson.feature(topo, topo.objects.land);
      countryBorders = topojson.mesh(
        topo,
        topo.objects.countries,
        (a, b) => a !== b
      );
      countryLabels = topojson
        .feature(topo, topo.objects.countries)
        .features.map((f) => {
          const [lon, lat] = d3.geoCentroid(f);
          return { name: f.properties.name, lon, lat, area: d3.geoArea(f) };
        })
        .sort((a, b) => b.area - a.area);
      admin1Lines = admin1;
      stateLabels = states;
      cityLabels = cities;
      manifest = mf;
      buildLandMask();
      // gray placeholder until the first real texture lands
      texture = Uint8Array.from(landMask, (m) => (m ? 4 : 0));

      worker = new Worker("./js/texture-worker.js?v=3");
      worker.postMessage({ type: "init", tw: TEX_W, th: TEX_H, landMask });
      worker.onmessage = (e) => {
        texCache.set(e.data.year, e.data.classes);
        if (texCache.size > 16)
          texCache.delete(texCache.keys().next().value);
        if (e.data.year === this.year) {
          texture = e.data.classes;
          this.loading = false;
          requestDraw(true);
        }
      };

      canvas = document.getElementById("globe");
      ctx = canvas.getContext("2d");
      off = document.createElement("canvas");
      offCtx = off.getContext("2d");
      this.resize();
      this.setupGestures();
      this.setupHover();
      await this.setYear(this.year);
      this.locate();
      window.addEventListener(
        "resize",
        debounce(() => this.resize(), 150)
      );
    },

    resize() {
      const wrap = document.getElementById("map-wrap");
      cssW = wrap.clientWidth;
      cssH = wrap.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
      makeStars();
      requestDraw(true);
    },

    onYearInput: debounce(function () {
      this.setYear(this.year);
    }, 150),

    async setYear(year) {
      this.loading = true;
      const rows = await loadYear(year);
      if (year !== this.year) return;
      currentRows = rows;
      this.stationCount = rows.length;
      if (texCache.has(year)) {
        texture = texCache.get(year);
        this.loading = false;
        requestDraw(true);
        return;
      }
      const n = rows.length;
      const la = new Float64Array(n);
      const lo = new Float64Array(n);
      const te = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        la[i] = rows[i].lat;
        lo[i] = rows[i].lon;
        te[i] = rows[i].temp;
      }
      worker.postMessage({ type: "year", year, lat: la, lon: lo, temp: te }, [
        la.buffer,
        lo.buffer,
        te.buffer,
      ]);
      // old texture stays on screen until the worker replies
    },

    // drag to pan (rotation — continuous, wraps), scroll/pinch to zoom
    setupGestures() {
      const pointers = new Map();
      let pinchDist = 0;
      let press = null; // for click-vs-drag detection
      canvas.style.touchAction = "none";
      canvas.style.cursor = "grab";

      canvas.addEventListener("pointerdown", (e) => {
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch (err) {} // synthetic pointers can't always be captured
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
          press = { x: e.clientX, y: e.clientY, moved: false, multi: false };
        } else {
          if (press) press.multi = true;
          const [p1, p2] = [...pointers.values()];
          pinchDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        }
        canvas.style.cursor = "grabbing";
        this.tooltip.show = false;
      });

      canvas.addEventListener("pointermove", (e) => {
        const p = pointers.get(e.pointerId);
        if (!p) return;
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;
        p.x = e.clientX;
        p.y = e.clientY;
        if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6)
          press.moved = true;
        if (pointers.size === 1) {
          this.pan(dx, dy);
        } else if (pointers.size === 2) {
          const [p1, p2] = [...pointers.values()];
          const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
          const mx = (p1.x + p2.x) / 2;
          const my = (p1.y + p2.y) / 2;
          this.pan(dx / 2, dy / 2);
          if (pinchDist > 0) this.zoomAt(mx, my, dist / pinchDist);
          pinchDist = dist;
        }
      });

      canvas.addEventListener("pointerup", (e) => {
        pointers.delete(e.pointerId);
        if (pointers.size === 0) {
          canvas.style.cursor = "grab";
          if (press && !press.moved && !press.multi)
            this.openCell(e.clientX, e.clientY);
          press = null;
        }
      });
      canvas.addEventListener("pointercancel", (e) => {
        pointers.delete(e.pointerId);
        if (pointers.size === 0) {
          canvas.style.cursor = "grab";
          press = null;
        }
      });

      canvas.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.002));
          this.tooltip.show = false;
        },
        { passive: false }
      );

      canvas.addEventListener("dblclick", (e) => {
        this.zoomAt(e.clientX, e.clientY, 2);
      });
    },

    pan(dx, dy) {
      const degPerPx = DEG / centerScale();
      view.lon = wrapLon(view.lon - dx * degPerPx);
      view.lat = clampLat(view.lat + dy * degPerPx);
      interactingPulse();
      requestDraw(false);
    },

    // zoom keeping the geographic point under the cursor fixed
    zoomAt(cx, cy, factor) {
      const before = invertClient(cx, cy);
      view.k = Math.max(K_MIN, Math.min(K_MAX, view.k * factor));
      if (before) {
        const after = invertClient(cx, cy);
        if (after) {
          view.lon = wrapLon(view.lon + before[0] - after[0]);
          view.lat = clampLat(view.lat + before[1] - after[1]);
        }
      }
      interactingPulse();
      requestDraw(false);
    },

    // Fly to the user's location, morphing from globe to flat on the way in.
    locate() {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const from = { ...view };
          const to = {
            lon: pos.coords.longitude,
            lat: clampLat(pos.coords.latitude),
            k: LOCATE_K,
          };
          let dLon = wrapLon(to.lon - from.lon);
          const t0 = performance.now();
          const dur = 2000;
          const step = (now) => {
            const u = Math.min(1, (now - t0) / dur);
            const e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
            view.lon = wrapLon(from.lon + dLon * e);
            view.lat = from.lat + (to.lat - from.lat) * e;
            view.k = Math.exp(
              Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e
            );
            if (u < 1) {
              requestDraw(false);
              requestAnimationFrame(step);
            } else {
              requestDraw(true);
            }
          };
          requestAnimationFrame(step);
        },
        () => {}, // denied or unavailable: stay on the globe
        { timeout: 8000, maximumAge: 3600000 }
      );
    },

    // click a cell → its April 25th history
    async openCell(clientX, clientY) {
      const ll = invertClient(clientX, clientY);
      if (!ll) return;
      const lon = Math.round(ll[0] * 10) / 10;
      const lat = Math.round(ll[1] * 10) / 10;
      let title = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? "E" : "W"}`;
      const near = kNearest(currentRows, lat, lon, 1)[0];
      if (near && near.dist < 150) title += ` · near ${near.name}`;
      this.tooltip.show = false;
      this.panel.show = true;
      this.panel.title = title;
      this.panel.summary = "Reading the archives…";
      this.panel.detail = "";
      this.panel.note = "";
      document.getElementById("history-chart").replaceChildren();
      await ensureHistory();
      await new Promise(requestAnimationFrame); // let the panel lay out
      const series = historySeries(lat, lon);
      this.panel.summary = quipFor(series, lat, lon);
      const est = cellEstimate(lat, lon, currentRows);
      this.panel.detail = est
        ? `In ${this.year}: ${est.temp.toFixed(1)} ± ${est.ci.toFixed(1)} °F (${(((est.temp - 32) * 5) / 9).toFixed(1)} °C) · precip ${est.precip.toFixed(2)} in reported · nearest station: ${est.nearest.name} (${Math.round(est.nearest.dist)} km)`
        : `In ${this.year}: no station data nearby.`;
      this.panel.note = series.length
        ? `April 25th mean temp, ${series.length} of ${hist.ny} years · interpolated from the ${K_NEIGHBORS} nearest stations`
        : "";
      renderHistoryChart(series);
    },

    setupHover() {
      canvas.addEventListener("mousemove", (e) => this.onHover(e));
      canvas.addEventListener("mouseleave", () => (this.tooltip.show = false));
    },

    onHover(e) {
      if (interacting || currentRows.length === 0) return;
      const ll = invertClient(e.clientX, e.clientY);
      if (!ll) {
        this.tooltip.show = false;
        return;
      }
      const lon = Math.round(ll[0] * 10) / 10; // snap to the 0.1° grid
      const lat = Math.round(ll[1] * 10) / 10;
      const html = tooltipHtml(lat, lon, currentRows);
      if (!html) {
        this.tooltip.show = false;
        return;
      }
      const flipX = e.clientX > window.innerWidth - 260;
      const flipY = e.clientY > window.innerHeight - 60;
      this.tooltip.x = flipX ? e.clientX - 250 : e.clientX + 14;
      this.tooltip.y = flipY ? e.clientY - 34 : e.clientY + 16;
      this.tooltip.html = html;
      this.tooltip.show = true;
    },
  }));
});
