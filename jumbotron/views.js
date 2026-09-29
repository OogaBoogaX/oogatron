// Canvas renderers for the jumbotron views. Everything draws onto a small
// offscreen 2D canvas (the "LED board") that screen.js uploads as a
// NEAREST-filtered WebGL texture, so every logical pixel becomes a chunky
// voxel-style block. Text uses a built-in 5x7 bitmap font: deterministic on
// every platform (no system-font drift) and authentically blocky.
//
// Zero dependencies. Views never touch raw JSON — only the parsed StatsModel
// from data.js.

/** @typedef {import("./data.js").StatsModel} StatsModel */
/** @typedef {import("./data.js").Contributor} Contributor */

import { displayLabel } from "./data.js";

// Named palette tokens, in one place — values extracted from oogaboogaland's
// src/ (Phase 4) so the jumbotron reads as native to the island. Sources in
// oogaboogaland: style.css :root tokens (the HUD deliberately reuses in-world
// material colors), hub-models.js WOOD/PLANK/screen constants, qr.js darks,
// gl-renderer.js matrix green, race-hud.js gold.
export const DEFAULT_PALETTE = {
  screenBg: "#0a0c0a", // qr.js dark — near-black with a green cast
  grid: "#131912", // scanline tint over screenBg
  text: "#f3efe4", // --paper, the cave-sign pixel-text color
  dim: "#a6a6a2", // --muted
  accent: "#d8892b", // --accent (also the legendary tier color)
  commits: "#46ff70", // matrix green — the in-world screen glow
  prs: "#3fd1c5", // lab console screen teal
  reviews: "#6f9fca", // screen blue / rare tier
  comments: "#f5c542", // race-HUD player gold
  issues: "#e5533d", // --danger, the open-issue red
  danger: "#e5533d", // --danger
  bezel: "#8a6236", // WOOD
  bezelLight: "#a9773f", // PLANK
  bezelDark: "#5c4425", // WOOD_DK
  screenBezel: "#1d2326", // wall-screen bezel (hub-models SCREEN)
  standDark: "#4a3319", // wood end-grain / edge
  nail: "#3a2a18", // nails & iron
};

// Logical board resolution (multiplied by options.pixelDensity).
export const BOARD_W = 192;
export const BOARD_H = 108;

// ---------------------------------------------------------------------------
// 5x7 bitmap font (rows of 5 bits, top to bottom). Lowercase maps to upper.
// ---------------------------------------------------------------------------

