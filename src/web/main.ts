// X-Cube Lab: browser viewer. Uses the same engine as the CLI.
// three.js r128 is loaded as a global from cdnjs by the page.

import { isHomeX, isSolved, isXShape, isExposed, outerAvailability, effect } from "../core/analyze.ts";
import { DIRS, ROT_DIR, ROTATIONS, matVec, type Vec3 } from "../core/geometry.ts";
import { formatAlg, parseAlg, ParseError } from "../core/notation.ts";
import {
  CUBELETS,
  FACE_COLOR,
  MOVE_BY_NAME,
  MOVE_DEFS,
  NUM_SLOTS,
  SLOT_POS,
  State,
  applyTurn,
  blockedReason,
  slotAt,
  slotAtXYZ,
  turnName,
  type Color,
  type Turn,
} from "../core/puzzle.ts";
import { decodeState, encodeState } from "../core/serialize.ts";

declare const THREE: any;

// ------------------------------------------------------------------ model

const app = {
  base: State.solved(),
  baseLabel: "Solved",
  history: [] as Turn[],
  cursor: 0, // number of history turns applied
  current: State.solved(),
  modifier: 1 as 1 | 2 | 3,
  message: "",
  messageKind: "info" as "info" | "error" | "ok",
};

function recompute() {
  const st = app.base.clone();
  for (let i = 0; i < app.cursor; i++) applyTurn(st, app.history[i]);
  app.current = st;
}

// ------------------------------------------------------------------ three.js scene

const STICKER: Record<Color, number> = {
  W: 0xf3f3ee,
  Y: 0xf5d00f,
  G: 0x17a34a,
  B: 0x1d5fd6,
  R: 0xc8202b,
  O: 0xf47a12,
};

let renderer: any, scene: any, camera: any, pivot: any;
const meshes: any[] = []; // indexed by cubelet id
// The camera stays put; turning the view rotates the puzzle (pivot) instead.
// Preset views are orientations of the pivot. "Home" is the three-quarter view.
type Quat = [number, number, number, number]; // x, y, z, w
const axisQuat = (ax: number, ay: number, az: number, angle: number): Quat => {
  const s = Math.sin(angle / 2);
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
};
const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const HALF = Math.PI / 2;
// Side views tip the top toward you by 16.6 degrees (from the owner's saved "Front" view).
const SIDE_TILT = 0.29;
const tilted = (yaw: number): Quat => qmul(axisQuat(1, 0, 0, SIDE_TILT), axisQuat(0, 1, 0, yaw));
export const VIEWS: Record<string, Quat> = {
  home: qmul(axisQuat(1, 0, 0, 0.5), axisQuat(0, 1, 0, -0.62)),
  front: tilted(0),
  back: tilted(Math.PI),
  left: tilted(HALF),
  right: tilted(-HALF),
  top: axisQuat(1, 0, 0, HALF),
  bottom: axisQuat(1, 0, 0, -HALF),
};
let tween: { from: any; to: any; start: number; ms: number } | null = null;

function goToView(q: Quat) {
  const to = new THREE.Quaternion(q[0], q[1], q[2], q[3]);
  tween = { from: pivot.quaternion.clone(), to, start: performance.now(), ms: reduceMotionView() ? 0 : 350 };
}
function reduceMotionView() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
/** three.js r155+ changed color and light handling; keep the look tuned under r128. */
function matchR128Look(r: any) {
  r.outputColorSpace = THREE.LinearSRGBColorSpace;
  if ("useLegacyLights" in r) r.useLegacyLights = true;
}

function initScene(canvas: HTMLCanvasElement) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  matchR128Look(renderer);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  // Ambient + key light sum to 1.0 at most, so no face saturates: a fully lit
  // yellow must stay clearly yellow next to white.
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 0.4);
  key.position.set(4, 9, 7);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.22);
  fill.position.set(-6, -4, -5);
  scene.add(fill);
  pivot = new THREE.Group();
  const h = VIEWS.home;
  pivot.quaternion.set(h[0], h[1], h[2], h[3]);
  scene.add(pivot);
  camera.position.set(0, 0, 13.5);
  camera.lookAt(0, 0, 0);

  // Cubelets nearly touch, as on the real puzzle: a hairline gap between them.
  // Rounded like a real cube's plastic. Dark gray, not black, so that inside faces
  // facing different ways can be told apart by their shading.
  const body = roundedBox(0.985, BODY_RADIUS, 3);
  // Glossy plastic: small, tight highlights that slide along the rounded edges and
  // corners as the cube tumbles (the lights stay put while the puzzle turns).
  const bodyMat = new THREE.MeshPhongMaterial({ color: 0x3a3e41, specular: 0x5a5e62, shininess: 70 });
  // Stickers sit on the flat part of each face, with rounded corners.
  const plane = roundedSquare(0.82, 0.07);
  const mats = new Map<Color, any>();
  const dark = getComputedStyle(document.documentElement).getPropertyValue("--unstickered").trim() || "#2b2f2e";
  const netPlane = new THREE.PlaneGeometry(0.92, 0.92);
  const glowPlane = new THREE.PlaneGeometry(1.0, GLOW_WIDTH);
  const glowTex = makeGlowTexture();
  const glowMats = new Map<string, any>();
  const glowMatFor = (c: Color) => {
    if (!glowMats.has(c)) {
      const color = new THREE.Color(STICKER[c]);
      glowMats.set(c, makeGlowMaterial(glowTex, color));
    }
    return glowMats.get(c);
  };
  const netBody = new THREE.BoxGeometry(0.92, 0.92, 0.92);
  const netOccluderMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  const netMats = new Map<Color, any>();
  const netMatFor = (c: Color) => {
    if (!netMats.has(c)) netMats.set(c, new THREE.MeshBasicMaterial({ color: STICKER[c], vertexColors: true }));
    return netMats.get(c);
  };
  const netDarkMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(dark), vertexColors: true });
  const matFor = (c: Color) => {
    if (!mats.has(c)) mats.set(c, new THREE.MeshPhongMaterial({ color: STICKER[c], vertexColors: true, specular: 0x1c1c1c, shininess: 22 }));
    return mats.get(c);
  };
  // local face d -> plane placement
  const faceXform: [number, number, number, number, number][] = [
    // [px, py, pz, rotX, rotY]
    [0.4945, 0, 0, 0, Math.PI / 2],
    [-0.4945, 0, 0, 0, -Math.PI / 2],
    [0, 0.4945, 0, -Math.PI / 2, 0],
    [0, -0.4945, 0, Math.PI / 2, 0],
    [0, 0, 0.4945, 0, 0],
    [0, 0, -0.4945, 0, Math.PI],
  ];
  for (const c of CUBELETS) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(body, bodyMat));
    const aoList: AoFace[] = [];
    aoFaces[c.id] = aoList;
    c.stickers.forEach((col, d) => {
      if (!col) return;
      const m = new THREE.Mesh(withAoColors(plane), matFor(col));
      const [px, py, pz, rx, ry] = faceXform[d];
      m.position.set(px, py, pz);
      m.rotation.set(rx, ry, 0);
      g.add(m);
      aoList.push(aoFace(m, d, "3d"));
    });
    // Flat-view faces: unlit, one per face, seen only by the flat view's cameras (layer 2).
    // An invisible occluder (depth only, drawn first) keeps deeper cubelets from
    // showing through the gaps, so the gaps look like the resting grid's.
    const occluder = new THREE.Mesh(netBody, netOccluderMat);
    occluder.layers.set(NET_LAYER);
    occluder.renderOrder = -1;
    g.add(occluder);
    for (let d = 0; d < 6; d++) {
      const col = c.stickers[d];
      const m = new THREE.Mesh(withAoColors(netPlane), col ? netMatFor(col) : netDarkMat);
      const [px, py, pz, rx, ry] = faceXform[d];
      m.position.set(px / 0.4945 * 0.5, py / 0.4945 * 0.5, pz / 0.4945 * 0.5);
      m.rotation.set(rx, ry, 0);
      m.layers.set(NET_LAYER);
      g.add(m);
      aoList.push(aoFace(m, d, "flat"));
    }
    // Edge glow: for every pair of adjacent faces (a, b), a soft band lying in face a's
    // plane, starting at the shared edge and fading outward, in face b's color. It is
    // shown only when both faces are exposed, i.e. where face a steps down to something
    // deeper or to empty space. Seen by the 3D view (layer 3) and the flat view (layer 4).
    const list: { mesh: any; a: number; b: number }[] = [];
    for (let a = 0; a < 6; a++)
      for (let b = 0; b < 6; b++) {
        if (a >> 1 === b >> 1) continue;
        // No glow for unstickered side faces: no glow at an edge means the face is black.
        const col = c.stickers[b];
        if (!col) continue;
        const m = new THREE.Mesh(glowPlane, glowMatFor(col));
        const A = new THREE.Vector3(...DIRS[a]);
        const B = new THREE.Vector3(...DIRS[b]);
        const X = new THREE.Vector3().crossVectors(B, A);
        m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, B, A));
        m.position.copy(A.clone().multiplyScalar(GLOW_DEPTH)).add(B.clone().multiplyScalar(GLOW_START + GLOW_WIDTH / 2));
        m.layers.set(GLOW3D_LAYER);
        m.layers.enable(GLOWNET_LAYER);
        m.renderOrder = 2;
        m.visible = false;
        g.add(m);
        list.push({ mesh: m, a, b });
      }
    glows[c.id] = list;
    aoList.sort((a, b) => a.d - b.d); // same-direction faces (3D sticker, flat tile) share one computation
    pivot.add(g);
    meshes[c.id] = g;
  }
  applyGlowSettings();
  initNetAnimation();
  bindOrbit(canvas);
  resize();
  window.addEventListener("resize", resize);
  syncMeshes(app.current);
  frame();
}

