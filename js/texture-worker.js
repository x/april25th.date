// Builds the per-year classification texture off the main thread.
// Input: station lat/lon/temp for one year. Output: a TW×TH equirectangular
// Uint8 grid of classes: 0 ocean, 1 too cold, 2 light jacket, 3 too hot,
// 4 no data (no station within MAX_STATION_KM).

importScripts("d3.v7.min.js", "plot.min.js");

// keep in sync with app.js
const JACKET_MIN = 55;
const JACKET_MAX = 70;
const MAX_STATION_KM = 500;
const CLASSIFY_OCEANS = false; // experiment: classify water too (false = ocean color)

let TW = 0;
let TH = 0;
let landMask = null;

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

function classifyTemp(t) {
  if (!isFinite(t)) return 4;
  if (t < JACKET_MIN) return 1;
  if (t > JACKET_MAX) return 3;
  return 2;
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    TW = m.tw;
    TH = m.th;
    landMask = m.landMask;
    return;
  }

  const lat = m.lat;
  const lon = m.lon;
  const temp = m.temp;
  const classes = new Uint8Array(TW * TH);

  if (lat.length < 3) {
    for (let i = 0; i < classes.length; i++)
      classes[i] = CLASSIFY_OCEANS || landMask[i] ? 4 : 0;
    postMessage({ year: m.year, classes }, [classes.buffer]);
    return;
  }

  // Station positions in texture coordinates; stations within a few degrees
  // of the antimeridian are duplicated on the far side so interpolation
  // doesn't tear at ±180.
  const la = [];
  const lo = [];
  const te = [];
  for (let i = 0; i < lat.length; i++) {
    la.push(lat[i]);
    lo.push(lon[i]);
    te.push(temp[i]);
    if (lon[i] > 174) {
      la.push(lat[i]);
      lo.push(lon[i] - 360);
      te.push(temp[i]);
    } else if (lon[i] < -174) {
      la.push(lat[i]);
      lo.push(lon[i] + 360);
      te.push(temp[i]);
    }
  }
  const n = la.length;
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  const V = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    X[i] = ((lo[i] + 180) / 360) * TW;
    Y[i] = ((90 - la[i]) / 180) * TH;
    V[i] = te[i];
  }
  const index = d3.range(n);

  // Linear interpolation between stations (extrapolated beyond the hull),
  // same interpolator the Plot raster mark uses.
  const temps = Plot.interpolatorBarycentric()(index, TW, TH, X, Y, V);

  // Nearest-station distance mask, warm-started scan.
  const delaunay = d3.Delaunay.from(index, (i) => X[i], (i) => Y[i]);
  let j = 0;
  for (let y = 0, k = 0; y < TH; y++) {
    const cellLat = 90 - ((y + 0.5) / TH) * 180;
    for (let x = 0; x < TW; x++, k++) {
      if (!CLASSIFY_OCEANS && !landMask[k]) continue; // ocean stays 0
      j = delaunay.find(x + 0.5, y + 0.5, j);
      const s = index[j];
      const cellLon = ((x + 0.5) / TW) * 360 - 180;
      const dist = haversineKm(cellLat, cellLon, la[s], lo[s]);
      classes[k] = dist > MAX_STATION_KM ? 4 : classifyTemp(temps[k]);
    }
  }

  postMessage({ year: m.year, classes }, [classes.buffer]);
};
