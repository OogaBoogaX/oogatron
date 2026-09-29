// Public API of the jumbotron module (interface frozen — see CLAUDE.md):
//
//   createJumbotron(gl, options)
//     options: { position, scale, palette, pixelDensity }
//     returns: update(statsJson), draw(viewProjMatrix, timeSeconds),
//              setView(name, params), nextView(), autoRotate(seconds),
//              dispose()
//
// createJumbotronDisplay(options) is the Canvas-2D-only core (no WebGL):
// the same board rendered into a plain canvas, used directly for the
// ?canvas2d=1 degradation path and internally by createJumbotron.
//
// The jumbotron never fetches: data is always pushed in via update().
// Zero dependencies, no build step.

import { parseStats } from "./data.js";
import { BOARD_H, BOARD_W, DEFAULT_PALETTE, VIEWS, drawText } from "./views.js";
import { createScreen } from "./screen.js";

/**
 * @typedef {{ name: string, params?: Record<string, unknown> }} ViewRef
 */

/**
 * Canvas-2D display core. Owns the board canvas, the current view, the
 * rotation cycle, and re-rendering.
 * @param {{ palette?: Partial<typeof DEFAULT_PALETTE>, pixelDensity?: number }} [options]
 */
export function createJumbotronDisplay(options = {}) {
  const palette = { ...DEFAULT_PALETTE, ...(options.palette ?? {}) };
  const pd = Math.max(1, options.pixelDensity ?? 1);
  const W = BOARD_W * pd;
  const H = BOARD_H * pd;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = /** @type {CanvasRenderingContext2D} */ (
    canvas.getContext("2d", { alpha: false })
  );
  ctx.imageSmoothingEnabled = false;
  if (pd !== 1) ctx.scale(pd, pd);

  /** @type {import("./data.js").StatsModel | null} */
  let model = null;
  /** @type {ViewRef} */
  let view = { name: "totals" };
  let cycleIndex = 0;
  let rotateEvery = 0;
  let lastSwitchAt = 0;
  let dirty = true;
  let animated = false;

  // Active-repo boards are capped so the cycle stays bounded as the org grows.
  const MAX_REPO_BOARDS = 6;
  const ACTIVE_WINDOW_MS = 7 * 24 * 3600 * 1000;

  /** Repos idle for a week disappear from the rotation entirely. */
  function activeRepos() {
    if (!model) return [];
    const ref = Date.parse(model.generatedAt) || Date.now();
    return model.repos
      .filter(
        (r) =>
          r.lastActivityAt &&
          ref - Date.parse(r.lastActivityAt) <= ACTIVE_WINDOW_MS,
      )
      .slice(0, MAX_REPO_BOARDS);
  }

  const BOARD_TYPES = ["commits", "prs", "reviews", "comments", "issues"];

  /** Rotation, rebuilt per model: recent feed, org totals and org
   * leaderboards, then each active repo's summary followed by its
   * leaderboards. */
  function cycle() {
    /** @type {ViewRef[]} */
    const c = [{ name: "recent" }, { name: "totals" }];
    for (const type of BOARD_TYPES) {
      c.push({ name: "leaderboard", params: { type } });
    }
    for (const repo of activeRepos()) {
      c.push({ name: "repo", params: { name: repo.name } });
      for (const type of BOARD_TYPES) {
        c.push({ name: "leaderboard", params: { type, repo: repo.name } });
      }
    }
    return c;
  }

  function renderBoard(t) {
    if (!model) {
      ctx.fillStyle = palette.screenBg;
      ctx.fillRect(0, 0, BOARD_W, BOARD_H);
      drawText(ctx, "OOGATRON", 62, 44, palette.accent, 2);
      drawText(ctx, "AWAITING DATA", 57, 60, palette.dim, 1);
      return false;
    }
    const render = VIEWS[view.name] ?? VIEWS.totals;
    return Boolean(
      render(ctx, BOARD_W, BOARD_H, model, view.params, palette, t),
    );
  }

  return {
    canvas,
    palette,

    /** Validates and swaps in a fresh stats payload. @param {unknown} statsJson */
    update(statsJson) {
      model = parseStats(statsJson);
      dirty = true;
    },

    /**
     * @param {string} name 'recent' | 'totals' | 'repo' | 'leaderboard'
     * @param {Record<string, unknown>} [params] e.g. {type} or {name}
     */
    setView(name, params) {
      if (!(name in VIEWS)) throw new Error(`unknown view: ${name}`);
      view = { name, params };
      dirty = true;
    },

    nextView() {
      const c = cycle();
      cycleIndex = (cycleIndex + 1) % c.length;
      view = c[cycleIndex];
      dirty = true;
    },

    /** @param {number} seconds 0 disables auto-rotation */
    autoRotate(seconds) {
      rotateEvery = seconds > 0 ? seconds : 0;
    },

    /** Current view (for UIs). */
    get view() {
      return view;
    },

    /**
     * Renders the board if needed. Returns true when the canvas changed
     * (i.e. a texture re-upload is warranted). @param {number} t seconds
     */
    render(t = 0) {
      if (rotateEvery > 0 && t - lastSwitchAt >= rotateEvery) {
        lastSwitchAt = t;
        this.nextView();
      }
      if (!dirty && !animated) return false;
      animated = renderBoard(t);
      dirty = false;
      return true;
    },

    dispose() {
      canvas.width = canvas.height = 0;
      model = null;
    },
  };
}

/**
 * The full WebGL jumbotron: display core + voxel screen mesh.
 * @param {WebGL2RenderingContext} gl
 * @param {{ position?: number[], scale?: number, aspect?: number,
 *           palette?: Partial<typeof DEFAULT_PALETTE>,
 *           pixelDensity?: number }} [options]
 */
export function createJumbotron(gl, options = {}) {
  const display = createJumbotronDisplay(options);
  const screen = createScreen(gl, {
    position: options.position,
    scale: options.scale,
    aspect: BOARD_W / BOARD_H,
    palette: display.palette,
  });

  return {
    /** @param {unknown} statsJson validated via data.js */
    update(statsJson) {
      display.update(statsJson);
    },

    /**
     * @param {Float32Array|number[]} viewProjMatrix column-major 4x4
     * @param {number} [timeSeconds]
     */
    draw(viewProjMatrix, timeSeconds = 0) {
      if (display.render(timeSeconds)) screen.upload(display.canvas);
      screen.draw(viewProjMatrix);
    },

    setView(name, params) {
      display.setView(name, params);
    },
    nextView() {
      display.nextView();
    },
    autoRotate(seconds) {
      display.autoRotate(seconds);
    },
    get view() {
      return display.view;
    },

    dispose() {
      screen.dispose();
      display.dispose();
    },
  };
}