function placeMesh(g: any, slot: number, ori: number) {
  const p = SLOT_POS[slot];
  g.position.set(p[0], p[1], p[2]);
  const m = ROTATIONS[ori];
  const mat = new THREE.Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);
  g.quaternion.setFromRotationMatrix(mat);
}

function syncMeshes(st: State) {
  for (let s = 0; s < NUM_SLOTS; s++) {
    const id = st.occ[s];
    if (id < 0) continue;
    placeMesh(meshes[id], s, st.ori[s]);
    const o = st.ori[s];
    for (const gl of glows[id] ?? []) {
      gl.mesh.visible = isExposed(st, s, ROT_DIR[o * 6 + gl.a]) && isExposed(st, s, ROT_DIR[o * 6 + gl.b]);
    }
    for (const f of aoFaces[id] ?? []) shadeFace(st, s, o, f);
  }
}

// ------------------------------------------------------------------ corner shading (ambient occlusion)
//
// Grid-based ambient occlusion, as in block-building games. For each corner of a
// visible face, look at the three grid spots in front of the face around that corner
// (two along the edges, one diagonal). Filled spots darken the corner; both edge
// spots filled makes it darkest. Corners blend smoothly across the face. Cubelets
// flush with the face (same plane) don't count, so flat surfaces get no lines.

interface AoFace {
  mesh: any;
  d: number; // face direction in the cubelet's own frame
  ux: Vec3; // the plane's local x axis, in the cubelet's own frame
  uy: Vec3;
  extent: number; // the face's full width, for blending corner values across it
  view: "3d" | "flat";
  cur?: number[]; // corner values currently shown
}
const aoFaces: AoFace[][] = [];
// Brightness by number of open spots around a corner (0 = boxed in, 3 = open).
const AO_LEVELS = [0.39, 0.575, 0.765, 1];
// The four corners of a face, as (x, y) signs in the plane's own coordinates.
const CORNER_SIGNS: [number, number][] = [
  [-1, 1],
  [1, 1],
  [-1, -1],
  [1, -1],
];
const AO_KEY = "xcube-lab-shading";
const aoOn = (() => {
  try {
    return { "3d": true, flat: true, ...JSON.parse(localStorage.getItem(AO_KEY) || "{}") } as { "3d": boolean; flat: boolean };
  } catch {
    return { "3d": true, flat: true };
  }
})();

function withAoColors(geo: any) {
  const g = geo.clone();
  const n = g.attributes.position.count;
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return g;
}

/**
 * A cube of side `size` with edges and corners rounded to `radius`, built from a
 * subdivided box whose grid is packed near the edges and then pushed onto the
 * rounded surface. `arc` = segments across each rounded edge.
 */
