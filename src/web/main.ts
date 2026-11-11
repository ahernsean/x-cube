// X-Cube Lab: browser viewer. Uses the same engine as the CLI.
// three.js r128 is loaded as a global from cdnjs by the page.

import { isHomeX, isSolved, isXShape, isExposed, outerAvailability } from "../core/analyze.ts";
import { DIRS, ROT_DIR, ROT_INV, ROTATIONS, dirIndex, matVec, type Vec3 } from "../core/geometry.ts";
import { formatAlg, parseAlg, ParseError } from "../core/notation.ts";
import {
  COLOR_NAME,
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
  slotName,
  turnName,
  type Color,
  type Turn,
} from "../core/puzzle.ts";
import { decodeState, encodeState, unreachableReason } from "../core/serialize.ts";
import { fitColors, visibleColors, type FaceColors, type Fit } from "../core/edit.ts";
import { KNOWN_ALGORITHMS } from "../core/algorithms.ts";
import { solveSteps, type SolveStep } from "../core/solve.ts";

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
/** Light levels (tuned by comparing renders; yellow must stay distinct from white). */
const LIGHT = { env: 0.45, key: 0.45, plasticRough: 0.28, plasticSpec: 6, plasticEnv: 0.22, coat: 0.5, coatRough: 0.1, stickerRough: 0.6, stickerSpec: 0.5, filmCoat: 1, filmNormal: 0.35, exposure: 1.15, shadowSoft: 12 };
let keyLight: any = null;
let envTex: any = null;
const SHADOW_KEY = "xcube-lab-shadows";
let shadowsOn = (() => {
  try {
    return localStorage.getItem(SHADOW_KEY) !== "0";
  } catch {
    return true;
  }
})();
const GLOSS_KEY = "xcube-lab-gloss";
let glossOn = (() => {
  try {
    return localStorage.getItem(GLOSS_KEY) !== "0";
  } catch {
    return true;
  }
})();
/** Sticker materials, so the gloss switch can change them in place. */
const stickerMats: any[] = [];
let filmTex: { normal: any; rough: any } | null = null;

/**
 * The look of a laminated sticker: a thin clear film over the color, with fine crinkles,
 * tiny nicks and dents, and patches where it is more or less shiny. Returns the film's surface
 * as a normal map and its roughness (green channel, multiplied by the coat roughness,
 * which is 1 while gloss is on). Generated once, tileable, from a fixed seed.
 */
function makeFilmTexture() {
  const N = 256;
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Tileable value noise with `g` cells across.
  const noise = (g: number) => {
    const cells = Float32Array.from({ length: g * g }, rnd);
    const out = new Float32Array(N * N);
    const ease = (t: number) => t * t * (3 - 2 * t);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const fx = (x / N) * g, fy = (y / N) * g;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = ease(fx - x0), ty = ease(fy - y0);
        const at = (i: number, j: number) => cells[((j % g) * g) + (i % g)];
        const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
        const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        out[y * N + x] = a + (b - a) * ty;
      }
    return out;
  };
  const crinkle = [noise(5), noise(10), noise(20)];
  const patches = noise(4);
  // Nicks: tiny round dents, a pixel or two across, scattered over the film.
  const nick = new Float32Array(N * N);
  for (let i = 0; i < 30; i++) {
    const cx = rnd() * N, cy = rnd() * N, r = 0.8 + rnd() * 1.4;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const d = Math.hypot(dx + (cx % 1) - 0.5, dy + (cy % 1) - 0.5);
        if (d >= r) continue;
        const k = ((Math.floor(cy) + dy + N) % N) * N + ((Math.floor(cx) + dx + N) % N);
        nick[k] = Math.max(nick[k], 1 - d / r);
      }
  }
  const height = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) height[i] = 0.6 * crinkle[0][i] + 0.3 * crinkle[1][i] + 0.1 * crinkle[2][i] - 0.06 * nick[i];
  const toTexture = (fill: (i: number, x: number, y: number, px: Uint8ClampedArray) => void) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = N;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) fill(y * N + x, x, y, img.data);
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  };
  const h = (x: number, y: number) => height[((y + N) % N) * N + ((x + N) % N)];
  const normal = toTexture((i, x, y, px) => {
    const dx = (h(x + 1, y) - h(x - 1, y)) * 6;
    const dy = (h(x, y + 1) - h(x, y - 1)) * 6;
    const len = Math.hypot(dx, dy, 1);
    px[i * 4] = Math.round((-dx / len * 0.5 + 0.5) * 255);
    px[i * 4 + 1] = Math.round((dy / len * 0.5 + 0.5) * 255);
    px[i * 4 + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
    px[i * 4 + 3] = 255;
  });
  const rough = toTexture((i, _x, _y, px) => {
    const r = Math.min(1, 0.08 + 0.22 * patches[i] + 0.3 * nick[i]);
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = Math.round(r * 255);
    px[i * 4 + 3] = 255;
  });
  return { normal, rough };
}

/** Turn the sticker film on or off (the Gloss switch). */
function applyGloss() {
  if (glossOn && !filmTex) filmTex = makeFilmTexture();
  // The color layer underneath keeps its smooth, satin finish; only the clear coat
  // carries the film's crinkles, so they show in reflections and not in the color.
  for (const m of stickerMats) {
    m.clearcoat = glossOn ? LIGHT.filmCoat : 0;
    m.clearcoatRoughness = 1;
    m.clearcoatRoughnessMap = glossOn ? filmTex!.rough : null;
    m.clearcoatNormalMap = glossOn ? filmTex!.normal : null;
    m.clearcoatNormalScale = new THREE.Vector2(LIGHT.filmNormal, LIGHT.filmNormal);
    m.needsUpdate = true;
  }
}

/**
 * Give one sticker its own patch of the film: a random quarter-turn and offset of the
 * texture, so neighboring stickers don't show the same crinkles.
 */
function varyFilm(geo: any, key: number) {
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  // A fixed pseudo-random choice per sticker, so every load looks the same.
  const hash = (n: number) => {
    let t = Math.imul(key * 0x9e3779b1 + n * 0x85ebca6b, 0xc2b2ae35);
    t ^= t >>> 15;
    return (Math.imul(t, 0x27d4eb2f) >>> 0) / 4294967296;
  };
  const turn = Math.floor(hash(1) * 4);
  const ox = hash(2), oy = hash(3);
  for (let i = 0; i < uv.count; i++) {
    let u = pos.getX(i) / 0.82 * 0.45, v = pos.getY(i) / 0.82 * 0.45;
    for (let k = 0; k < turn; k++) [u, v] = [-v, u];
    uv.setXY(i, u + ox, v + oy);
  }
  uv.needsUpdate = true;
  return geo;
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
  // Newer three.js (r165+) has only physically based light units: the same look needs
  // the old values times pi.
  const L = "useLegacyLights" in renderer ? 1 : Math.PI;
  // Tone mapping: compress bright values smoothly instead of clipping them, so a well-lit
  // yellow stays yellow (not lemon) and white keeps its shading. "Neutral" (Khronos PBR
  // Neutral) is designed to keep material colors faithful.
  if (THREE.NeutralToneMapping !== undefined) {
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = LIGHT.exposure;
  }
  // Lighting: a soft studio room environment (prefiltered for rough reflections) gives
  // most of the light and the reflections in the glossy plastic; one key light gives
  // the corner glints and the (soft) shadows.
  if (THREE.RoomEnvironment) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    envTex = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    scene.environmentIntensity = LIGHT.env;
    pmrem.dispose();
  }
  const key = new THREE.DirectionalLight(0xffffff, LIGHT.key * L);
  key.position.set(4, 9, 7);
  // Shadows: the key light's shadow map covers the whole lattice. The lights stay fixed
  // while the puzzle turns, so shadows move correctly as you tumble the view.
  renderer.shadowMap.enabled = true;
  // PCF with a sample radius gives soft shadow edges (the "soft" PCF variant ignores radius).
  renderer.shadowMap.type = THREE.PCFShadowMap;
  key.castShadow = shadowsOn;
  key.shadow.mapSize.set(1024, 1024);
  const sc = key.shadow.camera;
  sc.left = -4.6;
  sc.right = 4.6;
  sc.top = 4.6;
  sc.bottom = -4.6;
  sc.near = 4;
  sc.far = 22;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.025;
  key.shadow.radius = LIGHT.shadowSoft;
  key.shadow.blurSamples = 16;
  scene.add(key);
  keyLight = key;
  pivot = new THREE.Group();
  const h = VIEWS.home;
  pivot.quaternion.set(h[0], h[1], h[2], h[3]);
  scene.add(pivot);
  camera.position.set(0, 0, 13.5);
  camera.lookAt(0, 0, 0);

  // Cubelets nearly touch, as on the real puzzle: a hairline gap between them.
  // Rounded like a real cube's plastic. Dark gray, not black, so that inside faces
  // facing different ways can be told apart by their shading.
  const body = roundedBox(0.985, BODY_RADIUS, 4);
  // Glossy plastic: small, tight highlights that slide along the rounded edges and
  // corners as the cube tumbles (the lights stay put while the puzzle turns).
  // Glossy molded plastic. Physically based plastic reflects only ~4% at its surface,
  // which makes the corner glints too faint to see; boosting the specular reflectance
  // (and a smooth clear coat) brings back small bright glints on the rounded corners.
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: 0x575c61,
    roughness: LIGHT.plasticRough,
    metalness: 0,
    specularIntensity: 1,
    specularColor: new THREE.Color(LIGHT.plasticSpec, LIGHT.plasticSpec, LIGHT.plasticSpec),
    clearcoat: LIGHT.coat,
    clearcoatRoughness: LIGHT.coatRough,
    vertexColors: true,
  });
  // Give the plastic its own (dimmer) copy of the room: with the boosted reflectance, the
  // room's bright panels otherwise mirror off whole faces. The key-light glints are unaffected.
  if (envTex) {
    bodyMat.envMap = envTex;
    bodyMat.envMapIntensity = LIGHT.plasticEnv;
  }
  // Stickers sit on the flat part of each face, with rounded corners.
  const plane = roundedSquare(0.82, 0.07);
  const mats = new Map<Color, any>();
  const dark = getComputedStyle(document.documentElement).getPropertyValue("--unstickered").trim() || "#2b2f2e";
  // Subdivided so the flat view's narrow shading ramp has vertices to fall across.
  const netPlane = new THREE.PlaneGeometry(0.92, 0.92, 16, 16);
  // Columns of vertices at the ends and where an open end is cut back to (GLOW_CUT).
  const glowPlane = new THREE.PlaneGeometry(1.0, GLOW_WIDTH, 3, 1);
  const gp = glowPlane.attributes.position;
  for (let i = 0; i < gp.count; i++) {
    const col = Math.round((gp.getX(i) + 0.5) * 3);
    gp.setX(i, [-0.5, -GLOW_CUT, GLOW_CUT, 0.5][col]);
    glowPlane.attributes.uv.setX(i, gp.getX(i) + 0.5);
  }
  const glowCorner = makeGlowCorner();
  const glowTex = makeGlowTexture();
  const glowMats = new Map<string, any>();
  const glowMatFor = (c: Color, open: number) => {
    const key = `${c}/${open}`;
    if (!glowMats.has(key)) glowMats.set(key, makeGlowMaterial(glowTex, new THREE.Color(STICKER[c]), open));
    return glowMats.get(key);
  };
  // Flat-view backing: a dark body just inside each cubelet's cell, so the gaps between
  // tiles read as black plastic, as on the puzzle, rather than as the light background.
  const netBody = new THREE.BoxGeometry(0.98, 0.98, 0.98);
  const netOccluderMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x141617) });
  const netMats = new Map<Color, any>();
  const netMatFor = (c: Color) => {
    if (!netMats.has(c)) netMats.set(c, new THREE.MeshBasicMaterial({ color: STICKER[c], vertexColors: true }));
    return netMats.get(c);
  };
  const netDarkMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(dark), vertexColors: true });
  probeUnstickered = netDarkMat.color.getHex();
  const matFor = (c: Color) => {
    if (!mats.has(c)) {
      const m = new THREE.MeshPhysicalMaterial({ color: STICKER[c], vertexColors: true, roughness: LIGHT.stickerRough, metalness: 0, specularIntensity: LIGHT.stickerSpec });
      mats.set(c, m);
      stickerMats.push(m);
    }
    return mats.get(c);
  };
  paintMaterial = { sticker: matFor, tile: netMatFor, glow: (c: Color) => [0, 1, 2, 3].map((open) => glowMatFor(c, open)) };
  // Gray versions of each color for the step guide: level 1 for cubelets a step leaves
  // alone, level 2 (darker) for those it may leave anywhere. Each keeps some of its
  // color's lightness, in a band that doesn't overlap the other level's.
  const grayMats = new Map<string, { sticker: any; tile: any; glow: any[] }>();
  grayMaterial = (c: Color, level: 1 | 2) => {
    const key = `${c}/${level}`;
    if (!grayMats.has(key)) {
      const { r, g, b } = new THREE.Color(STICKER[c]);
      const light = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const v = level === 1 ? 0.6 + 0.35 * light : 0.27 + 0.2 * light;
      const gray = new THREE.Color(v, v, v);
      const sticker = matFor(c).clone();
      sticker.color = gray;
      stickerMats.push(sticker);
      applyGloss();
      grayMats.set(key, { sticker, tile: new THREE.MeshBasicMaterial({ color: gray, vertexColors: true }), glow: [0, 1, 2, 3].map((open) => makeGlowMaterial(glowTex, gray, open)) });
    }
    return grayMats.get(key)!;
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
  for (let d = 0; d < 6; d++) {
    const e = new THREE.Euler(faceXform[d][3], faceXform[d][4], 0);
    const r = (v: any): Vec3 => [Math.round(v.x), Math.round(v.y), Math.round(v.z)];
    FACE_AXES[d] = { ux: r(new THREE.Vector3(1, 0, 0).applyEuler(e)), uy: r(new THREE.Vector3(0, 1, 0).applyEuler(e)) };
  }
  for (const c of CUBELETS) {
    const g = new THREE.Group();
    const bodyMesh = new THREE.Mesh(withAoColors(body), bodyMat);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    g.add(bodyMesh);
    registerBody(c.id, bodyMesh, 0.985);
    probeInfo.set(bodyMesh, { id: c.id, d: 6 });
    const aoList: AoFace[] = [];
    aoFaces[c.id] = aoList;
    c.stickers.forEach((col, d) => {
      if (!col) return;
      const m = new THREE.Mesh(varyFilm(withAoColors(plane), c.id * 6 + d), matFor(col));
      m.receiveShadow = true;
      probeInfo.set(m, { id: c.id, d });
      stickerMesh3d[c.id * 6 + d] = m;
      const [px, py, pz, rx, ry] = faceXform[d];
      m.position.set(px, py, pz);
      m.rotation.set(rx, ry, 0);
      g.add(m);
      aoList.push(aoFace(m, d, "3d"));
    });
    // Flat-view faces: unlit, one per face, seen only by the flat view's cameras (layer 2),
    // in front of the cubelet's dark backing, which also hides deeper cubelets.
    const occluder = new THREE.Mesh(netBody, netOccluderMat);
    probeInfo.set(occluder, { id: c.id, d: 6 });
    occluder.layers.set(NET_LAYER);
    occluder.renderOrder = -1;
    g.add(occluder);
    for (let d = 0; d < 6; d++) {
      const col = c.stickers[d];
      const m = new THREE.Mesh(withAoColors(netPlane), col ? netMatFor(col) : netDarkMat);
      probeInfo.set(m, { id: c.id, d });
      if (col) tileMesh[c.id * 6 + d] = m;
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
    // Each end of the band reaches the cubelet face beside it (lo at -X, hi at +X); where
    // that face is exposed too, the band in its plane carries the same glow around the
    // corner, joined to this one by a rounded corner piece (made here for the hi end).
    const list: GlowBand[] = [];
    for (let a = 0; a < 6; a++)
      for (let b = 0; b < 6; b++) {
        if (a >> 1 === b >> 1) continue;
        // No glow for unstickered side faces: no glow at an edge means the face is black.
        const col = c.stickers[b];
        if (!col) continue;
        const A = new THREE.Vector3(...DIRS[a]);
        const B = new THREE.Vector3(...DIRS[b]);
        const X = new THREE.Vector3().crossVectors(B, A);
        const mats = [0, 1, 2, 3].map((open) => glowMatFor(col, open));
        const m = new THREE.Mesh(glowPlane, mats[0]);
        m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, B, A));
        m.position.copy(A.clone().multiplyScalar(GLOW_DEPTH)).add(B.clone().multiplyScalar(GLOW_START + GLOW_WIDTH / 2));
        m.layers.set(GLOW3D_LAYER);
        m.layers.enable(GLOWNET_LAYER);
        m.renderOrder = 2;
        m.visible = false;
        g.add(m);
        const lo = dirIndex([-X.x, -X.y, -X.z]), hi = dirIndex([X.x, X.y, X.z]);
        // The corner piece's frame: x along A, y along B, so the band at the hi end lies at -z.
        const corner = new THREE.Mesh(glowCorner, mats[0]);
        corner.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(A, B, new THREE.Vector3().crossVectors(A, B)));
        corner.layers.set(GLOW3D_LAYER);
        corner.renderOrder = 2;
        corner.visible = false;
        g.add(corner);
        list.push({ mesh: m, a, b, lo, hi, mats, corner });
      }
    glows[c.id] = list;
    aoList.sort((a, b) => a.d - b.d);
    pivot.add(g);
    meshes[c.id] = g;
  }
  applyGlowSettings();
  applyGloss();
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
    const exposed = [0, 1, 2, 3, 4, 5].map((d) => isExposed(st, s, ROT_DIR[o * 6 + d]));
    for (const gl of glows[id] ?? []) {
      gl.mesh.visible = exposed[gl.a] && exposed[gl.b];
      gl.mesh.material = (gl.paint ?? gl.mats)[(exposed[gl.lo] ? 1 : 0) | (exposed[gl.hi] ? 2 : 0)];
      if (gl.corner.material !== (gl.paint ?? gl.mats)[0]) gl.corner.material = (gl.paint ?? gl.mats)[0];
      gl.corner.visible = gl.mesh.visible && exposed[gl.hi];
    }
    shadeCubelet(st, s, o, id);
  }
}

