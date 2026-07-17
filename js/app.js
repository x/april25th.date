// april25th.date — was it light jacket weather?

// --- tweakables -----------------------------------------------------------
const JACKET_MIN = 55; // °F — below this is "too cold"
const JACKET_MAX = 70; // °F — above this is "too hot"
const MAX_STATION_KM = 500; // beyond this from any station → "no data"
const K_NEIGHBORS = 5; // stations used for tooltip interpolation + CI
const COLOR_COLD = "#6a9fd8";
const COLOR_JACKET = "#7cb342";
const COLOR_HOT = "#e2725b";
const COLOR_UNKNOWN = "#d9d9d9";
// ---------------------------------------------------------------------------

const KM_PER_DEG = 111.32; // one degree of latitude (or equator longitude)

let land = null; // GeoJSON land feature, loaded once
let manifest = null;
let projection = null; // the exact d3 projection instance Plot renders with
let plotWidth = 0; // frame width passed to Plot, for raster px conversion

const yearCache = new Map(); // year -> rows (kept out of Alpine's proxies)

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

// --- map -------------------------------------------------------------------

// Barycentric interpolation between stations, then gray out every raster
// cell farther than MAX_STATION_KM from its nearest station.
function maskedBarycentric(index, width, height, X, Y, V) {
  const values = Plot.interpolatorBarycentric()(index, width, height, X, Y, V);
  if (index.length === 0) return values;
  // km → raster px: measure one degree of longitude at the equator, then
  // account for the raster grid being plot-pixels / pixelSize.
  const p0 = projection([0, 0]);
  const p1 = projection([1, 0]);
  const plotPxPerKm = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / KM_PER_DEG;
  const maxPx = MAX_STATION_KM * plotPxPerKm * (width / plotWidth);
  const maxPx2 = maxPx * maxPx;
  const delaunay = d3.Delaunay.from(
    index,
    (i) => X[i],
    (i) => Y[i]
  );
  let j = 0; // warm start: consecutive cells are neighbors
  for (let y = 0, k = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x, ++k) {
      j = delaunay.find(x + 0.5, y + 0.5, j);
      const i = index[j];
      const dx = X[i] - (x + 0.5);
      const dy = Y[i] - (y + 0.5);
      if (dx * dx + dy * dy > maxPx2) values[k] = NaN;
    }
  }
  return values;
}