function roundedBox(size: number, radius: number, arc: number) {
  const h = size / 2;
  const inner = h - radius;
  const N = 2 * arc + 1; // segments per side: arc + 1 flat + arc
  const geo = new THREE.BoxGeometry(size, size, size, N, N, N);
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  // Remap a grid coordinate so that `arc` segments lie within each rounded band.
  const remap = (c: number) => {
    const i = Math.round(((c + h) / size) * N); // 0..N
    if (i <= arc) return -h + (radius * i) / arc;
    if (i >= N - arc) return inner + (radius * (i - (N - arc))) / arc;
    return -inner + ((2 * inner) * (i - arc)) / (N - 2 * arc);
  };
  const v = new THREE.Vector3();
  for (let k = 0; k < pos.count; k++) {
    v.set(remap(pos.getX(k)), remap(pos.getY(k)), remap(pos.getZ(k)));
    const core = new THREE.Vector3(
      Math.max(-inner, Math.min(inner, v.x)),
      Math.max(-inner, Math.min(inner, v.y)),
      Math.max(-inner, Math.min(inner, v.z)),
    );
    const out = v.clone().sub(core);
    if (out.lengthSq() > 1e-12) {
      out.normalize();
      v.copy(core).addScaledVector(out, radius);
      nor.setXYZ(k, out.x, out.y, out.z);
    }
    pos.setXYZ(k, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  nor.needsUpdate = true;
  return geo;
}

/** A square of side `size` with rounded corners, in the XY plane facing +Z. */
function roundedSquare(size: number, radius: number) {
  const h = size / 2;
  const s = new THREE.Shape();
  s.moveTo(-h + radius, -h);
  s.lineTo(h - radius, -h);
  s.quadraticCurveTo(h, -h, h, -h + radius);
  s.lineTo(h, h - radius);
  s.quadraticCurveTo(h, h, h - radius, h);
  s.lineTo(-h + radius, h);
  s.quadraticCurveTo(-h, h, -h, h - radius);
  s.lineTo(-h, -h + radius);
  s.quadraticCurveTo(-h, -h, -h + radius, -h);
  return new THREE.ShapeGeometry(s, 4);
}

function aoFace(mesh: any, d: number, view: "3d" | "flat"): AoFace {
  const round = (v: any): Vec3 => [Math.round(v.x), Math.round(v.y), Math.round(v.z)];
  return {
    mesh,
    d,
    ux: round(new THREE.Vector3(1, 0, 0).applyEuler(mesh.rotation)),
    uy: round(new THREE.Vector3(0, 1, 0).applyEuler(mesh.rotation)),
    extent: view === "3d" ? 0.985 : 0.92,
    view,
  };
}

function filledAt(st: State, p: Vec3): boolean {
  if (p[0] === 0 && p[1] === 0 && p[2] === 0) return true; // the solid center
  const s = slotAt(p);
  return s >= 0 && st.occ[s] >= 0;
}

function shadeFace(st: State, slot: number, ori: number, f: AoFace) {
  const col = f.mesh.geometry.attributes.color;
  const arr = col.array as Float32Array;
  if (!aoOn[f.view]) {
    if (arr[0] !== 1 || arr[arr.length - 1] !== 1) {
      arr.fill(1);
      col.needsUpdate = true;
    }
    return;
  }
  const R = ROTATIONS[ori];
  const p = SLOT_POS[slot];
  const n = matVec(R, DIRS[f.d]);
  const ux = matVec(R, f.ux);
  const uy = matVec(R, f.uy);
  const front: Vec3 = [p[0] + n[0], p[1] + n[1], p[2] + n[2]];
  const corner = [1, 1, 1, 1];
  for (let k = 0; k < 4; k++) {
    const [sx, sy] = CORNER_SIGNS[k];
    const a: Vec3 = [front[0] + sx * ux[0], front[1] + sx * ux[1], front[2] + sx * ux[2]];
    const b: Vec3 = [front[0] + sy * uy[0], front[1] + sy * uy[1], front[2] + sy * uy[2]];
    const c: Vec3 = [a[0] + sy * uy[0], a[1] + sy * uy[1], a[2] + sy * uy[2]];
    const s1 = filledAt(st, a) ? 1 : 0;
    const s2 = filledAt(st, b) ? 1 : 0;
    const level = s1 && s2 ? 0 : 3 - (s1 + s2 + (filledAt(st, c) ? 1 : 0));
    corner[k] = AO_LEVELS[level];
  }
  applyCorners(f, corner);
}

/** Write four corner brightness values onto a face, blended across it (any vertex layout). */
function applyCorners(f: AoFace, corner: number[]) {
  f.cur = corner.slice();
  const col = f.mesh.geometry.attributes.color;
  const arr = col.array as Float32Array;
  const pos = f.mesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const u = Math.max(0, Math.min(1, pos.getX(i) / f.extent + 0.5)); // 0 at -x, 1 at +x
    const w = Math.max(0, Math.min(1, pos.getY(i) / f.extent + 0.5)); // 0 at -y, 1 at +y
    const top = corner[0] * (1 - u) + corner[1] * u;
    const bottom = corner[2] * (1 - u) + corner[3] * u;
    const v = bottom * (1 - w) + top * w;
    arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = v;
  }
  col.needsUpdate = true;
}

// ------------------------------------------------------------------ shading while a layer turns
//
// "live" (real occlusion, recomputed every frame): the same three-spots-per-corner rule,
// but each spot's "filled" amount is continuous: it depends on how far the spot is from
// the nearest cubelet's center, measured in that cubelet's own (possibly tilted) frame.
// At rest every cubelet sits on the grid and this matches the grid shading exactly.
// "blend" (fallback): fade each face from its shading before the turn to after it.
// The page starts with "live" and switches to "blend" if "live" proves too slow here.

const SHADE_MODE_KEY = "xcube-lab-shade-mode";
let shadeMode: "live" | "blend" = (() => {
  try {
    return localStorage.getItem(SHADE_MODE_KEY) === "blend" ? "blend" : "live";
  } catch {
    return "live";
  }
})();
const LIVE_BUDGET_MS = 4; // average cost per frame above which we fall back
let liveCostTotal = 0;
let liveCostFrames = 0;

/** How "filled" a spot is, from its distance d to a cubelet center (cube-shaped distance). */
const fillAt = (d: number) => {
  if (d <= 0.35) return 1;
  if (d >= 0.75) return 0;
  const t = (0.75 - d) / 0.4;
  return t * t * (3 - 2 * t);
};

function levelBrightness(level: number) {
  const l = Math.max(0, Math.min(3, level));
  const i = Math.min(2, Math.floor(l));
  return AO_LEVELS[i] + (AO_LEVELS[i + 1] - AO_LEVELS[i]) * (l - i);
}

interface TurnPose {
  def: number;
  angle: number; // counterclockwise about the +axis of the move
  before: State; // the position before the turn
}

/** Rotate v about axis (0 x, 1 y, 2 z) by angle (radians, CCW). */
function rotAxis(axis: number, c: number, s: number, v: number[]): number[] {
  const [x, y, z] = v;
  if (axis === 0) return [x, c * y - s * z, s * y + c * z];
  if (axis === 1) return [c * x + s * z, y, -s * x + c * z];
  return [c * x - s * y, s * x + c * y, z];
}

/** Recompute shading for the faces near a turning layer, from where cubelets actually are. */
function shadeDuringTurn(pose: TurnPose) {
  if (!aoOn["3d"] && !aoOn.flat) return;
  const t0 = performance.now();
  const d = MOVE_DEFS[pose.def];
  const axis = d.axis;
  const c = Math.cos(pose.angle), sn = Math.sin(pose.angle);
  const st = pose.before;
  // Which cubelets turn, and where their centers are right now.
  const isMovingId = new Uint8Array(CUBELETS.length);
  const mx: number[] = [], my: number[] = [], mz: number[] = [];
  let lo = 9, hi = -9;
  for (const sl of d.slots) {
    const pp = SLOT_POS[sl];
    lo = Math.min(lo, pp[axis] - 1);
    hi = Math.max(hi, pp[axis] + 1);
    const id = st.occ[sl];
    if (id < 0) continue;
    isMovingId[id] = 1;
    const r = rotAxis(axis, c, sn, [pp[0], pp[1], pp[2]]);
    mx.push(r[0]);
    my.push(r[1]);
    mz.push(r[2]);
  }
  const nm = mx.length;
  const REACH2 = 0.75 * 0.75 * 3; // beyond this squared distance a cubelet can't fill the spot
  const staticAt = (x: number, y: number, z: number) => {
    if (x === 0 && y === 0 && z === 0) return true;
    const slot = slotAtXYZ(x, y, z);
    return slot >= 0 && st.occ[slot] >= 0 && !isMovingId[st.occ[slot]];
  };
  const filled = (qx: number, qy: number, qz: number) => {
    let best = 0;
    const x0 = Math.floor(qx + 1e-9), y0 = Math.floor(qy + 1e-9), z0 = Math.floor(qz + 1e-9);
    const x1 = Math.abs(qx - Math.round(qx)) < 1e-6 ? x0 : x0 + 1;
    const y1 = Math.abs(qy - Math.round(qy)) < 1e-6 ? y0 : y0 + 1;
    const z1 = Math.abs(qz - Math.round(qz)) < 1e-6 ? z0 : z0 + 1;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++)
          if (staticAt(x, y, z)) {
            const f = fillAt(Math.max(Math.abs(qx - x), Math.abs(qy - y), Math.abs(qz - z)));
            if (f > best) best = f;
          }
    if (best >= 1) return 1;
    for (let i = 0; i < nm; i++) {
      const dx = qx - mx[i], dy = qy - my[i], dz = qz - mz[i];
      if (dx * dx + dy * dy + dz * dz > REACH2) continue;
      // Distance measured in the turning frame (undo the turn's rotation).
      let ex = dx, ey = dy, ez = dz;
      if (axis === 0) { ey = c * dy + sn * dz; ez = -sn * dy + c * dz; }
      else if (axis === 1) { ex = c * dx - sn * dz; ez = sn * dx + c * dz; }
      else { ex = c * dx + sn * dy; ey = -sn * dx + c * dy; }
      const f = fillAt(Math.max(Math.abs(ex), Math.abs(ey), Math.abs(ez)));
      if (f > best) { best = f; if (best >= 1) return 1; }
    }
    return best;
  };
  const corner = [1, 1, 1, 1];
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    const id = st.occ[slot];
    if (id < 0) continue;
    const p = SLOT_POS[slot];
    if (p[axis] < lo || p[axis] > hi) continue;
    const moving = isMovingId[id] === 1;
    const R = ROTATIONS[st.ori[slot]];
    const center = moving ? rotAxis(axis, c, sn, [p[0], p[1], p[2]]) : [p[0], p[1], p[2]];
    const tf = (v: Vec3) => {
      const g = matVec(R, v);
      return moving ? rotAxis(axis, c, sn, [g[0], g[1], g[2]]) : [g[0], g[1], g[2]];
    };
    let lastD = -1;
    for (const f of aoFaces[id] ?? []) {
      if (!aoOn[f.view]) continue;
      if (f.d !== lastD) {
        lastD = f.d;
        const n = tf(DIRS[f.d]), ux = tf(f.ux), uy = tf(f.uy);
        const fx = center[0] + n[0], fy = center[1] + n[1], fz = center[2] + n[2];
        // A face covered by a cubelet that isn't moving can't be seen: leave it.
        if (!moving && staticAt(fx, fy, fz)) { corner[0] = -1; continue; }
        for (let k = 0; k < 4; k++) {
          const sx = CORNER_SIGNS[k][0], sy = CORNER_SIGNS[k][1];
          const ax = fx + sx * ux[0], ay = fy + sx * ux[1], az = fz + sx * ux[2];
          const s1 = filled(ax, ay, az);
          const s2 = filled(fx + sy * uy[0], fy + sy * uy[1], fz + sy * uy[2]);
          const s3 = filled(ax + sy * uy[0], ay + sy * uy[1], az + sy * uy[2]);
          corner[k] = levelBrightness((1 - s1 * s2) * (3 - (s1 + s2 + s3)));
        }
      }
      if (corner[0] >= 0) applyCorners(f, corner);
    }
  }
  // Watch the cost; fall back to blending if this device can't keep up.
  liveCostTotal += performance.now() - t0;
  liveCostFrames++;
  if (liveCostFrames >= 20 && liveCostTotal / liveCostFrames > LIVE_BUDGET_MS) {
    shadeMode = "blend";
    try {
      localStorage.setItem(SHADE_MODE_KEY, "blend");
    } catch {
      /* storage unavailable */
    }
    setMessage(`Shading during turns switched to a lighter method on this device (${(liveCostTotal / liveCostFrames).toFixed(1)} ms per frame was too slow).`, "info");
    render();
  }
}

/** Fallback: fade from shading before the turn to after it. */
let blendPlan: { face: AoFace; from: number[]; to: number[] }[] | null = null;
function planBlend(after: State) {
  const before: Map<AoFace, number[]> = new Map();
  for (const list of aoFaces) for (const f of list ?? []) if (f.cur) before.set(f, f.cur.slice());
  syncMeshes(after); // computes the "after" shading (and positions; the animation overrides them)
  blendPlan = [];
  for (const [f, from] of before) {
    const to = f.cur!;
    if (from.some((v, i) => Math.abs(v - to[i]) > 1e-3)) {
      blendPlan.push({ face: f, from, to: to.slice() });
      applyCorners(f, from);
    }
  }
}
function blendStep(t: number) {
  if (!blendPlan) return;
  for (const b of blendPlan) applyCorners(b.face, b.from.map((v, i) => v + (b.to[i] - v) * t));
}