/** Grid shading for all six faces of the cubelet in `slot`, applied to its sticker, tile and plastic. */
function shadeCubelet(st: State, slot: number, ori: number, id: number) {
  const per: (number[] | null)[] = [], perFlat: (number[] | null)[] = [];
  for (let d = 0; d < 6; d++) {
    per.push(aoOn["3d"] ? gridCorners(st, slot, ori, d) : null);
    perFlat.push(aoOn.flat ? gridNeighbors(st, slot, ori, d) : null);
  }
  applyToCubelet(id, per, perFlat);
}

// Second ring: grid spots two cells out along the face, with less weight, so big
// notches get deeper shading than small steps. (in-plane offsets along ux, uy; weight)
const FAR_RING: [number, number, number][] = [
  [2, 0, 1],
  [0, 2, 1],
  [2, 1, 0.75],
  [1, 2, 0.75],
  [2, 2, 0.5],
];
const FAR_RING_TOTAL = FAR_RING.reduce((t, r) => t + r[2], 0);
const FAR_WEIGHT = 0.22; // how much a fully filled second ring darkens a corner

/**
 * Brightness of one face corner. `fill(x, y, z)` says how filled a spot is (0..1);
 * f = the spot just in front of the face; ux, uy = the face's in-plane axes;
 * sx, sy = which corner. Used both at rest (filled = 0 or 1) and mid-turn (continuous).
 */
function cornerValue(fill: (x: number, y: number, z: number) => number, f: readonly number[], ux: readonly number[], uy: readonly number[], sx: number, sy: number) {
  const at = (i: number, j: number) => fill(f[0] + i * sx * ux[0] + j * sy * uy[0], f[1] + i * sx * ux[1] + j * sy * uy[1], f[2] + i * sx * ux[2] + j * sy * uy[2]);
  const s1 = at(1, 0), s2 = at(0, 1), s3 = at(1, 1);
  const near = levelBrightness((1 - s1 * s2) * (3 - (s1 + s2 + s3)));
  let far = 0;
  for (const [i, j, w] of FAR_RING) far += w * at(i, j);
  return near * (1 - (FAR_WEIGHT * far) / FAR_RING_TOTAL);
}

/** Smoothstep easing of the blend across a face, so shading meets cleanly at face edges. */
const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * Flat-view darkness cast on a face by the grid spots around the spot in front of it:
 * [the four diagonal spots in CORNER_SIGNS order, then the edge spots at -x, +x, -y, +y].
 * A filled edge spot is a neighbor standing nearer than the face along that edge; a
 * filled diagonal spot, one touching only that corner. Same arguments as cornerValue.
 */
function flatNeighbors(fill: (x: number, y: number, z: number) => number, f: readonly number[], ux: readonly number[], uy: readonly number[]): number[] {
  const at = (i: number, j: number) => fill(f[0] + i * ux[0] + j * uy[0], f[1] + i * ux[1] + j * uy[1], f[2] + i * ux[2] + j * uy[2]);
  return [
    ...CORNER_SIGNS.map(([sx, sy]) => FLAT_DIAG_DARK * at(sx, sy)),
    FLAT_EDGE_DARK * at(-1, 0),
    FLAT_EDGE_DARK * at(1, 0),
    FLAT_EDGE_DARK * at(0, -1),
    FLAT_EDGE_DARK * at(0, 1),
  ];
}

/** The front spot and in-plane axes of face d of the cubelet in `slot`, at rest. */
function restFrame(slot: number, ori: number, d: number) {
  const R = ROTATIONS[ori];
  const p = SLOT_POS[slot];
  const n = matVec(R, DIRS[d]);
  return { front: [p[0] + n[0], p[1] + n[1], p[2] + n[2]], ux: matVec(R, FACE_AXES[d].ux), uy: matVec(R, FACE_AXES[d].uy) };
}

/** Four corner values for face d of the cubelet in `slot` (grid rule), 3D view. */
function gridCorners(st: State, slot: number, ori: number, d: number): number[] {
  const { front, ux, uy } = restFrame(slot, ori, d);
  const fill = (x: number, y: number, z: number) => (filledAt(st, [x, y, z]) ? 1 : 0);
  return CORNER_SIGNS.map(([sx, sy]) => cornerValue(fill, front, ux, uy, sx, sy));
}

/** Flat-view neighbor darkness for face d of the cubelet in `slot` (see flatNeighbors). */
function gridNeighbors(st: State, slot: number, ori: number, d: number): number[] {
  const { front, ux, uy } = restFrame(slot, ori, d);
  return flatNeighbors((x, y, z) => (filledAt(st, [x, y, z]) ? 1 : 0), front, ux, uy);
}

/**
 * Apply per-face shading (index = face direction in the cubelet's frame; null = leave as
 * is) to the cubelet's sticker faces and plastic body (`per`, corner values) and its flat
 * tiles (`perFlat`, neighbor darkness).
 */
function applyToCubelet(id: number, per: (number[] | null)[], perFlat: (number[] | null)[]) {
  for (const f of aoFaces[id] ?? []) {
    const flat = f.view === "flat";
    const c = (flat ? perFlat : per)[f.d];
    if (!aoOn[f.view]) {
      const none = flat ? FLAT_NONE : CORNERS_NONE;
      if (!f.cur || f.cur.some((v, i) => v !== none[i])) applyShading(f, none);
    } else if (c) applyShading(f, c);
  }
  const b = bodyAo[id];
  if (!b) return;
  const col = b.mesh.geometry.attributes.color;
  const arr = col.array as Float32Array;
  if (!aoOn["3d"]) {
    if (b.shaded) {
      arr.fill(1);
      col.needsUpdate = true;
      b.shaded = false;
    }
    return;
  }
  for (let i = 0; i < b.face.length; i++) {
    const c = per[b.face[i]];
    if (!c) continue;
    const u = ease(b.u[i]), w = ease(b.v[i]);
    const top = c[0] * (1 - u) + c[1] * u;
    const bottom = c[2] * (1 - u) + c[3] * u;
    arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = bottom * (1 - w) + top * w;
  }
  col.needsUpdate = true;
  b.shaded = true;
}

/** The plane axes of each face direction (cubelet frame), shared by stickers, tiles and plastic. */
const FACE_AXES: { ux: Vec3; uy: Vec3 }[] = [];
/** Per-cubelet plastic body: which face each vertex belongs to, and its position across that face. */
const bodyAo: { mesh: any; face: Uint8Array; u: Float32Array; v: Float32Array; shaded: boolean }[] = [];

function registerBody(id: number, mesh: any, size: number) {
  const pos = mesh.geometry.attributes.position;
  const nor = mesh.geometry.attributes.normal;
  const n = pos.count;
  const face = new Uint8Array(n), u = new Float32Array(n), v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const d = ax >= ay && ax >= az ? (nx > 0 ? 0 : 1) : ay >= az ? (ny > 0 ? 2 : 3) : nz > 0 ? 4 : 5;
    face[i] = d;
    const p = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    const { ux, uy } = FACE_AXES[d];
    u[i] = Math.max(0, Math.min(1, (p[0] * ux[0] + p[1] * ux[1] + p[2] * ux[2]) / size + 0.5));
    v[i] = Math.max(0, Math.min(1, (p[0] * uy[0] + p[1] * uy[1] + p[2] * uy[2]) / size + 0.5));
  }
  bodyAo[id] = { mesh, face, u, v, shaded: false };
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
// The flat view shades a tile from its neighbors in the view: each neighbor standing
// nearer casts a band along the shared edge (or, touching only a corner, a patch in that
// corner) that is darkest at the edge and gone within FLAT_AO_RAMP of the tile. Where
// bands overlap the darker one wins, so a recess between two walls shows two bands with
// a clean middle, and two walls meeting at a corner make one even L.
const FLAT_AO_RAMP = 0.3;
const FLAT_EDGE_DARK = 0.45;
const FLAT_DIAG_DARK = 0.25;
const CORNERS_NONE = [1, 1, 1, 1];
const FLAT_NONE = [0, 0, 0, 0, 0, 0, 0, 0];
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

/** How much of a band's darkness remains at distance t (0..1, fraction of the tile) from its edge. */
const flatFalloff = (t: number) => (t >= FLAT_AO_RAMP ? 0 : 1 - ease(t / FLAT_AO_RAMP));

/** Flat-view brightness at (x, y) (0..1 across the tile) from neighbor darkness `n` (see flatNeighbors). */
function flatBrightness(n: readonly number[], x: number, y: number) {
  const l = flatFalloff(x), r = flatFalloff(1 - x), b = flatFalloff(y), t = flatFalloff(1 - y);
  return 1 - Math.max(n[0] * l * t, n[1] * r * t, n[2] * l * b, n[3] * r * b, n[4] * l, n[5] * r, n[6] * b, n[7] * t);
}

/**
 * Write shading onto a face (any vertex layout): for a 3D face, four corner brightness
 * values blended across it; for a flat tile, neighbor darkness (see flatNeighbors).
 */