function renderMap(rows, width, height) {
  plotWidth = width;
  return Plot.plot({
    width,
    height,
    margin: 0,
    style: { background: "transparent", overflow: "visible" },
    projection: ({ width, height }) =>
      (projection = d3
        .geoEqualEarth()
        .fitExtent([[2, 2], [width - 2, height - 2]], { type: "Sphere" })),
    color: {
      type: "threshold",
      domain: [JACKET_MIN, JACKET_MAX],
      range: [COLOR_COLD, COLOR_JACKET, COLOR_HOT],
      unknown: COLOR_UNKNOWN,
    },
    marks: [
      Plot.graticule({ strokeOpacity: 0.08 }),
      rows.length >= 3
        ? Plot.raster(rows, {
            x: "lon",
            y: "lat",
            fill: "temp",
            pixelSize: 2,
            interpolate: maskedBarycentric,
            clip: land,
          })
        : Plot.dot(rows, { x: "lon", y: "lat", fill: "temp", r: 4 }),
      Plot.geo(land, { stroke: "#444", strokeWidth: 0.5 }),
      Plot.sphere({ stroke: "#999" }),
    ],
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
  if (temp < JACKET_MIN) return { label: "Too cold", color: COLOR_COLD };
  if (temp > JACKET_MAX) return { label: "Too hot", color: COLOR_HOT };
  return { label: "All you need is a light jacket ✓", color: COLOR_JACKET };
}

function tooltipHtml(lat, lon, rows) {
  const near = kNearest(rows, lat, lon, K_NEIGHBORS);
  if (near.length === 0) return null;
  const d0 = near[0].dist;
  const cell = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? "E" : "W"}`;
  if (d0 > MAX_STATION_KM) {
    return `<span class="verdict">No data</span><br>
      <span class="muted">${cell} · nearest station ${Math.round(d0).toLocaleString()} km away</span>`;
  }
  // inverse-distance-weighted estimate + a distance-widened confidence interval
  const w = near.map((n) => 1 / Math.max(n.dist, 1) ** 2);
  const W = d3.sum(w);
  const temp = d3.sum(near, (n, i) => w[i] * n.temp) / W;
  const precip = d3.sum(near, (n, i) => w[i] * n.precip) / W;
  const sd = Math.sqrt(d3.sum(near, (n, i) => w[i] * (n.temp - temp) ** 2) / W);
  const ci = 1.96 * sd * (1 + d0 / MAX_STATION_KM);
  const v = classify(temp);
  const tempC = ((temp - 32) * 5) / 9;
  return `<span class="verdict" style="color:${v.color}">${v.label}</span><br>
    ${temp.toFixed(1)} ± ${ci.toFixed(1)} °F <span class="muted">(${tempC.toFixed(1)} °C)</span><br>
    precip ${precip.toFixed(2)} in reported<br>
    <span class="muted">${cell} · nearest: ${near[0].name} (${Math.round(d0)} km)</span>`;
}

// --- app -------------------------------------------------------------------

function debounce(fn, ms) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

document.addEventListener("alpine:init", () => {
  Alpine.data("april25", () => ({
    year: 2025,
    stationCount: 0,
    loading: true,
    tooltip: { show: false, x: 0, y: 0, html: "" },

    async init() {
      const [topo, mf] = await Promise.all([
        d3.json("./data/land-110m.json"),
        d3.json("./data/manifest.json"),
      ]);
      land = topojson.feature(topo, topo.objects.land);
      manifest = mf;
      await this.render();
      window.addEventListener(
        "resize",
        debounce(() => this.render(), 200)
      );
    },

    onYearInput: debounce(function () {
      this.render();
    }, 120),

    async render() {
      const year = this.year;
      this.loading = true;
      const rows = await loadYear(year);
      if (year !== this.year) return; // slider moved on while loading
      const box = document.getElementById("map").getBoundingClientRect();
      const aspect = 2.05; // equal-earth sphere is about 2.05:1
      const width = Math.floor(Math.min(box.width, box.height * aspect));
      const height = Math.floor(Math.min(box.height, width / aspect));
      const fig = renderMap(rows, width, height);
      document.getElementById("map").replaceChildren(fig);
      this.attachHover(fig, rows);
      this.stationCount = rows.length;
      this.loading = false;
    },

    attachHover(fig, rows) {
      const svg = fig.tagName === "svg" ? fig : fig.querySelector("svg");
      svg.addEventListener("mousemove", (e) => {
        const r = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        const px = ((e.clientX - r.left) * vb.width) / r.width;
        const py = ((e.clientY - r.top) * vb.height) / r.height;
        const ll = projection.invert([px, py]);
        const rt = ll && projection(ll); // round-trip: reject off-sphere junk
        if (!rt || Math.hypot(rt[0] - px, rt[1] - py) > 0.5) {
          this.tooltip.show = false;
          return;
        }
        const lon = Math.round(ll[0] * 10) / 10; // snap to the 0.1° grid
        const lat = Math.round(ll[1] * 10) / 10;
        const html = tooltipHtml(lat, lon, rows);
        if (!html) {
          this.tooltip.show = false;
          return;
        }
        const flipX = e.clientX > window.innerWidth - 280;
        const flipY = e.clientY > window.innerHeight - 140;
        this.tooltip.x = flipX ? e.clientX - 272 : e.clientX + 14;
        this.tooltip.y = flipY ? e.clientY - 120 : e.clientY + 14;
        this.tooltip.html = html;
        this.tooltip.show = true;
      });
      svg.addEventListener("mouseleave", () => (this.tooltip.show = false));
    },
  }));
});
