// Zero-dependency Chrome DevTools Protocol driver (Node 24 has global WebSocket).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * An unused TCP port.
 *
 * Suites used to hardcode a debug port each. Any two overlapping runs — a suite
 * and an ad-hoc screenshot script, or two `test-tables.mjs` invocations — then
 * pointed at the same port, and `launch()` happily ATTACHED to the other run's
 * browser instead of starting its own. The symptom was a whole suite failing on
 * `waitFor` timeouts because it was driving somebody else's page, which reads
 * exactly like a product regression. An ephemeral port per launch removes the
 * class of failure.
 */
async function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/**
 * Delete Chromium profiles left by earlier runs.
 *
 * Cleaning up on exit is not enough on its own: a suite killed by a timeout —
 * or by the runner — never reaches its own teardown, and each abandoned profile
 * is tens of megabytes. A session of repeated runs left 217 of them totalling
 * 3.5 GB, which contributed to the box running out of memory and Chromium
 * evaluations timing out. Sweeping on the way IN is the only cleanup that
 * survives being killed.
 *
 * Only profiles older than the cutoff go, so a concurrent run is never touched.
 */
function sweepStaleProfiles(maxAgeMs = 60 * 60 * 1000) {
	const tmp = os.tmpdir();
	let entries = [];
	try {
		entries = fs.readdirSync(tmp).filter((n) => n.startsWith("cdp-"));
	} catch (e) {
		return;
	}
	const cutoff = Date.now() - maxAgeMs;
	for (const name of entries) {
		const full = path.join(tmp, name);
		try {
			if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
		} catch (e) {
			/* in use, or gone already */
		}
	}
}

export async function launch({ port, headless = true, userDataDir } = {}) {
  sweepStaleProfiles();
  port = port || (await freePort());
  const dir = userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), "cdp-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--disable-dev-shm-usage", "--no-sandbox",
    "--window-size=1600,1000",
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");
  const proc = spawn("chromium", args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr.on("data", () => {});
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) break;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  // Best-effort teardown for the normal path. `proc.kill()` is asynchronous, so
  // the profile is often still held when the suite's own process exits — hence
  // the sweep above, which is what actually keeps /tmp bounded.
  const cleanup = () => {
    try {
      if (!userDataDir) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      /* still in use; the next run's sweep will take it */
    }
  };
  proc.on("exit", cleanup);
  process.on("exit", cleanup);

  return { proc, port, dir };
}

export async function newPage(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const target = await r.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error(`timeout: ${method}`)); } }, 60000);
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Log.enable");

  const page = {
    send, events, targetId: target.id,
    async goto(url, { waitUntil = "load" } = {}) {
      await send("Page.navigate", { url });
      if (waitUntil === "none") return;
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const done = events.some((e) => e.method === "Page.loadEventFired");
        if (done) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      events.length = 0;
    },
    async eval(expr, { awaitPromise = true } = {}) {
      const r = await send("Runtime.evaluate", {
        expression: typeof expr === "function" ? `(${expr})()` : expr,
        returnByValue: true, awaitPromise,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
      }
      return r.result.value;
    },
    async waitFor(expr, { timeout = 30000, interval = 200 } = {}) {
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        try { last = await page.eval(expr); if (last) return last; } catch (e) { last = e.message; }
        await new Promise((r) => setTimeout(r, interval));
      }
      throw new Error(`waitFor timed out: ${String(expr).slice(0, 200)} (last: ${JSON.stringify(last)?.slice(0,300)})`);
    },
    /**
     * Move the real pointer. CSS `:hover` does not respond to synthetic
     * MouseEvents dispatched from page script, so row-hover styling can only be
     * tested through the input domain.
     */
    async hover(x, y) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(x),
        y: Math.round(y),
        buttons: 0,
      });
      await new Promise((r) => setTimeout(r, 120));
    },
    /** Press, move and release the real pointer — a genuine drag gesture. */
    async drag(x1, y1, x2, y2, steps = 6) {
      const send3 = (type, x, y, extra = {}) =>
        send("Input.dispatchMouseEvent", {
          type,
          x: Math.round(x),
          y: Math.round(y),
          button: "left",
          clickCount: 1,
          buttons: type === "mouseReleased" ? 0 : 1,
          ...extra,
        });
      await send3("mousePressed", x1, y1);
      for (let i = 1; i <= steps; i++) {
        await send3("mouseMoved", x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
        await new Promise((r) => setTimeout(r, 20));
      }
      await send3("mouseReleased", x2, y2);
      await new Promise((r) => setTimeout(r, 150));
    },
    async screenshot(file, { fullPage = false } = {}) {
      const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage });
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      return file;
    },
    /**
     * JavaScript errors only.
     *
     * `Log.entryAdded` also carries network entries — a 4xx from an unrelated
     * frappe endpoint (background count queries, telemetry) shows up as an
     * "error" and would make these suites flaky. What matters here is whether
     * the table code threw, so network noise is reported separately.
     */
    consoleErrors() {
      return events
        .filter(
          (e) =>
            e.method === "Log.entryAdded" &&
            e.params.entry.level === "error" &&
            e.params.entry.source !== "network"
        )
        .map((e) => `${e.params.entry.source}: ${e.params.entry.text}`);
    },
    networkErrors() {
      return events
        .filter(
          (e) =>
            e.method === "Log.entryAdded" &&
            e.params.entry.level === "error" &&
            e.params.entry.source === "network"
        )
        .map((e) => e.params.entry.text);
    },
    close: () => ws.close(),
  };
  return page;
}