function applyShading(f: AoFace, vals: number[]) {
  f.cur = vals.slice();
  const flat = f.view === "flat";
  const col = f.mesh.geometry.attributes.color;
  const arr = col.array as Float32Array;
  const pos = f.mesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = Math.max(0, Math.min(1, pos.getX(i) / f.extent + 0.5)); // 0 at -x, 1 at +x
    const y = Math.max(0, Math.min(1, pos.getY(i) / f.extent + 0.5)); // 0 at -y, 1 at +y
    let v: number;
    if (flat) {
      v = flatBrightness(vals, x, y);
    } else {
      const u = ease(x), w = ease(y);
      const top = vals[0] * (1 - u) + vals[1] * u;
      const bottom = vals[2] * (1 - u) + vals[3] * u;
      v = bottom * (1 - w) + top * w;
    }
    arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = v;
  }
  col.needsUpdate = true;
}

// ------------------------------------------------------------------ shading while a layer turns
//
// Real occlusion, recomputed every frame: the same three-spots-per-corner rule, but each
// spot's "filled" amount is continuous: it depends on how far the spot is from the
// nearest cubelet's center, measured in that cubelet's own (possibly tilted) frame.
// At rest every cubelet sits on the grid and this matches the grid shading exactly.

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
  // Neighboring faces check many of the same spots: remember each spot's value this frame.
  const memo = new Map<number, number>();
  const filled = (qx: number, qy: number, qz: number) => {
    const key = ((Math.round(qx * 64) + 512) * 1024 + (Math.round(qy * 64) + 512)) * 1024 + (Math.round(qz * 64) + 512);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const v = filledUncached(qx, qy, qz);
    memo.set(key, v);
    return v;
  };
  const filledUncached = (qx: number, qy: number, qz: number) => {
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
    const per: (number[] | null)[] = [], perFlat: (number[] | null)[] = [];
    for (let fd = 0; fd < 6; fd++) {
      const n = tf(DIRS[fd]), ux = tf(FACE_AXES[fd].ux), uy = tf(FACE_AXES[fd].uy);
      const fx = center[0] + n[0], fy = center[1] + n[1], fz = center[2] + n[2];
      // A face covered by a cubelet that isn't moving can't be seen: leave it.
      if (!moving && staticAt(fx, fy, fz)) {
        per.push(null);
        perFlat.push(null);
        continue;
      }
      const f = [fx, fy, fz];
      per.push(aoOn["3d"] ? CORNER_SIGNS.map(([sx, sy]) => cornerValue(filled, f, ux, uy, sx, sy)) : null);
      perFlat.push(aoOn.flat ? flatNeighbors(filled, f, ux, uy) : null);
    }
    applyToCubelet(id, per, perFlat);
  }
}

/** Largest change live shading makes to a puzzle at rest, over every turnable layer (should be ~0). */
function shadeRestError() {
  let worst = 0;
  for (let def = 0; def < MOVE_DEFS.length; def++) {
    if (MOVE_DEFS[def].kind === "rotation") continue;
    const before = new Map<AoFace, number[]>();
    for (const list of aoFaces) for (const f of list ?? []) if (f.cur) before.set(f, f.cur.slice());
    shadeDuringTurn({ def, angle: 0, before: app.current });
    for (const [f, v] of before) for (let i = 0; i < v.length; i++) worst = Math.max(worst, Math.abs(v[i] - f.cur![i]));
    syncMeshes(app.current);
  }
  return worst;
}

function applyShadingSettings() {
  if (edit) drawEdit(); // the edited position, with its paint
  else syncMeshes(app.current);
  try {
    localStorage.setItem(AO_KEY, JSON.stringify(aoOn));
  } catch {
    /* storage unavailable */
  }
}

// ------------------------------------------------------------------ edge glow

const GLOW3D_LAYER = 3;
const GLOWNET_LAYER = 4;
const HALO_LAYER = 5; // the color editor's highlight in the 3D view
const FLAT_HALO_LAYER = 6; // ... and in the flat view: 6 + direction, one layer per face
const BODY_RADIUS = 0.07; // rounding of cubelet edges
// The glow band lies just below the face's surface (GLOW_DEPTH) and starts under the
// cubelet (GLOW_START), so the cubelet hides its inner part and the glow appears to
// come from right under the cubelet's edge from any viewing angle, with no gap.
const GLOW_DEPTH = 0.47;
const GLOW_START = 0.36;
const GLOW_WIDTH = 0.56;
const GLOW_SOLID = (0.495 - GLOW_START) / GLOW_WIDTH; // fraction kept at full strength (to just past the edge)
// Where two bands of one hidden sticker meet at a corner, a quarter cylinder of this
// radius joins them, so the glow is rounded there like the sticker's own corner. Each
// band reaches the cubelet's side (0.5); at an open end it is cut back to where the
// cylinder takes over (GLOW_CUT from its middle).
const GLOW_ROUND = 0.25;
const GLOW_CUT = GLOW_DEPTH - GLOW_ROUND;
const GLOW_TAPER = 0.22; // fraction of the band's length over which a closed end fades out
/** One glow band: faces a (its plane) and b (its color), the faces beside its two ends, and its material for each combination of open ends. */
type GlowBand = { mesh: any; a: number; b: number; lo: number; hi: number; mats: any[]; corner: any; paint?: any[] };
const glows: GlowBand[][] = [];
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
 *
 * The band fades out along its length at each end, except at an open end (bit 0: the
 * -X end, bit 1: +X), where the band in the neighboring face's plane, showing the same
 * sticker, continues it around the corner. The two meet along the line where their
 * planes cross, and fade outward at the same rate, so the glow is unbroken. The flat
 * view sees that neighboring band exactly edge-on, so there it would not draw and every
 * end fades.
 */
function makeGlowMaterial(map: any, color: any, open: number) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, color: { value: color }, open: { value: new THREE.Vector2(open & 1, open >> 1) } },
    transparent: true,
    depthWrite: false,
    vertexShader: `
      uniform vec2 open;
      varying vec2 vUv;
      varying float vFade;
      varying float vOrtho;
      void main() {
        vOrtho = projectionMatrix[3][3] == 1.0 ? 1.0 : 0.0;
        // An open end is cut back to where the corner piece starts, by moving the end
        // column of vertices onto the column there, so the two meet on shared edges.
        vec3 p = position;
        vUv = uv;
        if (vOrtho < 0.5 && open.x > 0.5 && p.x < ${-GLOW_CUT} - 1e-4) { p.x = ${-GLOW_CUT}; vUv.x = p.x + 0.5; }
        if (vOrtho < 0.5 && open.y > 0.5 && p.x > ${GLOW_CUT} + 1e-4) { p.x = ${GLOW_CUT}; vUv.x = p.x + 0.5; }
        vec4 world = modelMatrix * vec4(p, 1.0);
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
      uniform vec2 open;
      varying vec2 vUv;
      varying float vFade;
      varying float vOrtho;
      void main() {
        vec2 o = vOrtho > 0.5 ? vec2(0.0) : open;
        float lo = o.x > 0.5 ? 1.0 : smoothstep(0.0, ${GLOW_TAPER}, vUv.x);
        float hi = o.y > 0.5 ? 1.0 : smoothstep(0.0, ${GLOW_TAPER}, 1.0 - vUv.x);
        float a = texture2D(map, vUv).a * vFade * min(lo, hi);
        if (a < 0.003) discard;
        gl_FragColor = vec4(color, a);
      }`,
  });
}

/**
 * The rounded corner piece between two glow bands, in a frame with x along one band's
 * face, y along the glowing face and -z along the other band's face: a quarter cylinder
 * about the y axis, tangent to both bands. Its uv.y runs along y like the bands' (so it
 * fades outward at the same rate). It uses the material of a band with no open end
 * (which moves no vertices), and its uv.x is mid-band, so no end fade applies.
 * The 3D view only: the flat view sees a corner from one side.
 */
