// Hand-rolled, dependency-free structural validator for the stats payloads.
// Dispatches on meta.schema_version: 2 is the pre-comments contract served on
// /v1/stats; 3 (served on /v2/stats) adds comments, merges folded into
// commits, per-repo leaderboards, last_activity_at, and the recent feed.
// Shared by the worker's contract test, snapshot.mjs, and the jumbotron's
// data.js. Unknown extra fields are tolerated — the contract allows additive
// changes within a schema_version.

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_WEEK = /^\d{4}-W\d{2}$/;
const RECENT_TYPES = new Set([
  "commit",
  "pr",
  "review",
  "merge",
  "issue",
  "comment",
]);

/**
 * @param {unknown} json
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateStats(json) {
  /** @type {string[]} */
  const errors = [];
  const fail = (/** @type {string} */ msg) => {
    errors.push(msg);
  };

  if (typeof json !== "object" || json === null) {
    return { ok: false, errors: ["payload is not an object"] };
  }
  const root = /** @type {Record<string, any>} */ (json);

  const meta = root.meta;
  if (typeof meta !== "object" || meta === null) {
    return { ok: false, errors: ["meta missing"] };
  }
  const version = meta.schema_version;
  if (version !== 2 && version !== 3) {
    return { ok: false, errors: [`unsupported schema_version: ${version}`] };
  }
  if (typeof meta.org !== "string") fail("meta.org not a string");
  if (
    typeof meta.generated_at !== "string" ||
    !ISO_DATE.test(meta.generated_at)
  )
    fail("meta.generated_at not ISO-8601");

  const countKeys =
    version === 3
      ? ["commits", "prs", "reviews", "issues", "comments"]
      : ["commits", "prs", "reviews"];
  const boardKeys =
    version === 3
      ? ["commits", "prs", "reviews", "comments", "issues"]
      : ["commits", "prs", "reviews"];

  const checkTotals = (/** @type {any} */ totals, /** @type {string} */ at) => {
    if (typeof totals !== "object" || totals === null) {
      fail(`${at} missing`);
      return;
    }
    for (const k of ["contributors", ...countKeys]) {
      if (!Number.isInteger(totals[k])) fail(`${at}.${k} not an integer`);
    }
  };
  const checkWeekly = (/** @type {any} */ weekly, /** @type {string} */ at) => {
    if (!Array.isArray(weekly)) {
      fail(`${at} not an array`);
      return;
    }
    weekly.forEach((/** @type {any} */ w, /** @type {number} */ j) => {
      if (typeof w?.week !== "string" || !ISO_WEEK.test(w.week))
        fail(`${at}[${j}].week not YYYY-Www`);
      for (const k of countKeys) {
        if (!Number.isInteger(w?.[k])) fail(`${at}[${j}].${k} not an integer`);
      }
    });
  };
  const checkBoards = (/** @type {any} */ lb, /** @type {string} */ at) => {
    if (typeof lb !== "object" || lb === null) {
      fail(`${at} missing`);
      return;
    }
    for (const k of boardKeys) {
      if (!Array.isArray(lb[k])) {
        fail(`${at}.${k} not an array`);
        continue;
      }
      lb[k].forEach((/** @type {any} */ e, /** @type {number} */ i) => {
        if (typeof e?.login !== "string")
          fail(`${at}.${k}[${i}].login not a string`);
        if (!Number.isInteger(e?.count))
          fail(`${at}.${k}[${i}].count not an integer`);
      });
    }
  };

  checkTotals(root.totals, "totals");
  checkBoards(root.leaderboards, "leaderboards");

  if (!Array.isArray(root.repos)) fail("repos not an array");
  else {
    root.repos.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
      const at = `repos[${i}]`;
      if (typeof r?.name !== "string" || r.name.length === 0)
        fail(`${at}.name not a non-empty string`);
      checkTotals(r?.totals, `${at}.totals`);
      checkWeekly(r?.weekly, `${at}.weekly`);
      if (version === 3) {
        if (
          r?.last_activity_at !== null &&
          (typeof r?.last_activity_at !== "string" ||
            !ISO_DATE.test(r.last_activity_at))
        )
          fail(`${at}.last_activity_at not ISO-8601|null`);
        checkBoards(r?.leaderboards, `${at}.leaderboards`);
        if (!Array.isArray(r?.contributors))
          fail(`${at}.contributors not an array`);
        else
          r.contributors.forEach(
            (/** @type {any} */ c, /** @type {number} */ j) => {
              if (typeof c?.login !== "string")
                fail(`${at}.contributors[${j}].login not a string`);
              if (
                typeof c?.last_seen_at !== "string" ||
                !ISO_DATE.test(c.last_seen_at)
              )
                fail(`${at}.contributors[${j}].last_seen_at not ISO-8601`);
            },
          );
      }
    });
  }

  if (version === 3) {
    if (!Array.isArray(root.recent)) fail("recent not an array");
    else {
      root.recent.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
        const at = `recent[${i}]`;
        if (typeof e?.login !== "string") fail(`${at}.login not a string`);
        if (typeof e?.repo !== "string") fail(`${at}.repo not a string`);
        if (!RECENT_TYPES.has(e?.type)) fail(`${at}.type unknown: ${e?.type}`);
        if (typeof e?.occurred_at !== "string" || !ISO_DATE.test(e.occurred_at))
          fail(`${at}.occurred_at not ISO-8601`);
        // Optional: pr rows may carry draft (the ticker's DRAFT PR tag).
        if (e?.draft !== undefined && typeof e.draft !== "boolean")
          fail(`${at}.draft not a boolean`);
      });
    }
  }

  if (!Array.isArray(root.contributors)) fail("contributors not an array");
  else {
    root.contributors.forEach(
      (/** @type {any} */ c, /** @type {number} */ i) => {
        const at = `contributors[${i}]`;
        if (typeof c?.login !== "string") fail(`${at}.login not a string`);
        for (const k of [
          "display_name",
          "avatar_url",
          "first_seen_at",
          "last_seen_at",
        ]) {
          if (c?.[k] !== null && typeof c?.[k] !== "string")
            fail(`${at}.${k} not string|null`);
        }
        if (typeof c?.counts !== "object" || c.counts === null)
          fail(`${at}.counts missing`);
        else {
          for (const k of countKeys) {
            if (!Number.isInteger(c.counts[k]))
              fail(`${at}.counts.${k} not an integer`);
          }
        }
        checkWeekly(c?.weekly, `${at}.weekly`);
      },
    );
  }

  return { ok: errors.length === 0, errors };
}