/**
 * Fail loudly if the desk is not actually serving carbon_frappe's stylesheet.
 *
 * The theme is delivered by SHADOWING frappe's `desk.bundle.css` key in
 * sites/assets/assets.json. A running `bench watch` re-claims that key every
 * time it rebuilds frappe's own bundles, and the README is explicit that this
 * has "no symptom other than stock frappe styling reappearing — nothing
 * errors". For a CSS-sensitive test suite that is worse than a crash: every
 * layout assertion silently measures stock frappe instead of Carbon, and the
 * failures look like product bugs.
 */
export async function assertCarbonStylesheet(page) {
  const links = await page.eval(
    `[...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href)`
  );
  const desk = links.filter((h) => h.includes("desk.bundle") && h.endsWith(".css"));
  const carbon = desk.filter((h) => h.includes("/assets/carbon_frappe/"));
  if (!carbon.length) {
    throw new Error(
      "carbon_frappe's desk.bundle.css is NOT being served (assets.json shadow lost -- " +
        "usually a running `bench watch` re-claimed the key). " +
        "Fix with: node scripts/patch-assets.mjs   Loaded instead: " +
        (desk.join(", ") || "<none>")
    );
  }
  return carbon[0];
}

/**
 * Log into the desk and CONFIRM it worked.
 *
 * The previous version submitted the form, slept 3s and returned true. When the
 * bench was busy that returned before the session existed, and the suite then
 * failed on a page-load timeout several assertions later — which reads like a
 * product bug rather than "we were never logged in". Each suite also opens a
 * fresh browser profile, so a full run authenticates six times and the
 * `tabSessions` table grows accordingly; transient login failures are expected
 * and worth retrying rather than propagating.
 */
export async function login(page, base, user = "Administrator", pwd = "admin") {
  const deadline = Date.now() + 90000;
  let lastSeen = null;

  for (let attempt = 1; Date.now() < deadline; attempt++) {
    await page.goto(`${base}/login`);
    try {
      await page.waitFor(`!!document.querySelector('#login_email')`, { timeout: 20000 });
    } catch (e) {
      // already authenticated? fall through to the check below
    }

    try {
      await page.eval(`
        (() => {
          const email = document.querySelector('#login_email');
          const pass = document.querySelector('#login_password');
          if (!email || !pass) return false;
          email.value = ${JSON.stringify(user)};
          pass.value = ${JSON.stringify(pwd)};
          email.dispatchEvent(new Event('input', { bubbles: true }));
          pass.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('.btn-login').click();
          return true;
        })()
      `);
    } catch (e) {
      // Submitting navigates, and an evaluation in flight when that happens
      // rejects with an exception CDP reports as `undefined`. Nothing is wrong
      // — the click landed. Fall through to the confirmation poll.
    }

    const until = Date.now() + 20000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        lastSeen = await page.eval(
          `(async () => {
             const r = await fetch('/api/method/frappe.auth.get_logged_user');
             if (!r.ok) return null;
             return (await r.json()).message || null;
           })()`
        );
      } catch (e) {
        lastSeen = null;
      }
      if (lastSeen === user) return true;
    }
    console.error(`login attempt ${attempt} did not take (saw ${JSON.stringify(lastSeen)}), retrying`);
  }

  throw new Error(
    `could not log into ${base} as ${user} (last get_logged_user: ${JSON.stringify(lastSeen)})`
  );
}