function makeGlowCorner() {
  const SEG = 12;
  const c = GLOW_CUT;
  const pos: number[] = [], uv: number[] = [], index: number[] = [];
  for (let i = 0; i <= SEG; i++) {
    const t = (i / SEG) * (Math.PI / 2);
    for (const v of [0, 1]) {
      pos.push(c + GLOW_ROUND * Math.cos(t), GLOW_START + v * GLOW_WIDTH, -(c + GLOW_ROUND * Math.sin(t)));
      uv.push(0.5, v);
    }
    if (i < SEG) index.push(2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  return geo;
}

/** White band, opaque at the edge (bottom) fading upward. The ends taper in the shader. */
function makeGlowTexture() {
  const W = 4, H = 32;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = 1 - y / (H - 1); // 0 at the edge (bottom of the image)
      const a = v <= GLOW_SOLID ? 1 : Math.pow(1 - (v - GLOW_SOLID) / (1 - GLOW_SOLID), 1.8);
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 235);
    }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

function applyGlowSettings() {
  camera.layers.set(0);
  camera.layers.enable(HALO_LAYER);
  if (glowOn["3d"]) camera.layers.enable(GLOW3D_LAYER);
  for (const nc of netCams) {
    nc.cam.layers.set(NET_LAYER);
    nc.cam.layers.enable(FLAT_HALO_LAYER + dirIndex(nc.view));
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
/**
 * Edge labels that move with the cube: each face's label sits where that face's axis
 * (its outward normal from the center), as seen on screen, meets the edge of the 3D
 * view. Axes pointing toward you get a solid label, axes pointing away a dimmer one;
 * an axis pointing almost straight at you (or away) projects to almost nothing, so its
 * label fades out.
 */
function updateCompass() {
  const canvas = renderer.domElement as HTMLCanvasElement;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  // Contents (letter + center color) change only when the position changes.
  const key = app.cursor + "|" + app.baseLabel + "|" + app.history.length;
  const refreshText = key !== compassKey;
  compassKey = key;
  const toScreenXY = (v: any) => {
    const p = v.clone().project(camera);
    return [((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h];
  };
  const [ox, oy] = toScreenXY(new THREE.Vector3(0, 0, 0));
  // Work out each label's spot on the edge, then place the most visible first and slide
  // any label that would cover an already placed one along its edge.
  const items: { el: HTMLElement; x: number; y: number; vis: number; away: boolean; vertical: boolean; hw: number; hh: number }[] = [];
  for (let d = 0; d < 6; d++) {
    const el = document.getElementById(`compass-${d}`);
    if (!el) continue;
    if (refreshText) {
      const c = faceCenterColor(app.current, d);
      el.innerHTML = `<i style="background:${c ? NET_COLOR[c] : "transparent"}"></i>${COMPASS_FACES[d]}`;
      el.setAttribute("aria-label", `Look at the ${COMPASS_FACES[d]} face`);
    }
    const dir = new THREE.Vector3(DIRS[d][0], DIRS[d][1], DIRS[d][2]).applyQuaternion(pivot.quaternion); // world
    const [tx, ty] = toScreenXY(dir.clone().multiplyScalar(3));
    let dx = tx - ox, dy = ty - oy;
    const len = Math.hypot(dx, dy);
    const inPlane = Math.sqrt(Math.max(0, 1 - dir.z * dir.z)); // 1 when the axis lies in the screen plane
    const vis = len < 1e-3 ? 0 : Math.min(1, Math.max(0, (inPlane - 0.18) / 0.3));
    if (len >= 1e-3) {
      dx /= len;
      dy /= len;
    }
    const hw = el.offsetWidth / 2 + 6, hh = el.offsetHeight / 2 + 6;
    const t = Math.min(dx ? (w / 2 - hw) / Math.abs(dx) : Infinity, dy ? (h / 2 - hh) / Math.abs(dy) : Infinity);
    const x = w / 2 + dx * (isFinite(t) ? t : 0), y = h / 2 + dy * (isFinite(t) ? t : 0);
    const vertical = Math.abs(Math.abs(x - w / 2) - (w / 2 - hw)) < 1; // on the left or right edge
    items.push({ el, x, y, vis, away: dir.z < 0, vertical, hw: hw - 4, hh: hh - 4 });
  }
  items.sort((a, b) => b.vis - a.vis);
  const placed: typeof items = [];
  for (const it of items) {
    if (it.vis > 0.05) {
      for (let tries = 0; tries < 8; tries++) {
        const hit = placed.find((o) => Math.abs(o.x - it.x) < o.hw + it.hw && Math.abs(o.y - it.y) < o.hh + it.hh);
        if (!hit) break;
        // Slide along this label's edge, toward the middle of the edge (away from corners).
        if (it.vertical) it.y = hit.y + (it.y < h / 2 ? 1 : -1) * (hit.hh + it.hh + 2);
        else it.x = hit.x + (it.x < w / 2 ? 1 : -1) * (hit.hw + it.hw + 2);
        it.x = Math.min(w - it.hw, Math.max(it.hw, it.x));
        it.y = Math.min(h - it.hh, Math.max(it.hh, it.y));
      }
      placed.push(it);
    }
    it.el.style.transform = `translate(${it.x}px, ${it.y}px) translate(-50%, -50%)`;
    it.el.style.opacity = String(it.vis * (it.away ? 0.6 : 1));
    it.el.style.pointerEvents = it.vis > 0.3 ? "auto" : "none";
    it.el.classList.toggle("away", it.away);
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

let view3dSection: HTMLElement | null = null;
function frame() {
  view3dSection ??= document.querySelector<HTMLElement>("[data-sec=view3d]");
  if (tween) {
    const t = tween.ms ? Math.min(1, (performance.now() - tween.start) / tween.ms) : 1;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    pivot.quaternion.copy(tween.from).slerp(tween.to, e);
    if (t >= 1) tween = null;
  }
  tickAnimation();
  tickSettle();
  const view3dOpen = !view3dSection?.classList.contains("collapsed");
  if (view3dOpen) updateCompass();
  renderNetAnimation();
  if (view3dOpen) renderer.render(scene, camera);
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
  shadeDuringTurn({ def: l.def, angle: l.theta, before: app.current });
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
  shadeDuringTurn({ def: l.def, angle: from + (to - from) * e, before: app.current });
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

// ------------------------------------------------------------------ shuffle

const SHUFFLE_TURNS = 30;
const SHUFFLE_MS = 70; // per quarter turn, regardless of the speed slider
let shuffling = false;
let shuffleAlg = "";

/**
 * Mix up the cube: random legal turns (inner turns, slices, and outer turns when that
 * extension is complete), never the same layer twice in a row and no whole-puzzle
 * rotations. Plays quickly, then the result becomes the new start.
 */
function shuffle() {
  flushAnimations();
  const names = ["R", "L", "U", "D", "F", "B", "r", "l", "u", "d", "f", "b", "M", "H", "S"];
  const st = app.current.clone();
  const turns: Turn[] = [];
  let prevDef = -1;
  let guard = 0;
  while (turns.length < SHUFFLE_TURNS && guard++ < 10000) {
    const def = MOVE_BY_NAME.get(names[Math.floor(Math.random() * names.length)])!;
    if (def === prevDef) continue;
    const t: Turn = { def, amount: (1 + Math.floor(Math.random() * 3)) as 1 | 2 | 3 };
    if (blockedReason(st, t)) continue;
    applyTurn(st, t);
    turns.push(t);
    prevDef = def;
  }
  shuffleAlg = formatAlg(turns);
  app.history = app.history.slice(0, app.cursor).concat(turns);
  shuffling = true;
  for (let i = app.cursor; i < app.history.length; i++) enqueue(app.history[i], true);
  playing = queue.length > 0;
  setMessage("Shuffling…", "info");
  render();
}

function finishShuffle() {
  shuffling = false;
  setBase(app.current, "Shuffled");
  setMessage(`Shuffled with ${SHUFFLE_TURNS} turns: ${shuffleAlg}`, "ok");
}

/** Undo the last turn (Undo button, or a double tap on the 3D view). */
function undoLast() {
  if (app.cursor <= 0) {
    setMessage("Nothing to undo", "info");
    render();
    return;
  }
  flushAnimations();
  const before = app.current;
  const last = app.history[app.cursor - 1];
  // The history and cursor change now, together; only the animation waits in the queue,
  // so anything that flushes the queue first still leaves them consistent.
  app.history = app.history.slice(0, app.cursor - 1);
  app.cursor--;
  recompute();
  queue.push({ turn: last, forward: false, from: before });
  setMessage(`Undid ${turnName(last)}`, "info");
  render();
}

// A tap is a quick touch that barely moves; two taps close together undo the last turn.
const TAP_MS = 250;
const DOUBLE_TAP_MS = 330;
const DOUBLE_TAP_PX = 40;

function bindOrbit(el: HTMLElement) {
  let tap: { x: number; y: number; t: number; ok: boolean } | null = null;
  let lastTap: { x: number; y: number; t: number } | null = null;
  const stage = el.parentElement!;
  // iOS starts text selection / the callout on a long press unless the touch's default
  // action is cancelled. Pointer events still arrive after this.
  el.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  el.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  for (const t of ["contextmenu", "selectstart", "dragstart"]) el.addEventListener(t, (e) => e.preventDefault());
  const pts = new Map<number, { x: number; y: number }>();
  let twist: number | null = null;
  // A finger that went down on the cube and hasn't yet become a turn or a tumble.
  // Taps and holds are timed by each event's own timestamp (when the finger moved), not by
  // when its handler runs, so a slow frame cannot turn a quick swipe into a hold.
  let pending: { id: number; x: number; y: number; t0: number; hit: CubeHit; timer: ReturnType<typeof setTimeout> } | null = null;
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
    if (pts.size === 1) tap = { x: e.clientX, y: e.clientY, t: e.timeStamp, ok: true };
    else if (tap) tap.ok = false; // two fingers: not a tap
    if (pts.size === 1) {
      ignore = false;
      const busy = anim || queue.length || settle;
      // While editing colors, a drag anywhere tumbles the view and a tap paints (below).
      const hit = busy || edit ? null : pickCube(el, e.clientX, e.clientY);
      if (hit) {
        const id = e.pointerId;
        pending = {
          id,
          x: e.clientX,
          y: e.clientY,
          t0: e.timeStamp,
          hit,
          // Shows that the hold registered; the first move decides (by its timestamp).
          timer: setTimeout(() => stage.classList.add("tumbling"), HOLD_TO_TUMBLE_MS),
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
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) >= SWIPE_PX) tap.ok = false;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pending && e.pointerId === pending.id) {
      const tx = e.clientX - pending.x, ty = e.clientY - pending.y;
      const held = e.timeStamp - pending.t0 >= HOLD_TO_TUMBLE_MS;
      if (!held && Math.hypot(tx, ty) < SWIPE_PX) return;
      const p0 = pending;
      clearPending();
      if (held) {
        // Held still before moving: this drag tumbles the view (below).
        stage.classList.add("tumbling");
      } else {
        stage.classList.remove("tumbling");
        flushAnimations();
        live = beginLiveTurn(el, p0.hit, p0.x, p0.y, tx, ty);
        liveId = live ? e.pointerId : null;
        if (!live) ignore = true;
        else updateLiveTurn(live, e.clientX, e.clientY);
        return;
      }
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
      if (Math.hypot(tx, ty) >= SWIPE_PX && e.timeStamp - p0.t0 < HOLD_TO_TUMBLE_MS) {
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
      const now = e.timeStamp;
      const isTap =
        tap && tap.ok && e.type === "pointerup" && now - tap.t < TAP_MS && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < SWIPE_PX;
      if (isTap && edit) {
        const h = pickCube(el, e.clientX, e.clientY);
        if (h) paintSticker(slotAtXYZ(h.cell[0], h.cell[1], h.cell[2]), dirIndex(h.normal));
      } else if (isTap) {
        if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DOUBLE_TAP_PX) {
          lastTap = null;
          undoLast();
        } else lastTap = { x: e.clientX, y: e.clientY, t: now };
      } else lastTap = null;
      tap = null;
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
/**
 * Turns waiting to animate. A job without `from` moves the cursor when it starts. A job
 * with `from` animates a change already made to the history and cursor (an undo), from
 * that earlier state to the current one.
 */
const queue: { turn: Turn; forward: boolean; from?: State }[] = [];
const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
// Speed slider 0..100 maps logarithmically from 800 ms (slowest) to 30 ms (fastest) per quarter turn.
// Milliseconds per quarter turn: 1600 at the slow end, 30 at the fast end; the default
// (52) is about 200.
const speedFromSlider = (v: number) => 1600 * Math.pow(30 / 1600, v / 100);
let speedMs = speedFromSlider(52);
/** True while "play" is running through the remaining turns. */
let playing = false;
let playingBack = false; // playing toward the start (◀) rather than the end (▶)

function enqueue(turn: Turn, forward: boolean) {
  if (guideArrows) guideArrows.visible = false; // the arrows describe the position before the step's first turn
  queue.push({ turn, forward });
}

function startNext() {
  const job = queue.shift();
  if (!job) return;
  showNetAnimation(true);
  const { turn, forward } = job;
  const before = job.from ?? app.current;
  // Move the cursor and compute the end state first.
  if (!job.from) {
    if (forward) app.cursor++;
    else app.cursor--;
    recompute();
  }
  const after = app.current;
  const d = MOVE_DEFS[turn.def];
  const amount = forward ? turn.amount : 4 - turn.amount;
  const duration = reduceMotion ? 0 : (shuffling ? SHUFFLE_MS : speedMs) * (amount === 2 ? 1.4 : 1);
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
  render();
}

function finishAnim() {
  if (!anim) return;
  for (const child of [...anim.group.children]) pivot.attach(child);
  pivot.remove(anim.group);
  syncMeshes(anim.after);
  anim = null;
  drawGuide(); // the turn may have ended the step, or brought the position back to its start
  if (!queue.length) showNetAnimation(false);
}

// ------------------------------------------------------------------ flat view animation
//
// The flat view is drawn by six orthographic cameras looking at the same scene, one per
// face, laid over the flat-view boxes. They see the unlit face planes (layer 2) and,
// when enabled, the edge glow (layer 4). Because it is the same scene, it animates.

const NET_LAYER = 2;
let netRenderer: any = null;
const netCams: { cam: any; face: string; view: Vec3; up: number[] }[] = [];

function initNetAnimation() {
  const canvas = $("net-canvas") as HTMLCanvasElement;
  netRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  matchR128Look(netRenderer);
  netRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  netRenderer.setScissorTest(true);
  netRenderer.setClearColor(0x000000, 0);
  // [face, direction toward the viewer, screen-up direction] in the puzzle's own frame
  const faces: [string, Vec3, number[]][] = [
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

const NET_HALF = 3.15; // world units from the center to the edge of each face box (room for the glow)

/** Points a flat-view camera straight at its face, for the puzzle's current orientation q. */
function aimNetCam(nc: (typeof netCams)[number], q: any) {
  const cam = nc.cam;
  cam.left = -NET_HALF;
  cam.right = NET_HALF;
  cam.top = NET_HALF;
  cam.bottom = -NET_HALF;
  cam.updateProjectionMatrix();
  cam.position.copy(new THREE.Vector3(nc.view[0], nc.view[1], nc.view[2]).multiplyScalar(10).applyQuaternion(q));
  cam.up.set(nc.up[0], nc.up[1], nc.up[2]).applyQuaternion(q);
  cam.lookAt(0, 0, 0);
  return cam;
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
    const cam = aimNetCam(nc, q);
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
  shadeDuringTurn({ def: anim.turn.def, angle: anim.angle * e, before: anim.before });
  if (t >= 1) {
    finishAnim();
    if (playing && !queue.length) {
      playing = false;
      if (shuffling) finishShuffle();
      render();
    }
  }
}

function flushAnimations() {
  shuffling = false;
  cancelLiveTurn();
  queue.length = 0;
  playing = false;
  showNetAnimation(false);
  if (anim) finishAnim();
  syncMeshes(app.current);
}

// ------------------------------------------------------------------ actions

// Messages float over the page near the bottom (they never move the layout) and fade
// after a few seconds, longer for errors; tapping one dismisses it.
let messageSeq = 0;
let messageShown = 0;
let messageTimer: ReturnType<typeof setTimeout> | undefined;
function setMessage(text: string, kind: "info" | "error" | "ok" = "info") {
  app.message = text;
  app.messageKind = kind;
  messageSeq++;
}
function dismissMessage() {
  clearTimeout(messageTimer);
  app.message = "";
  $("message").hidden = true;
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

/** Typed or edited turns, checked from `from`: how many can be made before one is refused, and why. */
function legalPrefix(from: State, turns: Turn[]): { ok: number; why: string | null } {
  const probe = from.clone();
  for (let i = 0; i < turns.length; i++) {
    const why = blockedReason(probe, turns[i]);
    if (why) return { ok: i, why };
    applyTurn(probe, turns[i]);
  }
  return { ok: turns.length, why: null };
}

const stopsAt = (turns: Turn[], ok: number, why: string) => `Stops at turn ${ok + 1} of ${turns.length} (${turnName(turns[ok])}): ${why.replace(/^\w+ blocked: /, "")}`;

/**
 * While true, the turn field holds the whole turn list for editing (after Edit), and Load
 * reads Update: it replaces the list rather than adding at the current step.
 */
let editingTurns = false;
const algField = () => $("alg") as HTMLInputElement;

/** The Load button: adds the typed turns at the current step, or, while editing, replaces the list. */
function loadField() {
  if (editingTurns) updateTurns(algField().value);
  else if (runAlg(algField().value, false)) algField().value = "";
}

/** Starts or cancels editing the turn list in the field. */
function toggleEditTurns() {
  if (editingTurns) {
    editingTurns = false;
    algField().value = "";
  } else if (app.history.length) {
    editingTurns = true;
    algField().value = formatAlg(app.history);
    algField().focus();
  }
  render();
}

/** Replaces the turn list with the edited one. The position stays where the two lists agree. */
function updateTurns(src: string) {
  flushAnimations();
  let turns: Turn[];
  try {
    turns = parseAlg(src);
  } catch (e) {
    setMessage(e instanceof ParseError ? e.message : String(e), "error");
    return render();
  }
  const { ok, why } = legalPrefix(app.base, turns);
  const next = turns.slice(0, ok);
  let same = 0;
  while (same < Math.min(next.length, app.history.length) && turnName(next[same]) === turnName(app.history[same])) same++;
  app.history = next;
  app.cursor = Math.min(app.cursor, same);
  editingTurns = false;
  algField().value = "";
  recompute();
  syncMeshes(app.current);
  if (why) setMessage(stopsAt(turns, ok, why), "error");
  else setMessage(`Turn list updated: ${next.length} turns`, "ok");
  render();
}

/**
 * Adds an algorithm's turns at the current step, replacing any turns after it. Returns
 * whether any turns were added.
 */
function runAlg(src: string, play: boolean): boolean {
  flushAnimations();
  let turns: Turn[];
  try {
    turns = parseAlg(src);
  } catch (e) {
    setMessage(e instanceof ParseError ? e.message : String(e), "error");
    render();
    return false;
  }
  if (!turns.length) {
    setMessage("Type some moves first, for example (R U2)5", "error");
    render();
    return false;
  }
  // Check legality up front so the stop point is known.
  const { ok, why } = legalPrefix(app.current, turns);
  const startCursor = app.cursor;
  app.history = app.history.slice(0, app.cursor).concat(turns.slice(0, ok));
  if (why) setMessage(stopsAt(turns, ok, why), "error");
  else setMessage(`${turns.length} turns loaded`, "ok");
  if (play) for (let i = startCursor; i < app.history.length; i++) enqueue(app.history[i], true);
  playing = play && queue.length > 0;
  render();
  return ok > 0;
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
/** Plays the turns before the cursor backward, undoing each one, back to the start. */
function playToStart() {
  flushAnimations();
  for (let i = app.cursor - 1; i >= 0; i--) enqueue(app.history[i], false);
  playing = queue.length > 0;
  playingBack = playing;
  render();
}
function stopPlaying() {
  queue.length = 0;
  playing = false;
  shuffling = false;
  render();
}

function setBase(st: State, label: string) {
  flushAnimations();
  app.base = st.clone();
  app.baseLabel = label;
  app.history = [];
  app.cursor = 0;
  if (editingTurns) {
    editingTurns = false;
    algField().value = "";
  }
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
/** Store the list on this device. Returns null, or why it could not be stored. */
function writeDevice(list: Saved[]): string | null {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
    return null;
  } catch (e: any) {
    return e?.name === "QuotaExceededError" ? "this device's storage is full" : "this browser isn't allowing storage";
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
    watchAlgorithms();
    render();
    return;
  }
  db = ns;
  storeKind = "shared";
  watchAlgorithms();
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
    const why = writeDevice(list);
    if (why) {
      setMessage(`Could not save: ${why}`, "error");
    } else {
      saved = list;
      setMessage(`Saved "${entry.name}" on this device`, "ok");
    }
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
    const list = readDevice().filter((s) => s.id !== id);
    const why = writeDevice(list);
    if (why) setMessage(`Could not delete: ${why}`, "error");
    else saved = list;
  }
  pendingDelete = null;
  render();
}

// Algorithms: named turns with the position they apply to, kept like saved states (the
// shared database's "algorithms" collection, or this device). On a device the list starts
// as the known algorithms (src/core/algorithms.ts); the shared collection is seeded with
// them by Claude. Any of them can be deleted.
interface SavedAlg {
  id: string;
  name: string;
  alg: string;
  code: string; // the start position, a state code
  note?: string;
  savedAt: number;
  source?: string;
}
let algs: SavedAlg[] = [];
const ALG_LS_KEY = "xcube-lab-algorithms";
let pendingAlgDelete: string | null = null;

function readDeviceAlgs(): SavedAlg[] {
  try {
    const raw = localStorage.getItem(ALG_LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* unreadable: start from the known algorithms */
  }
  return KNOWN_ALGORITHMS.map((a, i) => ({ id: a.id, name: a.name, alg: a.alg, code: encodeState(a.start()), note: a.situation, savedAt: i + 1, source: "claude" }));
}
function writeDeviceAlgs(list: SavedAlg[]): string | null {
  try {
    localStorage.setItem(ALG_LS_KEY, JSON.stringify(list));
    return null;
  } catch (e: any) {
    return e?.name === "QuotaExceededError" ? "this device's storage is full" : "this browser isn't allowing storage";
  }
}

function watchAlgorithms() {
  if (!db) {
    algs = readDeviceAlgs();
    return;
  }
  db.collection("algorithms").onSnapshot(
    (snap: any) => {
      algs = snap.docs.map((d: any) => ({ id: d.id, ...(d.data() as object) }) as SavedAlg).sort((a: SavedAlg, b: SavedAlg) => (a.savedAt || 0) - (b.savedAt || 0));
      render();
    },
    (err: any) => {
      setMessage(`Algorithms unavailable (${err.code}).`, "error");
      render();
    },
  );
}

/** Saves the turn list, with the current start position, under `name`. */
async function saveAlgorithm(name: string) {
  const turns = app.history;
  if (!turns.length) {
    setMessage("Make or load some turns first, then save them.", "error");
    return render();
  }
  const entry = { name: name || formatAlg(turns), alg: formatAlg(turns), code: encodeState(app.base), note: `From ${app.baseLabel}`, savedAt: Date.now(), source: "page" };
  if (db) {
    try {
      await db.collection("algorithms").add(entry);
      setMessage(`Saved "${entry.name}"`, "ok");
    } catch (e: any) {
      setMessage(`Could not save: ${e?.message ?? e}`, "error");
    }
  } else {
    const list = [...algs, { id: String(Date.now()), ...entry }];
    const why = writeDeviceAlgs(list);
    if (why) setMessage(`Could not save: ${why}`, "error");
    else {
      algs = list;
      setMessage(`Saved "${entry.name}" on this device`, "ok");
    }
  }
  render();
}

async function deleteAlgorithm(id: string) {
  if (db) {
    try {
      await db.collection("algorithms").doc(id).delete();
    } catch (e: any) {
      setMessage(`Could not delete: ${e?.message ?? e}`, "error");
    }
  } else {
    const list = algs.filter((a) => a.id !== id);
    const why = writeDeviceAlgs(list);
    if (why) setMessage(`Could not delete: ${why}`, "error");
    else algs = list;
  }
  pendingAlgDelete = null;
  render();
}

function loadAlgorithm(id: string) {
  const a = algs.find((x) => x.id === id);
  if (!a) return;
  let start: State;
  try {
    start = decodeState(a.code);
  } catch (e) {
    setMessage(`Couldn't load "${a.name}": ${(e as Error).message}`, "error");
    return render();
  }
  setBase(start, a.name);
  runAlg(a.alg, false);
  setMessage(`Loaded "${a.name}". Play it with ▶ or step with ▶1.`, "ok");
  render();
}

function renderAlgorithms() {
  $("known-list").innerHTML = algs.length
    ? algs
        .map(
          (a) => `<li><div class="saved-main"><span class="saved-name">${escapeHtml(a.name)}</span><span class="known-alg">${escapeHtml(a.alg)}</span>${a.note ? `<span class="hint">${escapeHtml(a.note)}</span>` : ""}</div>
        <div class="saved-actions"><button class="btn small" data-alg-load="${a.id}">Load</button>
        ${pendingAlgDelete === a.id ? `<button class="btn small danger" data-alg-del-yes="${a.id}">Delete</button><button class="btn small" data-alg-del-no="1">Keep</button>` : `<button class="btn small ghost" data-alg-del="${a.id}" aria-label="Delete ${escapeHtml(a.name)}">✕</button>`}</div></li>`,
        )
        .join("")
    : `<li class="hint">${storeKind === "loading" ? "Loading algorithms…" : "No algorithms yet. Type turns above, name them, and save them."}</li>`;
}

function bindAlgorithms() {
  $("known-list").addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("button");
    const ds = el?.dataset;
    if (!ds) return;
    if (ds.algLoad) loadAlgorithm(ds.algLoad);
    else if (ds.algDel) {
      pendingAlgDelete = ds.algDel;
      render();
    } else if (ds.algDelYes) deleteAlgorithm(ds.algDelYes);
    else if (ds.algDelNo) {
      pendingAlgDelete = null;
      render();
    }
  });
  $("alg-save").addEventListener("click", () => {
    const n = $("alg-name") as HTMLInputElement;
    saveAlgorithm(n.value.trim());
    n.value = "";
  });
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
  refreshGuide();
  // status
  const shape = isHomeX(st) ? chip("X shape", "good") : isXShape(st) ? chip("X shape, tipped", "good") : chip("Out of shape", "warn");
  const solved = isSolved(st) ? chip("Solved", "good") : "";
  const outer = outerAvailability(st)
    .map(([n, c]) => chip(c === 9 ? n : `${n} ${c}/9`, c === 9 ? "on" : "off", c === 9 ? `${n} can turn` : `${n} refuses: ${c} of 9 cubelets`))
    .join("");
  $("status").innerHTML = `${shape}${solved}<span class="outer-label">Outer turns</span>${outer}`;

  // hold: which center colors face up, toward you and to your right, as they are now
  const side = (d: number) => {
    const c = faceCenterColor(st, d);
    return c ? COLOR_NAME[c] : "?";
  };
  $("hold").textContent = `Hold: ${side(2)} up, ${side(4)} front, ${side(0)} right`;
  $("hold").title = "Up, toward you, and on your right, by the center colors as they are now";

  // message
  const msg = $("message");
  msg.textContent = app.message;
  msg.className = `message ${app.messageKind}`;
  msg.hidden = !app.message;
  if (app.message && messageShown !== messageSeq) {
    messageShown = messageSeq;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(dismissMessage, app.messageKind === "error" ? 8000 : 4000);
  }

  // history strip
  const hist = app.history
    .map((t, i) => `<button class="tok ${i < app.cursor ? "done" : ""} ${i === app.cursor - 1 ? "cur" : ""}" data-jump="${i + 1}">${turnName(t)}</button>`)
    .join("");
  $("history").innerHTML = hist || `<span class="hint">Turns you make or load appear here. Tap one to jump to it.</span>`;
  $("counter").textContent = `${app.cursor} / ${app.history.length}`;
  $("load").textContent = editingTurns ? "Update" : "Load";
  $("alg-edit").textContent = editingTurns ? "Cancel" : "Edit";
  ($("alg-edit") as HTMLButtonElement).disabled = !editingTurns && !app.history.length;
  if (!playing) playingBack = false;
  const play = $("last");
  play.textContent = playing && !playingBack ? "■" : "▶";
  play.setAttribute("aria-label", playing && !playingBack ? "Stop" : "Play to the end");
  play.classList.toggle("stop", playing && !playingBack);
  const back = $("rewind");
  back.textContent = playing && playingBack ? "■" : "◀";
  back.setAttribute("aria-label", playing && playingBack ? "Stop" : "Play backward to the start");
  back.classList.toggle("stop", playing && playingBack);
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
          <button class="btn small" data-load="${s.id}" title="Make this position the start">Load</button>
          ${pendingDelete === s.id ? `<button class="btn small danger" data-del-yes="${s.id}">Delete</button><button class="btn small" data-del-no="1">Keep</button>` : `<button class="btn small ghost" data-del="${s.id}" aria-label="Delete ${escapeHtml(s.name)}">✕</button>`}
        </div></li>`,
        )
        .join("")
    : `<li class="hint">No saved states yet. Save the current position to come back to it later.</li>`;
  ($("code-out") as HTMLTextAreaElement).value = encodeState(st);
  // Only a position turns can't reach (from an X1 code or edited colors) has no letter
  // code. The note keeps its line either way, so the page doesn't shift.
  const why = unreachableReason(st);
  const note = $("code-note");
  note.textContent = why === null ? "" : "No letter code: turns can't reach this position.";
  note.title = why ?? "";
  renderAlgorithms();
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
    let downAt = 0; // event timestamp of the press
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
      downAt = e.timeStamp;
      long = false;
      timer = setTimeout(() => {
        long = true;
        show(true);
      }, LONG_PRESS_MS);
    });
    b.addEventListener("pointerup", (e) => {
      if (e.pointerId !== active) return;
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("button") === b;
      // Timed by the events, so a press held long enough counts even if the timer ran late.
      const inverted = long || e.timeStamp - downAt >= LONG_PRESS_MS;
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

/** Each section's heading collapses and expands it; the choice is remembered on this device. */
const SEC_KEY = "xcube-lab-collapsed";
function setupCollapsibles() {
  let closed: string[] = [];
  try {
    closed = JSON.parse(localStorage.getItem(SEC_KEY) || "[]");
  } catch {
    closed = [];
  }
  for (const sec of document.querySelectorAll<HTMLElement>("[data-sec]")) {
    const name = sec.dataset.sec!;
    const h = sec.querySelector("h2");
    if (!h) continue;
    // Mark the direct child that holds the heading as the part that stays visible.
    let head: HTMLElement = h;
    while (head.parentElement && head.parentElement !== sec) head = head.parentElement;
    head.classList.add("sec-head");
    h.classList.add("sec-toggle");
    h.setAttribute("role", "button");
    h.tabIndex = 0;
    const apply = (collapsed: boolean) => {
      sec.classList.toggle("collapsed", collapsed);
      h.setAttribute("aria-expanded", String(!collapsed));
      if (!collapsed && name === "view3d") requestAnimationFrame(() => resize());
    };
    apply(closed.includes(name));
    const toggle = () => {
      const collapsed = !sec.classList.contains("collapsed");
      apply(collapsed);
      closed = collapsed ? [...new Set([...closed, name])] : closed.filter((n) => n !== name);
      try {
        localStorage.setItem(SEC_KEY, JSON.stringify(closed));
      } catch {
        /* storage unavailable */
      }
    };
    h.addEventListener("click", toggle);
    h.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
  }
}

/** The ⓘ and Display buttons beside the 3D and flat views' headings each open a small panel over the view. */
function bindViewTools() {
  const pairs: [string, string][] = [
    ["info-btn", "info-pop"],
    ["render-btn", "render-pop"],
    ["flat-info-btn", "flat-info-pop"],
  ];
  const close = (except?: string) => {
    for (const [b, p] of pairs)
      if (p !== except) {
        $(p).hidden = true;
        $(b).setAttribute("aria-expanded", "false");
      }
  };
  for (const [b, p] of pairs)
    $(b).addEventListener("click", () => {
      const open = $(p).hidden;
      close(p);
      $(p).hidden = !open;
      $(b).setAttribute("aria-expanded", String(open));
    });
  // A tap anywhere else, or Escape, closes them.
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest(".pop") && !t.closest(".tool-btn")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  $("message").addEventListener("click", dismissMessage);
}

function bindUI() {
  bindAlgorithms();
  $("next-step").addEventListener("click", () => nextStep());
  bindViewTools();
  $("edit-start").addEventListener("click", () => startEdit());
  $("edit-done").addEventListener("click", () => endEdit(true));
  $("edit-cancel").addEventListener("click", () => endEdit(false));
  $("edit-status").addEventListener("click", (e) => {
    if (!edit || !$("edit-status").classList.contains("tappable")) return;
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-halo]")?.dataset.halo ?? "show";
    if (act === "prev" || act === "next") {
      const n = edit.fit.problems.length;
      const { i } = shownProblem();
      edit.selected = edit.fit.problems[(i + (act === "next" ? 1 : n - 1)) % n].slots.join();
    } else edit.hidden = act === "hide" ? shownProblem().slots.join() : null;
    renderEdit();
    if (act === "show" && edit.highlight) showHighlighted();
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-paint]")) {
    b.style.background = NET_COLOR[b.dataset.paint!];
    b.addEventListener("click", () => {
      if (!edit) return;
      edit.paint = b.dataset.paint as Color;
      renderEdit();
    });
  }
  setupCollapsibles();
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
  $("load").addEventListener("click", loadField);
  $("alg-edit").addEventListener("click", toggleEditTurns);
  $("alg").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") loadField();
  });
  $("back").addEventListener("click", () => step(-1));
  $("fwd").addEventListener("click", () => step(1));
  $("first").addEventListener("click", () => jump(0));
  $("last").addEventListener("click", () => (playing ? stopPlaying() : playToEnd()));
  $("rewind").addEventListener("click", () => (playing ? stopPlaying() : playToStart()));
  $("undo").addEventListener("click", () => undoLast());
  $("shuffle").addEventListener("click", () => shuffle());
  $("reset").addEventListener("click", () => {
    setBase(State.solved(), "Solved");
    setMessage("Reset to solved", "ok");
    render();
  });
  $("clear").addEventListener("click", () => {
    setBase(app.current, "Current position");
    setMessage("Turns cleared. This position is now the start", "ok");
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
      const d = Number(el.id.replace("compass-", ""));
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
  const shadows = $("shadows") as HTMLInputElement;
  shadows.checked = shadowsOn;
  shadows.addEventListener("change", () => {
    shadowsOn = shadows.checked;
    if (keyLight) keyLight.castShadow = shadowsOn;
    try {
      localStorage.setItem(SHADOW_KEY, shadowsOn ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  });
  const gloss = $("gloss") as HTMLInputElement;
  gloss.checked = glossOn;
  gloss.addEventListener("change", () => {
    glossOn = gloss.checked;
    applyGloss();
    try {
      localStorage.setItem(GLOSS_KEY, glossOn ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
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

// ------------------------------------------------------------------ color editing

// Edit colors: the owner repaints visible stickers to match a real cube, on the current
// shape. Each paint refits the colors to real cubelets (src/core/edit.ts). While they fit,
// the view shows the fitted state; while they don't, it shows the last fitted state with
// the differing stickers repainted on top. Done makes the fitted state the new start; the
// rest of the controls are inert while editing.

/** Sticker and flat-tile meshes by cubelet id * 6 + face (in the cubelet's own frame). */
const stickerMesh3d: any[] = [];
const tileMesh: any[] = [];
let paintMaterial: { sticker: (c: Color) => any; tile: (c: Color) => any; glow: (c: Color) => any[] } | null = null;
let grayMaterial: ((c: Color, level: 1 | 2) => { sticker: any; tile: any; glow: any[] }) | null = null;

interface Edit {
  shape: State; // the position editing started from; its shape is kept
  colors: FaceColors; // what the owner has painted
  fit: Fit;
  shown: State; // the last state that fit, drawn underneath the paint
  paint: Color;
  painted: any[]; // meshes currently drawn in a color other than their own
  highlight: number[] | null; // slots shown with a halo: the first problem's, unless hidden
  hidden: string | null; // the slots (joined) whose halo was hidden with Hide
  selected: string; // the slots (joined) of the problem the line shows, kept across paints
}
let edit: Edit | null = null;

function startEdit() {
  if (edit) return;
  flushAnimations();
  clearGuide();
  const st = app.current.clone();
  const colors = visibleColors(st);
  edit = { shape: st, colors, fit: fitColors(st, colors), shown: st.clone(), paint: "W", painted: [], highlight: null, hidden: null, selected: "" };
  document.body.classList.add("editing");
  ($("stack-col") as HTMLElement & { inert: boolean }).inert = true;
  renderEdit();
}

/** Paints the sticker on the face of `slot` facing world direction `dir`, if one is visible there. */
function paintSticker(slot: number, dir: number) {
  if (!edit) return;
  const i = slot * 6 + dir;
  if (!edit.colors[i]) return; // hidden, or bare plastic
  if (edit.colors[i] === edit.paint) return;
  edit.colors[i] = edit.paint;
  edit.fit = fitColors(edit.shape, edit.colors);
  if (edit.fit.state) edit.shown = edit.fit.state;
  renderEdit();
}

/** Draws the shown state, with every face that differs from the paint repainted on top. */
function drawEdit() {
  if (!edit || !paintMaterial) return;
  for (const m of edit.painted) m.material = m.userData.ownMaterial;
  edit.painted = [];
  clearGlowPaint();
  const shown = visibleColors(edit.shown);
  for (let i = 0; i < edit.colors.length; i++) {
    const want = edit.colors[i];
    if (!want || shown[i] === want) continue;
    const s = Math.floor(i / 6), dir = i % 6;
    const id = edit.shown.occ[s];
    const local = ROT_DIR[ROT_INV[edit.shown.ori[s]] * 6 + dir];
    for (const [mesh, mat] of [[stickerMesh3d[id * 6 + local], paintMaterial.sticker(want)], [tileMesh[id * 6 + local], paintMaterial.tile(want)]]) {
      if (!mesh) continue;
      mesh.userData.ownMaterial ??= mesh.material;
      mesh.material = mat;
      edit.painted.push(mesh);
    }
    // The glow bands around the edge show this sticker's color too.
    for (const gl of glows[id] ?? []) if (gl.b === local) gl.paint = paintMaterial.glow(want);
  }
  syncMeshes(edit.shown);
  placeHalos();
}

// ------------------------------------------------------------------ step guide
//
// Next step asks the solver (src/core/solve.ts) for one step from the position shown,
// puts its turns in the turn list, unplayed, and says what the step is for. Until the
// step has been played through, the cubelets it applies to keep their colors, the cubelets it
// leaves alone are gray, and the ones it may leave anywhere are darker gray; before its
// first turn, arrows show where the cubelets it moves will go.

const STAGE_NAME: Record<SolveStep["stage"], string> = { hold: "Hold", shape: "Shape", core: "Core", parity: "Parity", corners: "Corners", edges: "Edges" };

interface Guide {
  step: SolveStep;
  /** Steps left after this one. */
  after: number;
  /** Where in the turn list the step's turns begin, and the position there. */
  start: number;
  from: State;
  /** Cubelet ids: the ones the step is for, and the ones it may leave anywhere. */
  focus: Set<number>;
  free: Set<number>;
  /** Where each moved cubelet goes, as slots. */
  arrows: [number, number][];
}
let guide: Guide | null = null;
let guideLine = "";
let guideDimmed: any[] = []; // meshes drawn gray
let guideArrows: any = null;

function nextStep() {
  if (edit) return;
  flushAnimations();
  let steps: SolveStep[];
  try {
    steps = solveSteps(app.current);
  } catch (e) {
    clearGuide();
    guideLine = "";
    setMessage(`Can't solve from here: ${(e as Error).message}`, "error");
    return render();
  }
  clearGuide();
  if (!steps.length) {
    guideLine = "Solved. Nothing left to do.";
    return render();
  }
  const [step] = steps;
  const st = app.current;
  guide = {
    step,
    after: steps.length - 1,
    start: app.cursor,
    from: st.clone(),
    focus: new Set(step.moved.map(([from]) => st.occ[from])),
    free: new Set(step.free.map((s) => st.occ[s])),
    // A parity step turns whole layers: arrows for every cubelet in them would only tangle.
    arrows: step.stage === "parity" ? [] : step.moved.filter(([from, to]) => from !== to),
  };
  app.history = app.history.slice(0, app.cursor).concat(step.turns);
  setMessage(`${step.turns.length} turns loaded`, "ok");
  render();
}

/** Whether the guide's step is still in the turn list where it was put, starting from the position it was worked out for. */
function guideHolds(g: Guide): boolean {
  const there = app.history.slice(g.start, g.start + g.step.turns.length);
  if (there.length !== g.step.turns.length || !there.every((t, i) => turnName(t) === turnName(g.step.turns[i]))) return false;
  const st = app.base.clone();
  for (let i = 0; i < g.start; i++) applyTurn(st, app.history[i]);
  return st.equals(g.from);
}

function clearGuide() {
  guide = null;
  drawGuide();
}

/** Drops the guide when its turns are gone from the list, redraws its grays and arrows, and writes its line. */
function refreshGuide() {
  if (guide && !guideHolds(guide)) {
    guide = null;
    guideLine = "";
  }
  drawGuide();
  const line = $("guide-line");
  line.textContent = "";
  if (guide) {
    const { step, after, start } = guide;
    const done = app.cursor >= start + step.turns.length;
    const head = document.createElement("strong");
    head.textContent = `${STAGE_NAME[step.stage]}${done ? " (done)" : ""}: `;
    const alg = document.createElement("span");
    alg.className = "known-alg";
    alg.textContent = step.alg;
    // Three lines: what the step does, its turns, and how far there is to go.
    line.append(head, `${step.goal}. `, document.createElement("br"), "Turns: ", alg, " ", document.createElement("br"), after ? `${after} more ${after === 1 ? "step" : "steps"} after this.` : "This is the last step.");
  } else line.textContent = guideLine;
}

function drawGuide() {
  if (!grayMaterial) return;
  const g = guide;
  // During a turn the cursor is already past it; the grays go by the position the turn started from.
  const at = anim ? app.cursor + (anim.forward ? -1 : 1) : app.cursor;
  // A hold step only turns the whole puzzle, and the center colors are what it goes by: no grays.
  const within = !!g && g.step.stage !== "hold" && at >= g.start && at < g.start + g.step.turns.length;
  const key = within ? `${g!.start}/${g!.step.alg}` : "";
  if (guideArrows) guideArrows.visible = !!g && app.cursor === g.start && !anim && !queue.length;
  if (drawGuide.key === key) return;
  drawGuide.key = key;
  for (const m of guideDimmed) m.material = m.userData.ownMaterial;
  guideDimmed = [];
  clearGlowPaint();
  if (guideArrows) {
    pivot.remove(guideArrows);
    guideArrows = null;
  }
  if (within) {
    for (const c of CUBELETS) {
      if (g!.focus.has(c.id)) continue;
      const level = g!.free.has(c.id) ? 2 : 1;
      c.stickers.forEach((color, d) => {
        if (!color) return;
        const gray = grayMaterial!(color, level);
        for (const [mesh, mat] of [[stickerMesh3d[c.id * 6 + d], gray.sticker], [tileMesh[c.id * 6 + d], gray.tile]]) {
          if (!mesh) continue;
          mesh.userData.ownMaterial ??= mesh.material;
          mesh.material = mat;
          guideDimmed.push(mesh);
        }
        for (const gl of glows[c.id] ?? []) if (gl.b === d) gl.paint = gray.glow;
      });
    }
    guideArrows = makeArrows(g!.arrows);
    guideArrows.visible = app.cursor === g!.start && !anim && !queue.length;
    pivot.add(guideArrows);
  }
  if (!anim) syncMeshes(app.current);
}
drawGuide.key = "";

/** Arrows from slot to slot, arched out from the puzzle and drawn over it, in the 3D view only. */
function makeArrows(pairs: [number, number][]) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: HALO.color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.92 });
  for (const [from, to] of pairs) {
    const a = new THREE.Vector3(...SLOT_POS[from]).multiplyScalar(1.12);
    const b = new THREE.Vector3(...SLOT_POS[to]).multiplyScalar(1.12);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    // Arch away from the center; two spots straight across the puzzle arch upward.
    const out = mid.lengthSq() > 0.01 ? mid.clone().normalize() : new THREE.Vector3(0, 1, 0);
    const control = mid.clone().add(out.multiplyScalar(0.9 + 0.35 * a.distanceTo(b)));
    const curve = new THREE.QuadraticBezierCurve3(a, control, b);
    const headAt = 0.86;
    const pts = [...Array(21).keys()].map((i) => curve.getPoint((i / 20) * headAt));
    const shaft = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.07, 8), mat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5, 14), mat);
    const tip = curve.getPoint(1), base = curve.getPoint(headAt);
    head.position.copy(base.clone().add(tip).multiplyScalar(0.5));
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tip.clone().sub(base).normalize());
    for (const m of [shaft, head]) {
      m.renderOrder = 4;
      m.layers.set(HALO_LAYER);
      group.add(m);
    }
  }
  return group;
}

// ------------------------------------------------------------------ highlight halo

// A soft purple glow around a whole cubelet, outside its body, to point out the spot a
// color-editing problem names. Drawn on a box shell around the cubelet: each pixel finds
// how close its view ray passes to the cubelet's rounded body (the distance along the ray
// is convex, so a ternary search finds the closest point) and is purple by how near that
// is. Rays that hit the body draw nothing, so the cubelet itself keeps its look. It is drawn
// over everything, so it also shows where a cubelet is behind others. The 3D view has one
// halo per cubelet; the flat view has one for each face the cubelet shows, each seen only
// by that face's camera (layer FLAT_HALO_LAYER + direction), so it never marks a face where
// the cubelet is buried. Halos sit in the cubelet's group, so they follow turns, and on
// their own layers, so the probe's passes don't see them.
const HALO = { reach: 0.5, color: 0xa63dff, strength: 1 };
let haloMaterial: any = null;
const halos: any[] = [];

function haloMesh() {
  haloMaterial ??= new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(HALO.color) }, size: { value: 0.985 / 2 }, round: { value: BODY_RADIUS }, reach: { value: HALO.reach }, strength: { value: HALO.strength } },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    vertexShader: `
      varying vec3 vOrigin;
      varying vec3 vDir;
      void main() {
        // The view ray in the cubelet's own frame: from the camera (perspective), or
        // straight along the view direction from this point (orthographic).
        mat4 inv = inverse(modelViewMatrix);
        bool ortho = projectionMatrix[3][3] == 1.0;
        vec3 cam = (inv * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vOrigin = ortho ? position : cam;
        vDir = ortho ? (inv * vec4(0.0, 0.0, -1.0, 0.0)).xyz : position - cam;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 color;
      uniform float size;
      uniform float round;
      uniform float reach;
      uniform float strength;
      varying vec3 vOrigin;
      varying vec3 vDir;
      float body(vec3 p) {
        vec3 q = abs(p) - vec3(size - round);
        return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - round;
      }
      void main() {
        vec3 d = normalize(vDir);
        d = mix(d, vec3(1e-5), lessThan(abs(d), vec3(1e-5)));
        vec3 o = vOrigin;
        vec3 s = vec3(size + reach);
        vec3 t0 = (-s - o) / d, t1 = (s - o) / d;
        vec3 tn = min(t0, t1), tf = max(t0, t1);
        float a = max(max(tn.x, tn.y), max(tn.z, 0.0));
        float b = min(tf.x, min(tf.y, tf.z));
        if (b <= a) discard;
        for (int i = 0; i < 24; i++) {
          float m1 = a + (b - a) / 3.0, m2 = b - (b - a) / 3.0;
          if (body(o + d * m1) < body(o + d * m2)) b = m2; else a = m1;
        }
        float dist = body(o + d * (0.5 * (a + b)));
        if (dist <= 0.0) discard;
        float k = 1.0 - clamp(dist / reach, 0.0, 1.0);
        gl_FragColor = vec4(color, strength * pow(k, 1.5));
      }`,
  });
  const size = 0.985 + 2 * HALO.reach;
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), haloMaterial);
  m.renderOrder = 3;
  return m;
}