/** Called each animation frame with the turning layer's current pose. */
function shadeTurnFrame(pose: TurnPose, progress: number) {
  if (shadeMode === "live") shadeDuringTurn(pose);
  else blendStep(progress);
}

/** For automated checks: largest change live shading makes at rest (should be ~0). */
(window as any).__xcubeShadeRestCheck = () => {
  let worst = 0;
  for (let def = 0; def < MOVE_DEFS.length; def++) {
    if (MOVE_DEFS[def].kind === "rotation") continue;
    const before = new Map<AoFace, number[]>();
    for (const list of aoFaces) for (const f of list ?? []) if (f.cur) before.set(f, f.cur.slice());
    const saveCost = [liveCostTotal, liveCostFrames];
    shadeDuringTurn({ def, angle: 0, before: app.current });
    [liveCostTotal, liveCostFrames] = saveCost;
    for (const [f, v] of before) for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.abs(v[i] - f.cur![i]));
    syncMeshes(app.current);
  }
  return worst;
};

/** For automated checks: average cost of live shading per frame so far. */
(window as any).__xcubeShadeCost = () => ({ mode: shadeMode, frames: liveCostFrames, avgMs: liveCostFrames ? liveCostTotal / liveCostFrames : 0 });

function applyShadingSettings() {
  syncMeshes(app.current);
  try {
    localStorage.setItem(AO_KEY, JSON.stringify(aoOn));
  } catch {
    /* storage unavailable */
  }
}

// ------------------------------------------------------------------ edge glow

const GLOW3D_LAYER = 3;
const GLOWNET_LAYER = 4;
const BODY_RADIUS = 0.05; // rounding of cubelet edges
// The glow band lies just below the face's surface (GLOW_DEPTH) and starts under the
// cubelet (GLOW_START), so the cubelet hides its inner part and the glow appears to
// come from right under the cubelet's edge from any viewing angle, with no gap.
const GLOW_DEPTH = 0.47;
const GLOW_START = 0.36;
const GLOW_WIDTH = 0.56;
const GLOW_SOLID = (0.495 - GLOW_START) / GLOW_WIDTH; // fraction kept at full strength (to just past the edge)
const glows: { mesh: any; a: number; b: number }[][] = [];
const GLOW_KEY = "xcube-lab-glow";
const glowOn = (() => {
  try {
    return { "3d": true, flat: true, ...JSON.parse(localStorage.getItem(GLOW_KEY) || "{}") } as { "3d": boolean; flat: boolean };
  } catch {
    return { "3d": true, flat: true };
  }
})();

/**
 * Glow material. The band lies in face A's plane and its local +Y axis points along
 * face B (the side face around the edge). The edge is a depth discontinuity only when
 * face B points away from the viewer or is edge-on; if you can see face B, the surface
 * just bends there and there is nothing to mark. So the glow fades out as face B turns
 * toward the camera. For the flat view's orthographic cameras, face B is exactly
 * edge-on, so the glow shows fully.
 */
function makeGlowMaterial(map: any, color: any) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, color: { value: color } },
    transparent: true,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      varying float vFade;
      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vec3 sideDir = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
        // Direction toward the viewer: constant for orthographic cameras.
        vec3 toViewer = projectionMatrix[3][3] == 1.0
          ? normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]))
          : normalize(cameraPosition - world.xyz);
        float facing = dot(sideDir, toViewer); // > 0: the side face is visible
        vFade = 1.0 - smoothstep(0.0, 0.2, facing);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `
      uniform sampler2D map;
      uniform vec3 color;
      varying vec2 vUv;
      varying float vFade;
      void main() {
        float a = texture2D(map, vUv).a * vFade;
        if (a < 0.003) discard;
        gl_FragColor = vec4(color, a);
      }`,
  });
}

/** White band, opaque at the edge (bottom) fading upward, tapered at both ends. */
function makeGlowTexture() {
  const W = 64, H = 32;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const v = 1 - y / (H - 1); // 0 at the edge (bottom of the image)
      const ends = smooth(Math.min(u, 1 - u) / 0.22);
      const fade = v <= GLOW_SOLID ? 1 : Math.pow(1 - (v - GLOW_SOLID) / (1 - GLOW_SOLID), 1.8);
      const a = fade * ends;
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 235);
    }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

function applyGlowSettings() {
  camera.layers.set(0);
  if (glowOn["3d"]) camera.layers.enable(GLOW3D_LAYER);
  for (const nc of netCams) {
    nc.cam.layers.set(NET_LAYER);
    if (glowOn.flat) nc.cam.layers.enable(GLOWNET_LAYER);
  }
  try {
    localStorage.setItem(GLOW_KEY, JSON.stringify(glowOn));
  } catch {
    /* storage unavailable */
  }
}

function resize() {
  const canvas = renderer.domElement as HTMLCanvasElement;
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 300;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // Back the camera off far enough that the puzzle (plus glow) fits the narrower dimension.
  const vHalf = (camera.fov * Math.PI) / 360;
  const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
  camera.position.set(0, 0, Math.max(12.5, 3.35 / Math.sin(Math.min(vHalf, hHalf))));
}

// Edge labels: which face of the puzzle points up, down, left, right and at you.
const COMPASS_FACES = ["R", "L", "U", "D", "F", "B"];
let compassKey = "";
function updateCompass() {
  const q = pivot.quaternion;
  const world = DIRS.map((d) => new THREE.Vector3(d[0], d[1], d[2]).applyQuaternion(q));
  const pick = (f: (v: any) => number) => {
    let best = 0;
    for (let i = 1; i < 6; i++) if (f(world[i]) > f(world[best])) best = i;
    return best;
  };
  const slots = { up: pick((v) => v.y), down: pick((v) => -v.y), left: pick((v) => -v.x), right: pick((v) => v.x), toward: pick((v) => v.z) };
  const key = JSON.stringify(slots) + app.cursor + app.baseLabel;
  if (key === compassKey) return;
  compassKey = key;
  for (const [where, d] of Object.entries(slots)) {
    const el = document.getElementById(`compass-${where}`);
    if (!el) continue;
    const c = faceCenterColor(app.current, d);
    el.dataset.face = String(d);
    el.setAttribute("aria-label", `Look at the ${COMPASS_FACES[d]} face`);
    el.innerHTML = `<i style="background:${c ? NET_COLOR[c] : "transparent"}"></i>${where === "toward" ? "Facing you: " : ""}${COMPASS_FACES[d]}`;
  }
}

/** Color of the center sticker currently showing on puzzle face d (outermost center along that axis). */
function faceCenterColor(st: State, d: number): Color | null {
  for (const k of [2, 1]) {
    const s = slotAt([DIRS[d][0] * k, DIRS[d][1] * k, DIRS[d][2] * k]);
    if (s >= 0 && st.occ[s] >= 0) return st.colorAt(s, d);
  }
  return null;
}

