// april25th.date — was it light jacket weather?

// --- tweakables -----------------------------------------------------------
const JACKET_MIN = 55; // °F — below this is "too cold"
const JACKET_MAX = 70; // °F — above this is "too hot"
const MAX_STATION_KM = 500; // beyond this from any station → "no data"
const K_NEIGHBORS = 5; // stations used for tooltip interpolation + CI
const LOCATE_ZOOM = 6; // initial zoom on the user's location (6 ≈ continental US)
const MAX_ZOOM = 80;
const COLOR_COLD = "#6a9fd8";
const COLOR_JACKET = "#7cb342";
const COLOR_HOT = "#e2725b";
const COLOR_UNKNOWN = "#d9d9d9";
// ---------------------------------------------------------------------------

const KM_PER_DEG = 111.32; // one degree of latitude (or equator longitude)

let land = null; // GeoJSON land feature, loaded once
let manifest = null;
let projection = null; // the exact d3 projection instance Plot renders with
let plotW = 0; // frame size passed to Plot
let plotH = 0;
let currentRows = []; // stations for the year on screen
let renderedTransform = d3.zoomIdentity; // zoom transform baked into `projection`
let zoomBehavior = null;
let gesturing = false; // mid-gesture the svg is CSS-transformed; hover math is off

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

function baseProjection(width, height) {
  return d3
    .geoEqualEarth()
    .fitExtent([[2, 2], [width - 2, height - 2]], { type: "Sphere" });
}

// The world-fit projection with the current zoom/pan transform baked in,
// so both Plot's rendering and our hover inversion share one instance.
function makeProjection(width, height, t) {
  const proj = baseProjection(width, height);
  const [bx, by] = proj.translate();
  return proj
    .scale(proj.scale() * t.k)
    .translate([t.k * bx + t.x, t.k * by + t.y]);
}

// Barycentric interpolation between stations, then gray out every raster
// cell farther than MAX_STATION_KM from its nearest station.
function maskedBarycentric(index, width, height, X, Y, V) {
  const values = Plot.interpolatorBarycentric()(index, width, height, X, Y, V);
  if (index.length === 0) return values;
  // km → raster px: measure one degree of longitude at the equator, then
  // account for the raster grid being plot-pixels / pixelSize. The projection
  // includes the zoom scale, so the mask stays 500 geographic km at any zoom.
  const p0 = projection([0, 0]);
  const p1 = projection([1, 0]);
  const plotPxPerKm = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / KM_PER_DEG;
  const maxPx = MAX_STATION_KM * plotPxPerKm * (width / plotW);
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
  plotW = width;
  plotH = height;
  return Plot.plot({
    width,
    height,
    margin: 0,
    style: { background: "transparent", overflow: "hidden" },
    projection: () => (projection = makeProjection(width, height, renderedTransform)),
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
    renderId: 0,
    tooltip: { show: false, x: 0, y: 0, html: "" },

    async init() {
      const [topo, mf] = await Promise.all([
        d3.json("./data/land-110m.json"),
        d3.json("./data/manifest.json"),
      ]);
      land = topojson.feature(topo, topo.objects.land);
      manifest = mf;
      this.setupZoom();
      this.setupHover();
      await this.render();
      this.locate();
      window.addEventListener(
        "resize",
        debounce(() => this.render(), 200)
      );
    },

    // Scroll to zoom, drag to pan. During the gesture the svg gets a cheap
    // CSS transform; on gesture end we re-render crisply with the transform
    // baked into the projection.
    setupZoom() {
      zoomBehavior = d3
        .zoom()
        .scaleExtent([1, MAX_ZOOM])
        .on("start", () => {
          gesturing = true;
          this.tooltip.show = false;
        })
        .on("zoom", (e) => {
          const svg = document.querySelector("#map svg");
          if (!svg) return;
          const t = e.transform;
          const r = renderedTransform;
          const k = t.k / r.k;
          svg.style.transformOrigin = "0 0";
          svg.style.transform = `translate(${t.x - k * r.x}px, ${t.y - k * r.y}px) scale(${k})`;
        })
        .on("end", (e) => {
          gesturing = false;
          const t = e.transform;
          const r = renderedTransform;
          if (t.k === r.k && t.x === r.x && t.y === r.y) return;
          renderedTransform = t;
          this.render();
        });
      d3.select("#map").call(zoomBehavior);
    },

    setupHover() {
      const el = document.getElementById("map");
      el.addEventListener("mousemove", (e) => this.onHover(e));
      el.addEventListener("mouseleave", () => (this.tooltip.show = false));
    },

    onYearInput: debounce(function () {
      this.render();
    }, 120),

    async render() {
      const id = ++this.renderId;
      this.loading = true;
      const rows = await loadYear(this.year);
      if (id !== this.renderId) return; // superseded while loading
      const wrap = document.getElementById("map-wrap");
      const aspect = 2.05; // equal-earth sphere is about 2.05:1
      const width = Math.floor(Math.min(wrap.clientWidth, wrap.clientHeight * aspect));
      const height = Math.floor(Math.min(wrap.clientHeight, width / aspect));
      currentRows = rows;
      const fig = renderMap(rows, width, height);
      const map = document.getElementById("map");
      map.style.width = width + "px"; // pin #map to the svg so zoom/hover
      map.style.height = height + "px"; // coordinates line up exactly
      map.replaceChildren(fig);
      zoomBehavior
        .extent([[0, 0], [width, height]])
        .translateExtent([[0, 0], [width, height]]);
      this.stationCount = rows.length;
      this.loading = false;
    },

    // Fly to the user's location at continental scale, if they allow it.
    locate() {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const p = baseProjection(plotW, plotH)([
            pos.coords.longitude,
            pos.coords.latitude,
          ]);
          if (!p) return;
          const k = LOCATE_ZOOM;
          const t = d3.zoomIdentity
            .translate(plotW / 2 - k * p[0], plotH / 2 - k * p[1])
            .scale(k);
          d3.select("#map")
            .transition()
            .duration(2000)
            .call(zoomBehavior.transform, t);
        },
        () => {}, // denied or unavailable: stay on the world view
        { timeout: 8000, maximumAge: 3600000 }
      );
    },

    onHover(e) {
      if (gesturing || !projection || currentRows.length === 0) {
        this.tooltip.show = false;
        return;
      }
      const svg = document.querySelector("#map svg");
      if (!svg) return;
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
      const html = tooltipHtml(lat, lon, currentRows);
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
    },
  }));
});