/** Puts halos on the cubelet in each highlighted slot of the shown state, and removes the rest. */
function placeHalos() {
  for (const h of halos) h.parent?.remove(h);
  if (!edit?.highlight) return;
  let n = 0;
  const add = (id: number, layer: number) => {
    if (n === halos.length) halos.push(haloMesh());
    const h = halos[n++];
    h.layers.set(layer);
    meshes[id].add(h);
  };
  for (const s of edit.highlight) {
    const id = edit.shown.occ[s];
    if (id < 0) continue;
    add(id, HALO_LAYER);
    for (let d = 0; d < 6; d++) if (isExposed(edit.shown, s, d)) add(id, FLAT_HALO_LAYER + d);
  }
}

/** How well the 3D view shows face d of slot s now: the cosine toward the camera, or -1 if it faces away, is edge-on or is blocked. */
function faceView(st: State, s: number, d: number): number {
  const id = st.occ[s];
  if (id < 0 || !isExposed(st, s, d)) return -1;
  pivot.updateMatrixWorld(true);
  const p = SLOT_POS[s], v = DIRS[d];
  const target = pivot.localToWorld(new THREE.Vector3(p[0] + v[0] * 0.45, p[1] + v[1] * 0.45, p[2] + v[2] * 0.45));
  const cos = new THREE.Vector3(...v).applyQuaternion(pivot.quaternion).dot(camera.position.clone().sub(target).normalize());
  if (cos < 0.2) return -1;
  const ray = new THREE.Raycaster(camera.position, target.clone().sub(camera.position).normalize());
  ray.layers.set(0);
  let o = ray.intersectObjects(pivot.children, true)[0]?.object;
  while (o && o.parent && o.parent !== pivot) o = o.parent;
  return o === meshes[id] ? cos : -1;
}