/** @type {Record<string, number[]>} */
const FONT = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b11110, 0b10001, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
  E: [0b11111, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  0: [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  1: [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  2: [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  3: [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  4: [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  5: [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  6: [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  7: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  8: [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  9: [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  " ": [0, 0, 0, 0, 0, 0, 0],
  "-": [0, 0, 0, 0b01110, 0, 0, 0],
  _: [0, 0, 0, 0, 0, 0, 0b11111],
  ".": [0, 0, 0, 0, 0, 0b00110, 0b00110],
  ",": [0, 0, 0, 0, 0, 0b00100, 0b01000],
  ":": [0, 0b00110, 0b00110, 0, 0b00110, 0b00110, 0],
  "/": [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
  "+": [0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0],
  "*": [0, 0b10101, 0b01110, 0b11111, 0b01110, 0b10101, 0],
  "#": [0b01010, 0b11111, 0b01010, 0b01010, 0b01010, 0b11111, 0b01010],
  "%": [0b11001, 0b11010, 0b00010, 0b00100, 0b01000, 0b01011, 0b10011],
  "?": [0b01110, 0b10001, 0b00001, 0b00110, 0b00100, 0, 0b00100],
  "!": [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0, 0b00100],
  "'": [0b00100, 0b00100, 0, 0, 0, 0, 0],
  "(": [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ")": [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  "[": [0b01110, 0b01000, 0b01000, 0b01000, 0b01000, 0b01000, 0b01110],
  "]": [0b01110, 0b00010, 0b00010, 0b00010, 0b00010, 0b00010, 0b01110],
  "=": [0, 0, 0b11111, 0, 0b11111, 0, 0],
  ">": [0b10000, 0b01000, 0b00100, 0b00010, 0b00100, 0b01000, 0b10000],
  "<": [0b00001, 0b00010, 0b00100, 0b01000, 0b00100, 0b00010, 0b00001],
};
const FALLBACK_GLYPH = [
  0b11111, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11111,
];

export const GLYPH_W = 5;
export const GLYPH_H = 7;
const TRACKING = 1; // pixels between glyphs

/** @param {string} ch @returns {number[]} */
export function glyphOf(ch) {
  const up = ch.toUpperCase();
  return FONT[up] ?? FALLBACK_GLYPH;
}

/**
 * Pixel width of a string at a given scale (no trailing tracking).
 * @param {string} text @param {number} [scale]
 */
export function measureText(text, scale = 1) {
  if (text.length === 0) return 0;
  return (text.length * (GLYPH_W + TRACKING) - TRACKING) * scale;
}

/**
 * Draws bitmap text. `ctx` only needs fillRect + fillStyle, which is what
 * lets renderer tests run against a recording stub instead of a real canvas.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x @param {number} y
 * @param {string} color
 * @param {number} [scale]
 */
export function drawText(ctx, text, x, y, color, scale = 1) {
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of text) {
    const rows = glyphOf(ch);
    for (let r = 0; r < GLYPH_H; r++) {
      const bits = rows[r];
      for (let c = 0; c < GLYPH_W; c++) {
        if (bits & (1 << (GLYPH_W - 1 - c))) {
          ctx.fillRect(cx + c * scale, y + r * scale, scale, scale);
        }
      }
    }
    cx += (GLYPH_W + TRACKING) * scale;
  }
}

/** Truncates text to fit maxWidth pixels at scale, adding no ellipsis (LED style). */
export function fitText(text, maxWidth, scale = 1) {
  const perChar = (GLYPH_W + TRACKING) * scale;
  const maxChars = Math.max(
    0,
    Math.floor((maxWidth + TRACKING * scale) / perChar),
  );
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

function clearBoard(ctx, W, H, palette) {
  ctx.fillStyle = palette.screenBg;
  ctx.fillRect(0, 0, W, H);
  // faint scanline grid for the LED feel
  ctx.fillStyle = palette.grid;
  for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
}

function header(ctx, W, palette, title, right) {
  // Repo names can outrun the board (25 glyphs > 192px with a week label),
  // so every header title truncates to the space the right label leaves.
  const roomForTitle = W - 6 - (right ? measureText(right, 1) + 4 : 0);
  drawText(ctx, fitText(title, roomForTitle, 1), 3, 3, palette.accent, 1);
  if (right) {
    drawText(ctx, right, W - 3 - measureText(right, 1), 3, palette.dim, 1);
  }
  ctx.fillStyle = palette.dim;
  ctx.fillRect(0, 12, W, 1);
}

const TYPE_COLOR = {
  commits: "commits",
  prs: "prs",
  reviews: "reviews",
  comments: "comments",
  issues: "issues",
  commit: "commits",
  pr: "prs",
  review: "reviews",
  merge: "accent",
  issue: "issues",
  comment: "comments",
};

// ---------------------------------------------------------------------------
// Views. Each renders the full board; signature:
//   render(ctx, W, H, model, params, palette, t) -> dirtyNextFrame (boolean)
// ---------------------------------------------------------------------------

/** @type {Record<string, Function>} */
export const VIEWS = {
  recent: renderRecent,
  totals: renderTotals,
  repo: renderRepo,
  leaderboard: renderLeaderboard,
};

/**
 * Shared body for the org-wide and per-repo totals boards: headline counts on
 * the left, a weekly activity sparkline on the right.
 */
function renderTotalsBoard(
  ctx,
  W,
  H,
  palette,
  title,
  right,
  totals,
  weeklyTotals,
) {
  clearBoard(ctx, W, H, palette);
  header(ctx, W, palette, title, right);

  const rows = [
    ["CONTRIBUTORS", totals.contributors, palette.accent],
    ["COMMITS", totals.commits, palette.commits],
    ["PRS", totals.prs, palette.prs],
    ["REVIEWS", totals.reviews, palette.reviews],
    ["ISSUES", totals.issues, palette.issues],
    ["COMMENTS", totals.comments, palette.comments],
  ];
  // Six rows: y=14 step 13 keeps the last scale-2 numeral inside the board.
  let y = 14;
  for (const [label, value, color] of rows) {
    drawText(ctx, String(label), 6, y + 3, palette.dim, 1);
    const v = String(value);
    drawText(ctx, v, W - 66 - measureText(v, 2), y, color, 2);
    y += 13;
  }

  // weekly activity sparkline, right side
  const spark = weeklyTotals.slice(-14);
  if (spark.length > 0) {
    const maxV = Math.max(...spark.map((w) => w.total), 1);
    const bw = 4;
    const bx = W - 6 - spark.length * bw;
    const baseY = H - 12;
    const maxH = 56;
    spark.forEach((w, i) => {
      const h = Math.max(1, Math.round((w.total / maxV) * maxH));
      ctx.fillStyle = i === spark.length - 1 ? palette.accent : palette.commits;
      ctx.fillRect(bx + i * bw, baseY - h, bw - 1, h);
    });
    const label = `${spark.length} WEEKS`;
    drawText(ctx, label, W - 6 - measureText(label), baseY + 3, palette.dim, 1);
  }
  return false;
}

/** Org-wide totals — the Live Wire board. */
export function renderTotals(ctx, W, H, model, _params, palette) {
  const title = `${(model.org || "OOGABOOGAX").toUpperCase()} TOTALS`;
  return renderTotalsBoard(
    ctx,
    W,
    H,
    palette,
    title,
    model.latestWeek ?? "",
    model.totals,
    model.weeklyTotals,
  );
}

/** One repo's totals; params: { name }. */
export function renderRepo(ctx, W, H, model, params, palette) {
  const repo =
    model.repos.find((r) => r.name === params?.name) ?? model.repos[0];
  if (!repo) {
    clearBoard(ctx, W, H, palette);
    drawText(ctx, "NO REPOS", 58, 48, palette.dim, 1);
    return false;
  }
  return renderTotalsBoard(
    ctx,
    W,
    H,
    palette,
    repo.name.toUpperCase(),
    model.latestWeek ?? "",
    repo.totals,
    repo.weeklyTotals,
  );
}

export function renderLeaderboard(ctx, W, H, model, params, palette) {
  const type = params?.type ?? "commits";
  // Leaderboards are per repo now; without a repo param the org boards show.
  const repo = params?.repo
    ? model.repos.find((r) => r.name === params.repo)
    : null;
  const board = (repo ? repo.leaderboards : model.leaderboards)[type] ?? [];
  const color = palette[TYPE_COLOR[type] ?? "accent"];
  clearBoard(ctx, W, H, palette);
  const title = `${repo ? repo.name.toUpperCase() + " " : ""}TOP ${type.toUpperCase()}`;
  header(ctx, W, palette, title, model.latestWeek ?? "");

  const top = board.slice(0, 7);
  const maxV = Math.max(...top.map((e) => e.count), 1);
  let y = 16;
  top.forEach((e, i) => {
    const c = model.byLogin.get(e.login);
    const label = fitText((c ? displayLabel(c) : e.login).toUpperCase(), 66, 1);
    drawText(
      ctx,
      String(i + 1),
      4,
      y,
      i === 0 ? palette.accent : palette.dim,
      1,
    );
    drawText(ctx, label, 14, y, palette.text, 1);
    const barX = 84;
    const barMax = W - barX - 30;
    const bw = Math.max(1, Math.round((e.count / maxV) * barMax));
    ctx.fillStyle = color;
    ctx.fillRect(barX, y + 1, bw, 5);
    const v = String(e.count);
    drawText(ctx, v, W - 4 - measureText(v, 1), y, color, 1);
    y += 13;
  });
  return false;
}

/** Short relative age for the recent feed; renders against wall-clock now. */
export function recentAge(iso, nowMs = Date.now()) {
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "NOW";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}M`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}H`;
  return `${Math.floor(hours / 24)}D`;
}

/** The opening board: who did what where, newest first. */
export function renderRecent(ctx, W, H, model, _params, palette) {
  clearBoard(ctx, W, H, palette);
  header(ctx, W, palette, "RECENT", model.latestWeek ?? "");
  if (model.recent.length === 0) {
    drawText(ctx, "NO ACTIVITY", 52, 48, palette.dim, 1);
    return false;
  }
  let y = 15;
  for (const e of model.recent.slice(0, 11)) {
    // A draft PR reads muted: it is announced, not landed.
    const draft = e.type === "pr" && e.draft;
    const color = draft ? palette.dim : palette[TYPE_COLOR[e.type] ?? "accent"];
    const label = draft ? "DRAFT PR" : e.type.toUpperCase();
    drawText(ctx, fitText(e.login.toUpperCase(), 60, 1), 4, y, palette.text, 1);
    drawText(ctx, fitText(e.repo.toUpperCase(), 54, 1), 68, y, palette.dim, 1);
    drawText(ctx, fitText(label, 42, 1), 126, y, color, 1);
    const age = recentAge(e.occurredAt);
    drawText(ctx, age, W - 4 - measureText(age, 1), y, palette.dim, 1);
    y += 8;
  }
  return false;
}
