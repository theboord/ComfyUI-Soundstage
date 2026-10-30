// 2.5D cards: a cut-out image (PNG with alpha) stood up in the set as a flat object. The card's
// geometry is the traced silhouette of its alpha, not a rectangle, so the clay, depth and ID passes
// (which replace materials) still see the person or prop's real outline.
import * as THREE from "../vendor/three.module.min.mjs";

const D = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]]; // W, NW, N, NE, E, SE, S, SW (clockwise, y down)

/** Outer boundaries of the opaque regions of a binary grid (Moore-neighbour tracing). */
export function traceContours(mask, w, h, minArea = 12) {
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x];
  const seen = new Uint8Array(w * h);
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x] || seen[y * w + x]) continue;
      // Flood the component (to measure it and not trace it twice); the scan-order first pixel is its top-left,
      // so its west neighbour is empty: a valid Moore start.
      let area = 0;
      const stack = [x + y * w];
      seen[x + y * w] = 1;
      while (stack.length) {
        const i = stack.pop();
        area++;
        const px = i % w, py = (i / w) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx, ny = py + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx] && !seen[ny * w + nx]) { seen[ny * w + nx] = 1; stack.push(nx + ny * w); }
        }
      }
      if (area < minArea) continue;
      const start = { x, y };
      const pts = [start];
      let p = start, bdir = 0, guard = 0;
      while (guard++ < w * h * 4) {
        let found = -1;
        for (let i = 1; i <= 8; i++) {
          const d = (bdir + i) % 8;
          if (at(p.x + D[d][0], p.y + D[d][1])) { found = d; break; }
        }
        if (found < 0) break; // a single pixel
        const prev = (found + 7) % 8;
        const np = { x: p.x + D[found][0], y: p.y + D[found][1] };
        const bx = p.x + D[prev][0] - np.x, by = p.y + D[prev][1] - np.y;
        bdir = D.findIndex(([dx, dy]) => dx === bx && dy === by);
        if (bdir < 0) bdir = 0;
        p = np;
        if (p.x === start.x && p.y === start.y) break;
        pts.push(p);
      }
      if (pts.length >= 3) out.push({ points: pts, area });
    }
  }
  return out;
}

/** Ramer–Douglas–Peucker on a closed polyline. */
export function simplify(points, eps) {
  if (points.length < 4) return points;
  const rdp = (pts) => {
    if (pts.length < 3) return pts;
    const a = pts[0], b = pts[pts.length - 1];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    let best = -1, bi = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs(dy * pts[i].x - dx * pts[i].y + b.x * a.y - b.y * a.x) / len;
      if (d > best) { best = d; bi = i; }
    }
    if (best <= eps) return [a, b];
    const l = rdp(pts.slice(0, bi + 1)), r = rdp(pts.slice(bi));
    return [...l.slice(0, -1), ...r];
  };
  // Split the ring at its farthest point so RDP has two open halves.
  let far = 0, fd = -1;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[0].x, points[i].y - points[0].y);
    if (d > fd) { fd = d; far = i; }
  }
  const a = rdp(points.slice(0, far + 1)), b = rdp([...points.slice(far), points[0]]);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

const imageCache = new Map();
function loadImage(url) {
  if (!imageCache.has(url)) {
    imageCache.set(url, new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`could not load ${url}`));
      img.src = url;
    }));
  }
  return imageCache.get(url);
}

/**
 * Build a card: silhouette geometry, `heightM` tall, standing on y = 0, centred on x, facing +z.
 * Images without real transparency become a plain rectangle (a backdrop flat or a sign).
 */
export async function buildCard(url, heightM = 1.7) {
  const img = await loadImage(url);
  const W = img.naturalWidth, H = img.naturalHeight;
  const s = Math.min(1, 160 / Math.max(W, H)); // trace on a small grid; the texture keeps full resolution
  const gw = Math.max(2, Math.round(W * s)), gh = Math.max(2, Math.round(H * s));
  const cv = document.createElement("canvas");
  cv.width = gw; cv.height = gh;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, gw, gh);
  const data = ctx.getImageData(0, 0, gw, gh).data;
  const mask = new Uint8Array(gw * gh);
  let opaque = 0;
  for (let i = 0; i < gw * gh; i++) if ((mask[i] = data[i * 4 + 3] > 128 ? 1 : 0)) opaque++;
  const width = heightM * (W / H);
  const toShape = (pts) => new THREE.Shape(pts.map((q) => new THREE.Vector2(((q.x + 0.5) / gw - 0.5) * width, (1 - (q.y + 0.5) / gh) * heightM)));
  let shapes;
  if (opaque > gw * gh * 0.985) {
    shapes = [toShape([{ x: -0.5, y: gh - 0.5 }, { x: gw - 0.5, y: gh - 0.5 }, { x: gw - 0.5, y: -0.5 }, { x: -0.5, y: -0.5 }])];
  } else {
    const minArea = Math.max(12, gw * gh * 0.002);
    shapes = traceContours(mask, gw, gh, minArea).map((c) => toShape(simplify(c.points, 0.8)));
  }
  const geom = new THREE.ShapeGeometry(shapes);
  // Texture coordinates straight from position, so the photo lands where it was traced.
  const pos = geom.attributes.position, uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i) / width + 0.5; uv[i * 2 + 1] = pos.getY(i) / heightM; }
  geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geom.computeVertexNormals();
  const tex = new THREE.Texture(img);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  const mat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, transparent: false });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.castShadow = true;
  return { mesh, width, height: heightM, aspect: W / H };
}

/** Fit an image as a backdrop: like CSS object-fit: cover, for a scene.background texture. */
export async function loadBackdrop(url) {
  const img = await loadImage(url);
  const tex = new THREE.Texture(img);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex.userData.aspect = img.naturalWidth / img.naturalHeight;
  return tex;
}

export function coverFit(tex, viewAspect) {
  const a = tex.userData.aspect || 1;
  tex.matrixAutoUpdate = true;
  if (a > viewAspect) { tex.repeat.set(viewAspect / a, 1); tex.offset.set((1 - viewAspect / a) / 2, 0); }
  else { tex.repeat.set(1, a / viewAspect); tex.offset.set(0, (1 - a / viewAspect) / 2); }
}