/** How many of slot s's exposed faces the 3D view shows now, unblocked. */
function facesSeen(st: State, s: number): number {
  let n = 0;
  for (let d = 0; d < 6; d++) if (faceView(st, s, d) > 0) n++;
  return n;
}

/** The pivot rotation that looks at the puzzle from direction v (puzzle frame), keeping up up (or front or back, looking from above or below). */
function lookFrom(v: any): any {
  const z = v.clone().normalize();
  const up = Math.abs(z.y) > 0.9 ? new THREE.Vector3(0, 0, z.y > 0 ? -1 : 1) : new THREE.Vector3(0, 1, 0);
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)).invert();
}

/**
 * Turns the 3D view to show the highlighted cubelets' stickers best: the most of them
 * unblocked, then each as squarely as possible. Tries the preset views and looking from
 * between the stickers' directions. Only on the owner's tap: a halo appearing never moves the view.
 */
function showHighlighted() {
  if (!edit?.highlight) return;
  const st = edit.shown;
  const faces: [number, number][] = [];
  for (const s of edit.highlight) for (let d = 0; d < 6; d++) if (isExposed(st, s, d) && edit.colors[s * 6 + d]) faces.push([s, d]);
  if (!faces.length) for (const s of edit.highlight) for (let d = 0; d < 6; d++) if (isExposed(st, s, d)) faces.push([s, d]);
  if (!faces.length) return;
  if (tween) (pivot.quaternion.copy(tween.to), (tween = null));
  const score = () => {
    const seen = faces.map(([s, d]) => faceView(st, s, d)).filter((c) => c > 0);
    return seen.length * 10 + seen.reduce((a, b) => a + b, 0) / faces.length;
  };
  const dirs = [...new Set(faces.map(([, d]) => d))];
  const candidates: any[] = Object.values(VIEWS).map((q) => new THREE.Quaternion(q[0], q[1], q[2], q[3]));
  for (let m = 1; m < 1 << dirs.length; m++) {
    const v = new THREE.Vector3();
    dirs.forEach((d, i) => m & (1 << i) && v.add(new THREE.Vector3(...DIRS[d])));
    if (v.lengthSq() > 1e-6) candidates.push(lookFrom(v));
  }
  const own = pivot.quaternion.clone();
  let best = own, bestScore = -1;
  for (const q of candidates) {
    pivot.quaternion.copy(q);
    const sc = score();
    if (sc > bestScore + 1e-6) (best = q), (bestScore = sc);
  }
  pivot.quaternion.copy(own);
  pivot.updateMatrixWorld(true);
  goToView([best.x, best.y, best.z, best.w]);
}