function frame() {
  if (tween) {
    const t = tween.ms ? Math.min(1, (performance.now() - tween.start) / tween.ms) : 1;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    pivot.quaternion.copy(tween.from).slerp(tween.to, e);
    if (t >= 1) tween = null;
  }
  tickAnimation();
  tickSettle();
  updateCompass();
  renderNetAnimation();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// Pointer input on the 3D view.
// - Swipe that starts on the cube: the layer under your finger turns and follows the
//   finger live; on release it settles to the nearest quarter turn (see beginLiveTurn).
// - Hold still on the cube for a moment, then drag: tumbles the view instead.
// - Drag that starts on the background: tumbles the view. Sliding sideways spins the
//   puzzle around its own vertical (U-D) axis like a turntable; up and down tips it.
// - Two fingers: twist around the axis pointing out of the screen.
const SWIPE_PX = 10;
const HOLD_TO_TUMBLE_MS = 350;
const LAYER_MOVE: Record<number, Record<number, string>> = {
  0: { 2: "r", 1: "R", 0: "M", [-1]: "L", [-2]: "l" },
  1: { 2: "u", 1: "U", 0: "H", [-1]: "D", [-2]: "d" },
  2: { 2: "f", 1: "F", 0: "S", [-1]: "B", [-2]: "b" },
};

interface CubeHit {
  point: any; // hit point, puzzle frame
  normal: Vec3; // face normal, puzzle frame (unit axis vector)
  cell: Vec3; // the touched cubelet's grid position, puzzle frame
}

function pickCube(el: HTMLElement, clientX: number, clientY: number): CubeHit | null {
  const rect = el.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.layers.set(0); // cubelet bodies and stickers only, not glow
  ray.setFromCamera(ndc, camera);
  const inv = pivot.quaternion.clone().invert();
  for (const h of ray.intersectObjects(pivot.children, true)) {
    if (!h.face) continue;
    let o = h.object;
    while (o.parent && o.parent !== pivot) o = o.parent;
    if (!meshes.includes(o)) continue;
    const n = h.face.normal.clone().transformDirection(h.object.matrixWorld).applyQuaternion(inv);
    // Snap to the nearest face direction (rounded edges give in-between normals).
    const ax = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
    const k = ax.indexOf(Math.max(...ax));
    const sgn = Math.sign([n.x, n.y, n.z][k]);
    const normal: Vec3 = [k === 0 ? sgn : 0, k === 1 ? sgn : 0, k === 2 ? sgn : 0];
    return {
      point: pivot.worldToLocal(h.point.clone()),
      normal,
      cell: [Math.round(o.position.x), Math.round(o.position.y), Math.round(o.position.z)],
    };
  }
  return null;
}

/** Screen position (CSS pixels within the canvas) of a point given in the puzzle frame. */
function toScreen(el: HTMLElement, p: any): [number, number] {
  const v = pivot.localToWorld(p.clone()).project(camera);
  return [((v.x + 1) / 2) * el.clientWidth, ((1 - v.y) / 2) * el.clientHeight];
}

/** A layer being turned by a finger. */
interface Live {
  group: any; // holds the turning cubelets
  axisVec: any; // +axis unit vector, puzzle frame
  def: number; // the move whose layer is turning
  sign: number; // +1 if moving the finger along the swipe direction turns CCW about +axis
  dirX: number; // on-screen unit direction of the swipe
  dirY: number;
  pxPerUnit: number; // screen pixels per world unit along that direction
  radius: number; // distance of the touched point from the turning axis
  x0: number;
  y0: number;
  t0: number;
  theta: number; // current angle, CCW about +axis
}
let live: Live | null = null;
let settle: { live: Live; from: number; to: number; start: number; ms: number } | null = null;

/**
 * Start turning the layer under a swipe. Of the two directions you can slide along
 * the touched face, take the one whose on-screen direction best matches the swipe.
 * Moving the face (normal n) toward direction m is a rotation about n x m; the touched
 * cubelet's position along that axis picks the layer: 1 = inner turn, 2 = outer
 * (extension) turn, 0 = middle slice.
 */
function beginLiveTurn(el: HTMLElement, hit: CubeHit, x0: number, y0: number, dx: number, dy: number): Live | null {
  const len = Math.hypot(dx, dy);
  const [sx, sy] = toScreen(el, hit.point);
  let best: { m: Vec3; score: number; vx: number; vy: number; vl: number } | null = null;
  for (let axis = 0; axis < 3; axis++) {
    if (hit.normal[axis] !== 0) continue;
    const a: Vec3 = [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0];
    const [ex, ey] = toScreen(el, hit.point.clone().add(new THREE.Vector3(a[0] * 0.4, a[1] * 0.4, a[2] * 0.4)));
    const vx = ex - sx, vy = ey - sy;
    const vl = Math.hypot(vx, vy) || 1;
    const score = (dx * vx + dy * vy) / (len * vl);
    if (!best || Math.abs(score) > Math.abs(best.score)) {
      const sg = score >= 0 ? 1 : -1;
      best = { m: [a[0] * sg, a[1] * sg, a[2] * sg], score, vx: vx * sg, vy: vy * sg, vl };
    }
  }
  if (!best) return null;
  const n = hit.normal, m = best.m;
  const r: Vec3 = [n[1] * m[2] - n[2] * m[1], n[2] * m[0] - n[0] * m[2], n[0] * m[1] - n[1] * m[0]];
  const axis = r.findIndex((v) => v !== 0);
  const def = MOVE_BY_NAME.get(LAYER_MOVE[axis][hit.cell[axis]])!;
  const why = blockedReason(app.current, { def, amount: 1 });
  if (why) {
    setMessage(`${MOVE_DEFS[def].name} refused: ${why.replace(/^\w+ blocked: /, "")}`, "error");
    render();
    return null;
  }
  const group = new THREE.Group();
  pivot.add(group);
  for (const s of MOVE_DEFS[def].slots) {
    const id = app.current.occ[s];
    if (id >= 0) group.attach(meshes[id]);
  }
  const p = [hit.point.x, hit.point.y, hit.point.z];
  const radius = Math.max(0.8, Math.hypot(...p.filter((_, i) => i !== axis)));
  return {
    group,
    axisVec: new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0),
    def,
    sign: r[axis],
    dirX: best.vx / best.vl,
    dirY: best.vy / best.vl,
    pxPerUnit: best.vl / 0.4,
    radius,
    x0,
    y0,
    t0: performance.now(),
    theta: 0,
  };
}

function updateLiveTurn(l: Live, x: number, y: number) {
  const along = (x - l.x0) * l.dirX + (y - l.y0) * l.dirY; // pixels along the swipe direction
  l.theta = (l.sign * (along / l.pxPerUnit)) / l.radius;
  l.group.quaternion.setFromAxisAngle(l.axisVec, l.theta);
  if (shadeMode === "live") shadeDuringTurn({ def: l.def, angle: l.theta, before: app.current });
}

/** Finger lifted: settle to the nearest quarter turn (27 degrees is enough; a quick flick counts). */
function releaseLiveTurn(l: Live) {
  const quarter = Math.PI / 2;
  const turns = l.theta / quarter;
  let q = Math.sign(turns) * Math.floor(Math.abs(turns) + 0.7);
  const quick = performance.now() - l.t0 < 250;
  if (q === 0 && quick && Math.abs(turns) > 0.08) q = Math.sign(turns);
  const ms = reduceMotion ? 0 : Math.min(220, 60 + Math.abs(q * quarter - l.theta) * 160);
  settle = { live: l, from: l.theta, to: q * quarter, start: performance.now(), ms };
}

function tickSettle() {
  if (!settle) return;
  const { live: l, from, to, start, ms } = settle;
  const t = ms ? Math.min(1, (performance.now() - start) / ms) : 1;
  const e = 1 - Math.pow(1 - t, 3);
  l.group.quaternion.setFromAxisAngle(l.axisVec, from + (to - from) * e);
  if (shadeMode === "live") shadeDuringTurn({ def: l.def, angle: from + (to - from) * e, before: app.current });
  if (t < 1) return;
  settle = null;
  finishLiveTurn(l, Math.round(to / (Math.PI / 2)));
}

