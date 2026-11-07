// X-Cube Lab: browser viewer. Uses the same engine as the CLI.
// three.js r128 is loaded as a global from cdnjs by the page.

import { isHomeX, isSolved, isXShape, outerAvailability, faceView, effect } from "../core/analyze.ts";
import { ROTATIONS } from "../core/geometry.ts";
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
function initScene(canvas: HTMLCanvasElement) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  scene.add(new THREE.AmbientLight(0xffffff, 0.72));
  const key = new THREE.DirectionalLight(0xffffff, 0.55);
  key.position.set(4, 9, 7);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.25);
  fill.position.set(-6, -4, -5);
  scene.add(fill);
  pivot = new THREE.Group();
  const h = VIEWS.home;
  pivot.quaternion.set(h[0], h[1], h[2], h[3]);
  scene.add(pivot);
  camera.position.set(0, 0, 13.5);
  camera.lookAt(0, 0, 0);

  // Cubelets nearly touch, as on the real puzzle: a hairline gap between them.
  const body = new THREE.BoxGeometry(0.985, 0.985, 0.985);
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x141414 });
  const plane = new THREE.PlaneGeometry(0.84, 0.84);
  const mats = new Map<Color, any>();
  const matFor = (c: Color) => {
    if (!mats.has(c)) mats.set(c, new THREE.MeshLambertMaterial({ color: STICKER[c] }));
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
    c.stickers.forEach((col, d) => {
      if (!col) return;
      const m = new THREE.Mesh(plane, matFor(col));
      const [px, py, pz, rx, ry] = faceXform[d];
      m.position.set(px, py, pz);
      m.rotation.set(rx, ry, 0);
      g.add(m);
    });
    pivot.add(g);
    meshes[c.id] = g;
  }
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
    if (id >= 0) placeMesh(meshes[id], s, st.ori[s]);
  }
}

function resize() {
  const canvas = renderer.domElement as HTMLCanvasElement;
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 300;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function frame() {
  if (tween) {
    const t = tween.ms ? Math.min(1, (performance.now() - tween.start) / tween.ms) : 1;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    pivot.quaternion.copy(tween.from).slerp(tween.to, e);
    if (t >= 1) tween = null;
  }
  tickAnimation();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// One finger (or mouse): sliding sideways spins the puzzle around its own
// vertical (U-D) axis, like a turntable; sliding up and down tips it toward or
// away from you. Two fingers twist it around the axis pointing out of the screen.
function bindOrbit(el: HTMLElement) {
  const pts = new Map<number, { x: number; y: number }>();
  let twist: number | null = null;
  const spin = (q: Quat) => {
    tween = null;
    const t = new THREE.Quaternion(q[0], q[1], q[2], q[3]);
    pivot.quaternion.premultiply(t).normalize();
  };
  const angleOf = () => {
    const [a, b] = [...pts.values()];
    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  el.addEventListener("pointerdown", (e) => {
    el.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    twist = pts.size === 2 ? angleOf() : null;
  });
  el.addEventListener("pointermove", (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
    twist = pts.size === 2 ? angleOf() : null;
  };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

// ------------------------------------------------------------------ turn animation

interface Anim {
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

function enqueue(turn: Turn, forward: boolean) {
  queue.push({ turn, forward });
}

function startNext() {
  const job = queue.shift();
  if (!job) return;
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
  anim = { turn, forward, start: performance.now(), duration, group, axis, angle, after };
  render();
}

function finishAnim() {
  if (!anim) return;
  for (const child of [...anim.group.children]) pivot.attach(child);
  pivot.remove(anim.group);
  syncMeshes(anim.after);
  anim = null;
}

function tickAnimation() {
  if (!anim && queue.length) startNext();
  if (!anim) return;
  const t = anim.duration ? Math.min(1, (performance.now() - anim.start) / anim.duration) : 1;
  const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  anim.group.quaternion.setFromAxisAngle(anim.axis, anim.angle * e);
  if (t >= 1) finishAnim();
}

function flushAnimations() {
  queue.length = 0;
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

function renderNet(st: State) {
  const faces: [string, number, number][] = [
    ["U", 1, 0],
    ["L", 0, 1],
    ["F", 1, 1],
    ["R", 2, 1],
    ["B", 3, 1],
    ["D", 1, 2],
  ];
  const order = ["R", "L", "U", "D", "F", "B"];
  let html = "";
  for (const [name, col, row] of faces) {
    const g = faceView(st, order.indexOf(name));
    html += `<div class="netface" style="grid-column:${col + 1};grid-row:${row + 1}"><span class="netlabel" aria-hidden="true">${name}</span>`;
    for (const line of g)
      for (const ch of line) html += ch === "." ? `<i class="empty"></i>` : `<i style="background:${NET_COLOR[ch]}"></i>`;
    html += `</div>`;
  }
  $("net").innerHTML = html;
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
  $("last").addEventListener("click", () => playToEnd());
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
  $("speed").addEventListener("input", (e) => (speedMs = speedFromSlider(Number((e.target as HTMLInputElement).value))));
  bindMoveButtons();
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