/** The halo shows the first problem's slots, unless Hide was used on those same slots. */
/** The problem the line shows: the one picked with ‹ and › if it is still there, else the first. */
function shownProblem(): { i: number; slots: number[] } {
  const problems = edit && edit.fit.level !== "reachable" ? edit.fit.problems : [];
  const i = Math.max(0, problems.findIndex((p) => p.slots.join() === edit!.selected));
  return { i, slots: problems[i]?.slots ?? [] };
}

function updateHighlight() {
  if (!edit) return;
  const { slots } = shownProblem();
  edit.selected = slots.join();
  if (edit.hidden !== slots.join()) edit.hidden = null; // Hide lasts until other cubelets are named
  edit.highlight = slots.length && edit.hidden === null ? [...slots] : null;
}

/** Returns every glow band to its own sticker's color. */
function clearGlowPaint() {
  for (const list of glows) for (const gl of list ?? []) gl.paint = undefined;
}

function renderEdit() {
  $("edit-bar").hidden = !edit;
  $("edit-start").hidden = !!edit;
  if (!edit) return;
  updateHighlight();
  drawEdit();
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-paint]")) b.setAttribute("aria-checked", String(b.dataset.paint === edit.paint));
  const st = $("edit-status");
  const { level, problems } = edit.fit;
  const { i } = shownProblem();
  if (level === "reachable") {
    st.className = "edit-status good";
    st.textContent = "Valid";
  } else {
    st.className = "edit-status bad";
    st.textContent = `Not valid: ${problems[i].text}.`;
  }
  // With several problems, ‹ and › step through them, and the halo moves with the line. A
  // problem about particular spots shows them with a halo by itself; Show (or tapping the
  // line) also tumbles the view to them; Hide removes the halo until the spots change.
  if (level !== "reachable" && problems.length > 1) {
    const nav = document.createElement("span");
    nav.className = "edit-nav";
    const step = (act: string, label: string, name: string) => {
      const b = document.createElement("button");
      b.className = "edit-step";
      b.dataset.halo = act;
      b.textContent = label;
      b.setAttribute("aria-label", name);
      return b;
    };
    nav.append(step("prev", "‹", "Previous problem"), `${i + 1}/${problems.length}`, step("next", "›", "Next problem"));
    st.append(" ", nav);
  }
  const tappable = level !== "reachable" && problems[i].slots.length > 0;
  st.classList.toggle("tappable", tappable || (level !== "reachable" && problems.length > 1));
  if (tappable) {
    const actions: [string, string][] = edit.highlight ? [["show", "Show"], ["hide", "Hide"]] : [["show", "Show"]];
    for (const [act, label] of actions) {
      const b = document.createElement("button");
      b.className = "edit-show";
      b.dataset.halo = act;
      b.textContent = label;
      st.append(" ", b);
    }
  }
  ($("edit-done") as HTMLButtonElement).disabled = level !== "reachable";
}

function endEdit(apply: boolean) {
  if (!edit) return;
  const e = edit;
  for (const m of e.painted) m.material = m.userData.ownMaterial;
  clearGlowPaint();
  edit = null;
  placeHalos();
  document.body.classList.remove("editing");
  ($("stack-col") as HTMLElement & { inert: boolean }).inert = false;
  if (apply && e.fit.level === "reachable" && e.fit.state) {
    const changed = !e.fit.state.equals(app.current);
    if (changed) setBase(e.fit.state, "Edited colors");
    setMessage(changed ? "The edited position is now the start" : "No colors changed", "ok");
  } else syncMeshes(app.current);
  renderEdit();
  render();
}

// ------------------------------------------------------------------ probe for browser tests

// window.xcubeProbe answers "what is drawn where" for scripts/browser-tests.mjs. Apart
// from the fault methods (which the tests use to check that a misdrawn cubelet is caught),
// it only reads: it draws into its own offscreen buffer, so the visible views don't change.
// - model(slot, face): the color the puzzle model says is there.
// - sticker(slot, face): where the center of the sticker in that slot, facing that way,
//   appears on screen (client coordinates), to aim gestures at.
// - at3d(x, y), scan3d() and flatFace(face): what is drawn there. One offscreen pass draws
//   each sticker in a color that encodes its cubelet and face (an ID buffer); the slot
//   and direction it is drawn at come from that cubelet's mesh transform (not from the
//   model), along with the cubelet the model has in that slot; a second pass draws each sticker in the plain
//   color of the material it is drawn with (no lighting, shading, shadows, glow or
//   gloss), which gives the color.
// Answers are meaningful only while nothing is moving (idle()).

const probeInfo = new Map<any, { id: number; d: number }>();
const PROBE_PLASTIC = 0x404040;
let probeUnstickered = 0x808080; // set to the flat view's unstickered tile color
const probeMats = new Map<string, any>();
let probeTarget: any = null;

/** The stand-in material for a mesh: its ID code, or the color of the material it is drawn with. */
function probeMaterial(info: { id: number; d: number } | undefined, mode: "id" | "color", drawn: any) {
  let hex: number;
  if (mode === "id") {
    const code = info ? info.id * 7 + info.d + 1 : 0; // d 0-5: a sticker or tile; 6: the plastic
    hex = ((code & 255) << 16) | ((code >> 8) << 8);
  } else hex = info && info.d < 6 && drawn?.color ? drawn.color.getHex() : PROBE_PLASTIC;
  const key = mode + hex;
  if (!probeMats.has(key)) {
    const c = new THREE.Color();
    c.setRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, THREE.LinearSRGBColorSpace);
    probeMats.set(key, new THREE.MeshBasicMaterial({ color: c, toneMapped: false }));
  }
  return probeMats.get(key);
}