/** Put the turned cubelets back and record the turn (q = counterclockwise quarters about +axis). */
function finishLiveTurn(l: Live, q: number) {
  for (const child of [...l.group.children]) pivot.attach(child);
  pivot.remove(l.group);
  if (live === l) live = null;
  const amount = ((((q * MOVE_DEFS[l.def].ccw) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  if (amount) {
    app.history = app.history.slice(0, app.cursor);
    app.history.push({ def: l.def, amount });
    app.cursor++;
    recompute();
    setMessage("");
  }
  syncMeshes(app.current);
  render();
}

/** Drop a turn in progress without recording it. */
function cancelLiveTurn() {
  if (settle) {
    const l = settle.live;
    settle = null;
    finishLiveTurn(l, Math.round(l.theta / (Math.PI / 2)));
  }
  if (live) {
    const l = live;
    live = null;
    finishLiveTurn(l, 0);
  }
}

// Test hook (harmless): lets automated checks ask what a screen point would hit.
(window as any).__xcubePick = (x: number, y: number) => {
  const h = pickCube(renderer.domElement, x, y);
  return h && { normal: h.normal, cell: h.cell, point: [h.point.x, h.point.y, h.point.z] };
};

function bindOrbit(el: HTMLElement) {
  const stage = el.parentElement!;
  // iOS starts text selection / the callout on a long press unless the touch's default
  // action is cancelled. Pointer events still arrive after this.
  el.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  el.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  for (const t of ["contextmenu", "selectstart", "dragstart"]) el.addEventListener(t, (e) => e.preventDefault());
  const pts = new Map<number, { x: number; y: number }>();
  let twist: number | null = null;
  // A finger that went down on the cube and hasn't yet become a turn or a tumble.
  let pending: { id: number; x: number; y: number; hit: CubeHit; timer: ReturnType<typeof setTimeout> } | null = null;
  let liveId: number | null = null;
  let ignore = false; // the gesture was used up (e.g. a refused turn)
  const spin = (q: Quat) => {
    tween = null;
    const t = new THREE.Quaternion(q[0], q[1], q[2], q[3]);
    pivot.quaternion.premultiply(t).normalize();
  };
  const angleOf = () => {
    const [a, b] = [...pts.values()];
    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  const clearPending = () => {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  };
  el.addEventListener("pointerdown", (e) => {
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable (e.g. a synthetic event); tracking still works */
    }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      ignore = false;
      const busy = anim || queue.length || settle;
      const hit = busy ? null : pickCube(el, e.clientX, e.clientY);
      if (hit) {
        const id = e.pointerId;
        pending = {
          id,
          x: e.clientX,
          y: e.clientY,
          hit,
          timer: setTimeout(() => {
            // Held still: this drag tumbles the view.
            if (pending && pending.id === id) {
              pending = null;
              stage.classList.add("tumbling");
            }
          }, HOLD_TO_TUMBLE_MS),
        };
      }
    } else {
      // A second finger: twist. Abandon anything a single finger started.
      clearPending();
      if (live) {
        cancelLiveTurn();
        liveId = null;
      }
    }
    twist = pts.size === 2 ? angleOf() : null;
  });
  el.addEventListener("pointermove", (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pending && e.pointerId === pending.id) {
      const tx = e.clientX - pending.x, ty = e.clientY - pending.y;
      if (Math.hypot(tx, ty) < SWIPE_PX) return;
      const p0 = pending;
      clearPending();
      flushAnimations();
      live = beginLiveTurn(el, p0.hit, p0.x, p0.y, tx, ty);
      liveId = live ? e.pointerId : null;
      if (!live) ignore = true;
      else updateLiveTurn(live, e.clientX, e.clientY);
      return;
    }
    if (live && e.pointerId === liveId) {
      updateLiveTurn(live, e.clientX, e.clientY);
      return;
    }
    if (ignore || live) return;
    if (pts.size === 1) {
      tween = null;
      const yaw = axisQuat(0, 1, 0, dx * 0.01);
      pivot.quaternion.multiply(new THREE.Quaternion(yaw[0], yaw[1], yaw[2], yaw[3]));
      spin(axisQuat(1, 0, 0, dy * 0.01));
    } else if (pts.size === 2 && twist !== null) {
      const a = angleOf();
      let d = a - twist;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      twist = a;
      spin(axisQuat(0, 0, 1, -d));
    }
  });
  const up = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    if (pending && pending.id === e.pointerId) {
      // Lifted before any move crossed the threshold. If the finger did travel (a fast
      // flick whose moves the browser batched), treat it as a flick; otherwise a tap.
      const p0 = pending;
      clearPending();
      const tx = e.clientX - p0.x, ty = e.clientY - p0.y;
      if (Math.hypot(tx, ty) >= SWIPE_PX) {
        flushAnimations();
        const l = beginLiveTurn(el, p0.hit, p0.x, p0.y, tx, ty);
        if (l) {
          updateLiveTurn(l, e.clientX, e.clientY);
          releaseLiveTurn(l);
        }
      }
    }
    if (live && liveId === e.pointerId) {
      const l = live;
      live = null;
      liveId = null;
      releaseLiveTurn(l);
    }
    if (pts.size === 0) {
      stage.classList.remove("tumbling");
      ignore = false;
    }
    twist = pts.size === 2 ? angleOf() : null;
  };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

// ------------------------------------------------------------------ turn animation

interface Anim {
  before: State;
  turn: Turn;
  forward: boolean;
  start: number;
  duration: number;
  group: any;
  axis: any;
  angle: number;
  after: State;
}
let anim: Anim | null = null;
const queue: { turn: Turn; forward: boolean }[] = [];
const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
// Speed slider 0..100 maps logarithmically from 800 ms (slowest) to 30 ms (fastest) per quarter turn.
const speedFromSlider = (v: number) => 800 * Math.pow(30 / 800, v / 100);
let speedMs = speedFromSlider(42);
/** True while "play" is running through the remaining turns. */
let playing = false;

function enqueue(turn: Turn, forward: boolean) {
  queue.push({ turn, forward });
}

function startNext() {
  const job = queue.shift();
  if (!job) return;
  showNetAnimation(true);
  const { turn, forward } = job;
  const before = app.current;
  // Move the cursor and compute the end state first.
  if (forward) app.cursor++;
  else app.cursor--;
  recompute();
  const after = app.current;
  const d = MOVE_DEFS[turn.def];
  const amount = forward ? turn.amount : 4 - turn.amount;
  const duration = reduceMotion ? 0 : speedMs * (amount === 2 ? 1.4 : 1);
  const group = new THREE.Group();
  pivot.add(group);
  for (const s of d.slots) {
    const id = before.occ[s];
    if (id >= 0) group.attach(meshes[id]);
  }
  const axis = new THREE.Vector3(d.axis === 0 ? 1 : 0, d.axis === 1 ? 1 : 0, d.axis === 2 ? 1 : 0);
  const q = ((d.ccw * amount) % 4 + 4) % 4;
  const angle = (q === 3 ? -1 : q) * (Math.PI / 2);
  anim = { turn, forward, start: performance.now(), duration, group, axis, angle, after, before };
  if (shadeMode === "blend") {
    // planBlend moves meshes to the "after" layout; put the turning ones back for the animation.
    planBlend(after);
    syncMeshes(before);
    for (const s of d.slots) {
      const id = before.occ[s];
      if (id >= 0) group.attach(meshes[id]);
    }
  }
  render();
}

function finishAnim() {
  if (!anim) return;
  for (const child of [...anim.group.children]) pivot.attach(child);
  pivot.remove(anim.group);
  syncMeshes(anim.after);
  anim = null;
  if (!queue.length) showNetAnimation(false);
}

// ------------------------------------------------------------------ flat view animation
//
// The flat view is drawn by six orthographic cameras looking at the same scene, one per
// face, laid over the flat-view boxes. They see the unlit face planes (layer 2) and,
// when enabled, the edge glow (layer 4). Because it is the same scene, it animates.

const NET_LAYER = 2;
let netRenderer: any = null;
const netCams: { cam: any; face: string; view: number[]; up: number[] }[] = [];

function initNetAnimation() {
  const canvas = $("net-canvas") as HTMLCanvasElement;
  netRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  matchR128Look(netRenderer);
  netRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  netRenderer.setScissorTest(true);
  netRenderer.setClearColor(0x000000, 0);
  // [face, direction toward the viewer, screen-up direction] in the puzzle's own frame
  const faces: [string, number[], number[]][] = [
    ["U", [0, 1, 0], [0, 0, -1]],
    ["D", [0, -1, 0], [0, 0, 1]],
    ["F", [0, 0, 1], [0, 1, 0]],
    ["B", [0, 0, -1], [0, 1, 0]],
    ["R", [1, 0, 0], [0, 1, 0]],
    ["L", [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [face, view, up] of faces) {
    const cam = new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 40);
    cam.layers.set(NET_LAYER);
    netCams.push({ cam, face, view, up });
  }
  applyGlowSettings();
}

function showNetAnimation(_on: boolean) {
  /* the flat view is always drawn by the cameras now */
}

function renderNetAnimation() {
  if (!netRenderer) return;
  const net = $("net");
  const canvas = $("net-canvas");
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const size = netRenderer.getSize(new THREE.Vector2());
  if (size.x !== w || size.y !== h) netRenderer.setSize(w, h, false);
  netRenderer.setScissor(0, 0, w, h);
  netRenderer.setViewport(0, 0, w, h);
  netRenderer.clear();
  const q = pivot.quaternion;
  for (const el of net.querySelectorAll<HTMLElement>(".netface")) {
    const name = el.querySelector(".netlabel")?.textContent ?? "";
    const nc = netCams.find((c) => c.face === name);
    if (!nc) continue;
    const fw = el.offsetWidth;
    const half = 3.15; // world units from the center to the edge of each face box (room for the glow)
    const cam = nc.cam;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.updateProjectionMatrix();
    const pos = new THREE.Vector3(nc.view[0], nc.view[1], nc.view[2]).multiplyScalar(10).applyQuaternion(q);
    cam.position.copy(pos);
    cam.up.set(nc.up[0], nc.up[1], nc.up[2]).applyQuaternion(q);
    cam.lookAt(0, 0, 0);
    const x = el.offsetLeft, y = h - el.offsetTop - el.offsetHeight;
    netRenderer.setViewport(x, y, fw, el.offsetHeight);
    netRenderer.setScissor(x, y, fw, el.offsetHeight);
    netRenderer.render(scene, cam);
  }
}

function tickAnimation() {
  if (!anim && queue.length) startNext();
  if (!anim) return;
  const t = anim.duration ? Math.min(1, (performance.now() - anim.start) / anim.duration) : 1;
  const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  anim.group.quaternion.setFromAxisAngle(anim.axis, anim.angle * e);
  shadeTurnFrame({ def: anim.turn.def, angle: anim.angle * e, before: anim.before }, e);
  if (t >= 1) {
    finishAnim();
    if (playing && !queue.length) {
      playing = false;
      render();
    }
  }
}

function flushAnimations() {
  cancelLiveTurn();
  queue.length = 0;
  playing = false;
  showNetAnimation(false);
  if (anim) finishAnim();
  syncMeshes(app.current);
}

// ------------------------------------------------------------------ actions

function setMessage(text: string, kind: "info" | "error" | "ok" = "info") {
  app.message = text;
  app.messageKind = kind;
}

/** Tap a move button: add the turn at the cursor (discarding any "redo" turns). */
function doTurn(turn: Turn) {
  flushAnimations();
  const why = blockedReason(app.current, turn);
  if (why) {
    setMessage(`${turnName(turn)} refused: ${why.replace(/^\w+ blocked: /, "")}`, "error");
    render();
    return;
  }
  app.history = app.history.slice(0, app.cursor);
  app.history.push(turn);
  setMessage("");
  enqueue(turn, true);
}

/** Run an algorithm from the current position: replaces any turns after the cursor. */
function runAlg(src: string, play: boolean) {
  flushAnimations();
  let turns: Turn[];
  try {
    turns = parseAlg(src);
  } catch (e) {
    setMessage(e instanceof ParseError ? e.message : String(e), "error");
    render();
    return;
  }
  if (!turns.length) {
    setMessage("Type some moves first, for example (R U2)5", "error");
    render();
    return;
  }
  // Check legality up front so the stop point is known.
  const probe = app.current.clone();
  let ok = turns.length;
  let why: string | null = null;
  for (let i = 0; i < turns.length; i++) {
    why = blockedReason(probe, turns[i]);
    if (why) {
      ok = i;
      break;
    }
    applyTurn(probe, turns[i]);
  }
  const startCursor = app.cursor;
  app.history = app.history.slice(0, app.cursor).concat(turns.slice(0, ok));
  if (why) setMessage(`Stops at turn ${ok + 1} of ${turns.length} (${turnName(turns[ok])}): ${why.replace(/^\w+ blocked: /, "")}`, "error");
  else setMessage(`${turns.length} turns loaded`, "ok");
  if (play) for (let i = startCursor; i < app.history.length; i++) enqueue(app.history[i], true);
  playing = play && queue.length > 0;
  render();
}

function step(dir: 1 | -1) {
  if (anim || queue.length) flushAnimations();
  if (dir > 0 && app.cursor < app.history.length) enqueue(app.history[app.cursor], true);
  if (dir < 0 && app.cursor > 0) enqueue(app.history[app.cursor - 1], false);
}

function jump(to: number) {
  flushAnimations();
  app.cursor = Math.max(0, Math.min(app.history.length, to));
  recompute();
  syncMeshes(app.current);
  render();
}

function playToEnd() {
  flushAnimations();
  for (let i = app.cursor; i < app.history.length; i++) enqueue(app.history[i], true);
  playing = queue.length > 0;
  render();
}

/** Stop playing: the turn in progress finishes, the rest wait. */
function stopPlaying() {
  queue.length = 0;
  playing = false;
  render();
}

function setBase(st: State, label: string) {
  flushAnimations();
  app.base = st.clone();
  app.baseLabel = label;
  app.history = [];
  app.cursor = 0;
  recompute();
  syncMeshes(app.current);
  render();
}

// ------------------------------------------------------------------ saved states

interface Saved {
  id: string;
  name: string;
  code: string;
  note?: string;
  savedAt: number;
  source?: string;
}
let saved: Saved[] = [];
let storeKind: "loading" | "shared" | "device" = "loading";
let db: any = null;
const LS_KEY = "xcube-lab-saved";
let pendingDelete: string | null = null;

function readDevice(): Saved[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "[]");
  } catch {
    return [];
  }
}
function writeDevice(list: Saved[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

async function initStore() {
  let ns: any = null;
  try {
    ns = await (window as any).claude?.use?.("db");
  } catch {
    ns = null;
  }
  if (!ns) {
    storeKind = "device";
    saved = readDevice();
    render();
    return;
  }
  db = ns;
  storeKind = "shared";
  const timer = setTimeout(() => {
    if (!saved.length) setMessage("Saved states can't be reached yet.", "info");
    render();
  }, 10000);
  db.collection("states").onSnapshot(
    (snap: any) => {
      if (!snap.metadata.fromCache) clearTimeout(timer);
      saved = snap.docs
        .map((d: any) => ({ id: d.id, ...(d.data() as object) }) as Saved)
        .sort((a: Saved, b: Saved) => (b.savedAt || 0) - (a.savedAt || 0));
      render();
    },
    (err: any) => {
      clearTimeout(timer);
      setMessage(`Saved states unavailable (${err.code}).`, "error");
      render();
    },
  );
}

async function saveCurrent(name: string, note: string) {
  const entry = {
    name: name || `State ${new Date().toLocaleString()}`,
    code: encodeState(app.current),
    note: note || formatAlgSummary(),
    savedAt: Date.now(),
    source: "page",
  };
  if (storeKind === "shared" && db) {
    try {
      await db.collection("states").add(entry);
      setMessage(`Saved "${entry.name}"`, "ok");
    } catch (e: any) {
      setMessage(`Could not save: ${e?.message ?? e}`, "error");
    }
  } else {
    const list = readDevice();
    list.unshift({ id: String(Date.now()), ...entry });
    writeDevice(list);
    saved = list;
    setMessage(`Saved "${entry.name}" on this device`, "ok");
  }
  render();
}

async function deleteSaved(id: string) {
  if (storeKind === "shared" && db) {
    try {
      await db.collection("states").doc(id).delete();
    } catch (e: any) {
      setMessage(`Could not delete: ${e?.message ?? e}`, "error");
    }
  } else {
    saved = readDevice().filter((s) => s.id !== id);
    writeDevice(saved);
  }
  pendingDelete = null;
  render();
}

function formatAlgSummary(): string {
  const done = app.history.slice(0, app.cursor);
  return `${app.baseLabel}${done.length ? " + " + formatAlg(done) : ""}`;
}

// ------------------------------------------------------------------ UI

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function chip(text: string, cls: string, title = "") {
  return `<span class="chip ${cls}" title="${title}">${text}</span>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function render() {
  const st = app.current;
  // status
  const shape = isHomeX(st) ? chip("X shape", "good") : isXShape(st) ? chip("X shape, tipped", "good") : chip("Out of shape", "warn");
  const solved = isSolved(st) ? chip("Solved", "good") : "";
  const outer = outerAvailability(st)
    .map(([n, c]) => chip(c === 9 ? n : `${n} ${c}/9`, c === 9 ? "on" : "off", c === 9 ? `${n} can turn` : `${n} refuses: ${c} of 9 cubelets`))
    .join("");
  $("status").innerHTML = `${shape}${solved}<span class="outer-label">Outer turns</span>${outer}`;

  // message
  const msg = $("message");
  msg.textContent = app.message;
  msg.className = `message ${app.messageKind}`;
  msg.hidden = !app.message;

  // history strip
  const hist = app.history
    .map((t, i) => `<button class="tok ${i < app.cursor ? "done" : ""} ${i === app.cursor - 1 ? "cur" : ""}" data-jump="${i + 1}">${turnName(t)}</button>`)
    .join("");
  $("history").innerHTML = hist || `<span class="hint">Turns you make or run appear here. Tap one to jump to it.</span>`;
  $("counter").textContent = `${app.cursor} / ${app.history.length}`;
  const play = $("last");
  play.textContent = playing ? "■" : "▶";
  play.setAttribute("aria-label", playing ? "Stop" : "Play to the end");
  play.classList.toggle("stop", playing);
  $("base-label").textContent = app.baseLabel;

  // modifier buttons
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-mod]")) b.classList.toggle("sel", Number(b.dataset.mod) === app.modifier);
  // outer move buttons: show disabled when blocked
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-move]")) {
    const def = MOVE_BY_NAME.get(b.dataset.move!)!;
    const blocked = blockedReason(st, { def, amount: 1 });
    b.classList.toggle("blocked", !!blocked);
    const held = b.classList.contains("inverted");
    b.textContent = b.dataset.move! + suffixFor(held ? invertAmount(app.modifier) : app.modifier);
  }

  // effect vs base
  const eff = effect(app.base, st);
  $("effect").innerHTML = app.cursor
    ? `<p><strong>${eff.moved.length}</strong> cubelets moved, <strong>${eff.twisted.length}</strong> turned in place, <strong>${eff.visibleChanges}</strong> visible faces changed${eff.shapeSame ? "" : ", shape changed"}.</p>` +
      (eff.cycles.length && eff.moved.length <= 12
        ? `<ul class="cycles">${eff.cycles.map((c) => `<li><code>${escapeHtml(c)}</code></li>`).join("")}</ul>`
        : "")
    : `<p class="hint">Make some turns to see what they did, compared with the start position.</p>`;

  // flat view
  renderNet(st);

  // saved list
  const where = storeKind === "shared" ? "Shared with Claude" : storeKind === "device" ? "This device only" : "Loading";
  $("store-kind").textContent = where;
  $("saved-list").innerHTML = saved.length
    ? saved
        .map(
          (s) => `<li>
        <div class="saved-main"><span class="saved-name">${escapeHtml(s.name)}</span>
        <span class="saved-note">${escapeHtml(s.note ?? "")}${s.source === "claude" ? " · from Claude" : ""}</span></div>
        <div class="saved-actions">
          <button class="btn small" data-load="${s.id}">Start here</button>
          ${pendingDelete === s.id ? `<button class="btn small danger" data-del-yes="${s.id}">Delete</button><button class="btn small" data-del-no="1">Keep</button>` : `<button class="btn small ghost" data-del="${s.id}" aria-label="Delete ${escapeHtml(s.name)}">✕</button>`}
        </div></li>`,
        )
        .join("")
    : `<li class="hint">No saved states yet. Save the current position to come back to it later.</li>`;
  ($("code-out") as HTMLTextAreaElement).value = encodeState(st);
}

const NET_COLOR: Record<string, string> = { W: "#f3f3ee", Y: "#f5d00f", G: "#17a34a", B: "#1d5fd6", R: "#c8202b", O: "#f47a12", "#": "var(--unstickered)" };

/** Flat view layout: one labeled box per face; the cameras draw into these boxes. */
let netBuilt = false;
function renderNet(_st: State) {
  if (netBuilt) return;
  netBuilt = true;
  const faces: [string, number, number][] = [
    ["U", 1, 0],
    ["L", 0, 1],
    ["F", 1, 1],
    ["R", 2, 1],
    ["B", 3, 1],
    ["D", 1, 2],
  ];
  $("net").innerHTML = faces
    .map(([name, col, row]) => `<div class="netface" style="grid-column:${col + 1};grid-row:${row + 1}"><span class="netlabel" aria-hidden="true">${name}</span></div>`)
    .join("");
}

const suffixFor = (a: 1 | 2 | 3) => (a === 1 ? "" : a === 2 ? "2" : "'");
const invertAmount = (a: 1 | 2 | 3) => (4 - a) as 1 | 2 | 3;

function pressMove(name: string, inverted: boolean) {
  const amount = inverted ? invertAmount(app.modifier) : app.modifier;
  doTurn({ def: MOVE_BY_NAME.get(name)!, amount });
  if (app.modifier !== 1 && !($("sticky-mod") as HTMLInputElement).checked) app.modifier = 1;
  render();
}

/**
 * Turn buttons: a tap does the shown turn. Hold for about half a second and the
 * button flips to the opposite direction (U becomes U'); releasing does that turn.
 * Sliding off the button before releasing does nothing.
 */
const LONG_PRESS_MS = 450;
function bindMoveButtons() {
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-move]")) {
    const name = b.dataset.move!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: number | null = null;
    let long = false;
    const show = (inverted: boolean) => {
      const amount = inverted ? invertAmount(app.modifier) : app.modifier;
      b.textContent = name + suffixFor(amount);
      b.classList.toggle("inverted", inverted);
    };
    const reset = () => {
      clearTimeout(timer);
      active = null;
      long = false;
      show(false);
    };
    b.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // Touch pointers are captured by default; release so sliding off is noticed.
      if (b.hasPointerCapture(e.pointerId)) b.releasePointerCapture(e.pointerId);
      active = e.pointerId;
      long = false;
      timer = setTimeout(() => {
        long = true;
        show(true);
      }, LONG_PRESS_MS);
    });
    b.addEventListener("pointerup", (e) => {
      if (e.pointerId !== active) return;
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("button") === b;
      const inverted = long;
      reset();
      if (over) pressMove(name, inverted);
    });
    b.addEventListener("pointerleave", (e) => {
      if (e.pointerId === active) reset();
    });
    b.addEventListener("pointercancel", reset);
    b.addEventListener("contextmenu", (e) => e.preventDefault());
    // Keyboard activation (Enter / Space) arrives as a click with detail 0.
    b.addEventListener("click", (e) => {
      if (e.detail === 0) pressMove(name, false);
    });
  }
}

function bindUI() {
  document.addEventListener("click", async (e) => {
    const t = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
    if (!t) return;
    const ds = t.dataset;
    if (ds.mod) {
      app.modifier = Number(ds.mod) as 1 | 2 | 3;
      render();
    } else if (ds.jump) jump(Number(ds.jump));
    else if (ds.load) {
      const s = saved.find((x) => x.id === ds.load);
      if (s) {
        try {
          setBase(decodeState(s.code), s.name);
          setMessage(`Started from "${s.name}"`, "ok");
        } catch (err) {
          setMessage(`That saved state can't be read: ${err}`, "error");
        }
        render();
      }
    } else if (ds.del) {
      pendingDelete = ds.del;
      render();
    } else if (ds.delYes) await deleteSaved(ds.delYes);
    else if (ds.delNo) {
      pendingDelete = null;
      render();
    }
  });
  $("run").addEventListener("click", () => runAlg(($("alg") as HTMLInputElement).value, true));
  $("load").addEventListener("click", () => runAlg(($("alg") as HTMLInputElement).value, false));
  $("alg").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") runAlg(($("alg") as HTMLInputElement).value, true);
  });
  $("back").addEventListener("click", () => step(-1));
  $("fwd").addEventListener("click", () => step(1));
  $("first").addEventListener("click", () => jump(0));
  $("last").addEventListener("click", () => (playing ? stopPlaying() : playToEnd()));
  $("undo").addEventListener("click", () => {
    if (app.cursor > 0) {
      flushAnimations();
      const last = app.history[app.cursor - 1];
      app.history = app.history.slice(0, app.cursor - 1);
      enqueue(last, false);
      setMessage("");
      render();
    }
  });
  $("reset").addEventListener("click", () => {
    setBase(State.solved(), "Solved");
    setMessage("Reset to solved", "ok");
    render();
  });
  $("rebase").addEventListener("click", () => {
    setBase(app.current, "Current position");
    setMessage("This position is now the start", "ok");
    render();
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-view]"))
    b.addEventListener("click", () => {
      const name = b.dataset.view!;
      const q = VIEWS[name];
      if (q) goToView(q);
    });
  // Tapping an edge label turns the view to look straight at that face.
  const FACE_VIEW = ["right", "left", "top", "bottom", "front", "back"];
  for (const el of document.querySelectorAll<HTMLElement>(".cmp"))
    el.addEventListener("click", () => {
      const d = Number(el.dataset.face);
      if (Number.isInteger(d)) goToView(VIEWS[FACE_VIEW[d]]);
    });
  $("speed").addEventListener("input", (e) => (speedMs = speedFromSlider(Number((e.target as HTMLInputElement).value))));
  bindMoveButtons();
  // One switch each for glow and shading; each applies to both the 3D and flat views.
  const shade = $("shade") as HTMLInputElement;
  shade.checked = aoOn["3d"] && aoOn.flat;
  shade.addEventListener("change", () => {
    aoOn["3d"] = aoOn.flat = shade.checked;
    if (!anim) applyShadingSettings();
  });
  const glow = $("glow") as HTMLInputElement;
  glow.checked = glowOn["3d"] && glowOn.flat;
  glow.addEventListener("change", () => {
    glowOn["3d"] = glowOn.flat = glow.checked;
    applyGlowSettings();
  });
  $("save").addEventListener("click", () => {
    const n = $("save-name") as HTMLInputElement;
    saveCurrent(n.value.trim(), "");
    n.value = "";
  });
  $("copy-code").addEventListener("click", async () => {
    const ta = $("code-out") as HTMLTextAreaElement;
    try {
      await navigator.clipboard.writeText(ta.value);
      setMessage("State code copied", "ok");
    } catch {
      ta.select();
      setMessage("Select and copy the code below", "info");
    }
    render();
  });
  $("import").addEventListener("click", () => {
    const v = ($("code-in") as HTMLTextAreaElement).value.trim();
    try {
      setBase(decodeState(v), "Imported state");
      setMessage("Imported", "ok");
    } catch (err) {
      setMessage(`Couldn't import: ${(err as Error).message}`, "error");
    }
    render();
  });
}

function hotBoot() {
  const hot = (window as any).claude?.hot;
  const start = (data: any) => {
    try {
      if (data?.base) {
        app.base = decodeState(data.base);
        app.baseLabel = data.baseLabel ?? "Restored";
        app.history = parseAlg(data.history ?? "");
        app.cursor = Math.min(app.history.length, data.cursor ?? 0);
      }
    } catch {
      /* fall back to solved */
    }
    recompute();
    bindUI();
    initScene($("scene") as HTMLCanvasElement);
    render();
    initStore();
  };
  hot?.snapshot?.(() => ({ base: encodeState(app.base), baseLabel: app.baseLabel, history: formatAlg(app.history), cursor: app.cursor }));
  if (hot?.ready) hot.ready(start);
  else start(hot?.data ?? {});
}

void FACE_COLOR;
hotBoot();