/** The scene drawn by cam into a w x h offscreen buffer, as RGBA rows from the bottom ("drawn": with the meshes' own materials). */
function probeImage(cam: any, layer: number, w: number, h: number, mode: "id" | "color" | "drawn"): Uint8Array {
  probeTarget ??= new THREE.WebGLRenderTarget(1, 1);
  if (probeTarget.width !== w || probeTarget.height !== h) probeTarget.setSize(w, h);
  const swapped: [any, any][] = [];
  pivot.traverse((o: any) => {
    if (!o.isMesh || mode === "drawn") return;
    swapped.push([o, o.material]);
    o.material = probeMaterial(probeInfo.get(o), mode, o.material);
  });
  const mask = cam.layers.mask;
  cam.layers.set(layer);
  const clear = renderer.getClearColor(new THREE.Color());
  const alpha = renderer.getClearAlpha();
  const out = new Uint8Array(w * h * 4);
  try {
    renderer.setRenderTarget(probeTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(probeTarget, 0, 0, w, h, out);
  } finally {
    renderer.setRenderTarget(null);
    renderer.setClearColor(clear, alpha);
    cam.layers.mask = mask;
    for (const [o, m] of swapped) o.material = m;
  }
  return out;
}

type ProbeHit = { slot: string; face: string; color: string; cubelet: number; modelCubelet: number } | { plastic: true; slot: string; cubelet: number } | null;


/** What the two passes show at pixel (px, py) from the top left. */
function probeDecode(ids: Uint8Array, colors: Uint8Array, w: number, h: number, px: number, py: number): ProbeHit {
  const i = ((h - 1 - Math.floor(py)) * w + Math.floor(px)) * 4;
  if (ids[i + 3] === 0) return null; // background
  const code = ids[i] + ids[i + 1] * 256;
  const cubelet = Math.floor((code - 1) / 7), d = (code - 1) % 7;
  // Where it was drawn: from the mesh's own transform in the puzzle frame, not from the
  // model, so a cubelet drawn in the wrong place or turned the wrong way shows up.
  const g = meshes[cubelet];
  const slot = slotAtXYZ(Math.round(g.position.x), Math.round(g.position.y), Math.round(g.position.z));
  if (d === 6) return { plastic: true, slot: slot < 0 ? "?" : slotName(slot), cubelet };
  const n = new THREE.Vector3(DIRS[d][0], DIRS[d][1], DIRS[d][2]).applyQuaternion(g.quaternion);
  const dir = dirIndex([Math.round(n.x), Math.round(n.y), Math.round(n.z)]);
  const face = dir < 0 ? "?" : COMPASS_FACES[dir];
  let color = "?", best = Infinity;
  const named: [string, number][] = [...(Object.entries(STICKER) as [string, number][]), ["unstickered", probeUnstickered], ["plastic", PROBE_PLASTIC]];
  for (const [name, hex] of named) {
    const dist = Math.abs(colors[i] - ((hex >> 16) & 255)) + Math.abs(colors[i + 1] - ((hex >> 8) & 255)) + Math.abs(colors[i + 2] - (hex & 255));
    if (dist < best) [best, color] = [dist, name];
  }
  if (best > 12) color = "?";
  return { slot: slot < 0 ? "?" : slotName(slot), face, color, cubelet, modelCubelet: slot < 0 ? -1 : app.current.occ[slot] };
}

/** Both passes of the 3D view, with a lookup by client coordinates. */
function probe3d() {
  const r = (renderer.domElement as HTMLCanvasElement).getBoundingClientRect();
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const ids = probeImage(camera, 0, size.x, size.y, "id");
  const colors = probeImage(camera, 0, size.x, size.y, "color");
  return { r, at: (x: number, y: number) => probeDecode(ids, colors, size.x, size.y, ((x - r.left) / r.width) * size.x, ((y - r.top) / r.height) * size.y) };
}

function installProbe() {
  const canvas = () => renderer.domElement as HTMLCanvasElement;
  const slotByName = (name: string) => {
    for (let s = 0; s < NUM_SLOTS; s++) if (slotName(s) === name) return s;
    throw new Error(`no slot named ${name}`);
  };
  (window as any).xcubeProbe = {
    idle: () => !anim && !queue.length && !settle && !live && !tween,
    state: () => encodeState(app.current),
    turns: () => formatAlg(app.history.slice(0, app.cursor)),
    /** The step guide: its step, the slots (now) of the cubelets it applies to, how many stickers are drawn gray at each level, and the arrows showing. */
    guide: () => {
      if (!guide) return null;
      const grays = [1, 2].map((level) => guideDimmed.filter((m) => stickerMesh3d.includes(m) && CUBELETS.some((c) => c.stickers.some((col) => col && grayMaterial!(col, level as 1 | 2).sticker === m.material))).length);
      return {
        stage: guide.step.stage,
        alg: guide.step.alg,
        turns: guide.step.turns.length,
        after: guide.after,
        focus: [...guide.focus].map((id) => slotName(app.current.occ.indexOf(id))).sort(),
        gray: grays[0],
        darkGray: grays[1],
        arrows: guideArrows?.visible ? guideArrows.children.length / 2 : 0,
      };
    },
    view: () => pivot.quaternion.toArray(),
    // Deliberate faults, for testing the tests: draw two cubelets in each other's places,
    // or turn one cubelet's mesh a quarter turn about a face's axis. resync() redraws
    // every cubelet where the model puts it.
    faultSwap(a: string, b: string) {
      const ga = meshes[app.current.occ[slotByName(a)]], gb = meshes[app.current.occ[slotByName(b)]];
      const [pa, qa] = [ga.position.clone(), ga.quaternion.clone()];
      ga.position.copy(gb.position);
      ga.quaternion.copy(gb.quaternion);
      gb.position.copy(pa);
      gb.quaternion.copy(qa);
    },
    faultTwist(slot: string, face: string) {
      const g = meshes[app.current.occ[slotByName(slot)]];
      const a = DIRS[COMPASS_FACES.indexOf(face)];
      g.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(a[0], a[1], a[2]), HALF));
    },
    resync: () => syncMeshes(app.current),
    /** Milliseconds per quarter turn, as the speed slider sets it. */
    speed: () => speedMs,
    /** While editing colors: how the painted colors fit, and the color of a painted face. */
    editing: () => edit && { level: edit.fit.level, problems: edit.fit.problems.map((p) => p.text), paint: edit.paint },
    // The slots with a halo, how many of a slot's faces the 3D view shows unblocked, and
    // how many pixels of halo a view ("3d" or a flat-view face letter) draws, alone.
    highlighted: () => (edit?.highlight ?? []).map(slotName),
    facesSeen: (slot: string) => facesSeen(edit?.shown ?? app.current, slotByName(slot)),
    haloPixels: (view: string) => {
      const nc = netCams.find((c) => c.face === view);
      const img = probeImage(nc ? nc.cam : camera, nc ? FLAT_HALO_LAYER + dirIndex(nc.view) : HALO_LAYER, 96, 96, "drawn");
      let n = 0;
      for (let i = 3; i < img.length; i += 4) if (img[i] > 20) n++;
      return n;
    },
    painted: (slot: string, face: string) => edit?.colors[slotByName(slot) * 6 + COMPASS_FACES.indexOf(face)] ?? null,
    /**
     * The edge glow of the cubelet in slot alone, as drawn by the 3D view (view "3d") or
     * a face's flat-view camera (view "U", "F", ...): its opacity (0-1) at the point
     * offset from the slot's center by each [face, distance], in the puzzle's frame.
     */
    /** The colors the glow bands showing the sticker in slot, facing face, are drawn in. */
    glowColors(slot: string, face: string) {
      const s = slotByName(slot);
      const st = edit?.shown ?? app.current;
      const local = ROT_DIR[ROT_INV[st.ori[s]] * 6 + COMPASS_FACES.indexOf(face)];
      const byHex = new Map(Object.entries(STICKER).map(([c, h]) => [h, c]));
      return [...new Set(glows[st.occ[s]].filter((g) => g.b === local).flatMap((g) => [g.mesh, g.corner]).map((m) => byHex.get(m.material.uniforms.color.value.getHex())))].sort();
    },
    /** Where the glow lies: depth of a band below its face, and the radius of a rounded corner. */
    glowShape: () => ({ depth: GLOW_DEPTH, round: GLOW_ROUND }),
    glowAt(slot: string, view: string, points: [string, number][][]) {
      const s = slotByName(slot);
      const own = new Set(glows[app.current.occ[s]].flatMap((g) => [g.mesh, g.corner]));
      const nc = netCams.find((c) => c.face === view);
      const cam = nc ? aimNetCam(nc, pivot.quaternion) : camera;
      const n = 400;
      const hidden: any[] = [];
      for (const list of glows) for (const g of list ?? []) for (const m of [g.mesh, g.corner]) if (m.visible && !own.has(m)) (hidden.push(m), (m.visible = false));
      let img: Uint8Array;
      try {
        img = probeImage(cam, nc ? GLOWNET_LAYER : GLOW3D_LAYER, n, n, "drawn");
      } finally {
        for (const m of hidden) m.visible = true;
      }
      cam.updateMatrixWorld();
      return points.map((offs) => {
        const local = new THREE.Vector3(...SLOT_POS[s]);
        for (const [f, k] of offs) local.add(new THREE.Vector3(...DIRS[COMPASS_FACES.indexOf(f)]).multiplyScalar(k));
        const p = pivot.localToWorld(local).project(cam);
        const px = Math.min(n - 1, Math.max(0, Math.floor(((p.x + 1) / 2) * n)));
        const py = Math.min(n - 1, Math.max(0, Math.floor(((p.y + 1) / 2) * n)));
        return img[(py * n + px) * 4 + 3] / 255;
      });
    },
    shadeRestError,
    /**
     * Flat-view shading over every flat tile: how many tiles are shaded and how many have
     * bands on two opposite edges (a recess between two walls); the largest gap between
     * the drawn value at an edge's midpoint and that edge's band (should be ~0); the
     * darkest value drawn past the ramp from every edge (should be 1, a clean middle); and
     * the darkest value drawn anywhere, with the darkness of one band.
     */
    flatShadeProfile() {
      let shaded = 0, channels = 0, edgeErr = 0, middle = 1, darkest = 1;
      for (const list of aoFaces)
        for (const f of list ?? []) {
          if (f.view !== "flat" || !f.cur) continue;
          const n = f.cur;
          if (n.some((v) => v > 0)) shaded++;
          if ((n[4] > 0 && n[5] > 0) || (n[6] > 0 && n[7] > 0)) channels++;
          const a = f.mesh.geometry.attributes.color.array as Float32Array;
          const pos = f.mesh.geometry.attributes.position;
          for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i) / f.extent + 0.5, y = pos.getY(i) / f.extent + 0.5, v = a[i * 3];
            darkest = Math.min(darkest, v);
            const mid = (t: number) => Math.abs(t - 0.5) < 1e-6, at0 = (t: number) => Math.abs(t) < 1e-6, at1 = (t: number) => Math.abs(t - 1) < 1e-6;
            if (mid(y) && at0(x)) edgeErr = Math.max(edgeErr, Math.abs(v - (1 - n[4])));
            if (mid(y) && at1(x)) edgeErr = Math.max(edgeErr, Math.abs(v - (1 - n[5])));
            if (mid(x) && at0(y)) edgeErr = Math.max(edgeErr, Math.abs(v - (1 - n[6])));
            if (mid(x) && at1(y)) edgeErr = Math.max(edgeErr, Math.abs(v - (1 - n[7])));
            if (Math.min(x, 1 - x) >= FLAT_AO_RAMP && Math.min(y, 1 - y) >= FLAT_AO_RAMP) middle = Math.min(middle, v);
          }
        }
      return { shaded, channels, edgeErr, middle, darkest, oneBand: 1 - FLAT_EDGE_DARK };
    },
    /** What the effect switches currently control: glow layers, the key light's shadows, grid shading. */
    effects: () => ({ glow3d: camera.layers.isEnabled(GLOW3D_LAYER), glowFlat: netCams.every((c) => c.cam.layers.isEnabled(GLOWNET_LAYER)), shadows: !!keyLight?.castShadow, shading: aoOn["3d"] && aoOn.flat }),
    /** The color the model says the sticker in slot shows toward face (null: none). */
    model(slot: string, face: string) {
      const s = slotByName(slot);
      return app.current.occ[s] < 0 ? null : app.current.colorAt(s, COMPASS_FACES.indexOf(face));
    },
    sticker(slot: string, face: string) {
      const s = slotByName(slot);
      const drawn = edit?.shown ?? app.current; // while editing colors, the state drawn underneath
      const id = drawn.occ[s];
      const dir = COMPASS_FACES.indexOf(face);
      if (id < 0 || dir < 0) return null;
      const o = drawn.ori[s];
      const d = [0, 1, 2, 3, 4, 5].find((k) => ROT_DIR[o * 6 + k] === dir)!;
      if (!CUBELETS[id].stickers[d]) return null;
      const p = meshes[id].localToWorld(new THREE.Vector3(DIRS[d][0] * 0.4945, DIRS[d][1] * 0.4945, DIRS[d][2] * 0.4945)).project(camera);
      const r = canvas().getBoundingClientRect();
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
    },
    at3d: (x: number, y: number) => probe3d().at(x, y),
    /** Every distinct (slot, face, color) drawn in the 3D view, sampled every step CSS pixels. */
    scan3d(step = 6) {
      const { r, at } = probe3d();
      const seen = new Map<string, ProbeHit>();
      for (let y = r.top + step / 2; y < r.bottom; y += step)
        for (let x = r.left + step / 2; x < r.right; x += step) {
          const h = at(x, y);
          if (h && !("plastic" in h)) seen.set(`${h.slot}/${h.face}/${h.color}`, h);
        }
      return [...seen.values()];
    },
    /**
     * Stickers the model says face the 3D view's camera that are not drawn: at the center
     * of each, the drawing shows that slot's cubelet without that sticker, or nothing.
     * (Where another cubelet is drawn in front, the sticker is hidden, not missing.)
     */
    missing3d() {
      const { r, at } = probe3d();
      const st = app.current;
      const out: string[] = [];
      for (let s = 0; s < NUM_SLOTS; s++) {
        const id = st.occ[s];
        if (id < 0) continue;
        for (let dir = 0; dir < 6; dir++) {
          if (!st.colorAt(s, dir) || !isExposed(st, s, dir)) continue;
          const local = new THREE.Vector3(...SLOT_POS[s]).add(new THREE.Vector3(...DIRS[dir]).multiplyScalar(0.4945));
          const world = pivot.localToWorld(local.clone());
          const normal = new THREE.Vector3(...DIRS[dir]).applyQuaternion(pivot.quaternion);
          if (normal.dot(camera.position.clone().sub(world)) <= 0) continue; // faces away
          const p = world.project(camera);
          const h = at(r.left + ((p.x + 1) / 2) * r.width, r.top + ((1 - p.y) / 2) * r.height);
          const name = `${slotName(s)}/${COMPASS_FACES[dir]}`;
          if (!h) out.push(`${name}: nothing drawn`);
          else if (h.slot !== slotName(s)) continue; // hidden behind another cubelet
          else if ("plastic" in h) out.push(`${name}: cubelet ${h.cubelet} drawn without it`);
          else if (h.face !== COMPASS_FACES[dir] || h.cubelet !== id) out.push(`${name}: ${h.slot}/${h.face} of cubelet ${h.cubelet} drawn there`);
        }
      }
      return out;
    },
    /** One face of the flat view as 5 rows of 5 cells, top row first, as that face is seen. */
    flatFace(face: string) {
      const nc = netCams.find((c) => c.face === face);
      if (!nc) return null;
      const cam = aimNetCam(nc, pivot.quaternion);
      const n = 210;
      const ids = probeImage(cam, NET_LAYER, n, n, "id");
      const colors = probeImage(cam, NET_LAYER, n, n, "color");
      const toPx = (u: number) => ((u + NET_HALF) / (2 * NET_HALF)) * n;
      return [0, 1, 2, 3, 4].map((row) => [0, 1, 2, 3, 4].map((col) => probeDecode(ids, colors, n, n, toPx(col - 2), toPx(row - 2))));
    },
  };
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
    installProbe();
    render();
    initStore();
  };
  hot?.snapshot?.(() => ({ base: encodeState(app.base), baseLabel: app.baseLabel, history: formatAlg(app.history), cursor: app.cursor }));
  if (hot?.ready) hot.ready(start);
  else start(hot?.data ?? {});
}

void FACE_COLOR;
hotBoot();
