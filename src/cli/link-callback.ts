/**
 * The loopback listener `kairoku setup --daemon --link` binds to receive the
 * daemon token from the app's `/link` page (Q12; DECISIONS §36.1, §43.3,
 * §43.9; `planning/link-callback-contract.md`).
 *
 * The shape, and the reason for each half of it:
 *
 *   BIND, THEN BROWSE. `listenForLink` is bound before the URL it returns can
 *   be handed to a browser, so a user is never sent to a page whose callback
 *   cannot be received. A bind that fails throws here, with nothing opened.
 *
 *   127.0.0.1 ONLY, on an OS-chosen port. A credential acceptor on 0.0.0.0 is
 *   a token acceptor for everyone on the LAN.
 *
 *   THE NONCE IS OURS. We mint it, we put it in the URL, the page echoes it
 *   back, and it is compared in constant time and spent exactly once. The app
 *   remembers nothing about it (contract §4.3).
 *
 *   PERSIST BEFORE THE 204. A 204 the CLI cannot honour is worse than a 400:
 *   the page reports success, forgets the plaintext, and the token is gone.
 *   So `persist` is awaited, and a write that refuses is a 400 that leaves the
 *   single use unspent for the page's retry.
 *
 *   NOTHING LEAKS. Every response is empty — 204 or 400 — and this module
 *   prints nothing at all. The token exists in one place, the 0600 file.
 *
 * CORS is answered HERE and not by the app: the browser enforces the headers
 * against `http://127.0.0.1:<port>`, and the responder is this listener
 * (contract §3). The allowed origin is the app URL this CLI was given, never
 * `*` — `*` would let any page on the internet POST a token to a machine that
 * happens to be linking.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { kairokuHome, parseEnvFile } from "../daemon/config";
import type { Io } from "./io";
import type { Step } from "./provision";

/** §43.3/§43.9 — `kairokud` reads this key; the Bun daemon's own key stays. */
export const LINK_TOKEN_KEY = "KAIROKUD_LINK_TOKEN";
export const CALLBACK_PATH = "/callback";
/** Q12 — ten minutes, then the CLI gives up and says what to do next. */
export const LINK_WINDOW_MS = 600_000;
/** Short on purpose: the preflight is answered once, by a listener that dies. */
export const CORS_MAX_AGE_SECONDS = 600;

/**
 * What a token value may be: ONE line of printable, non-space ASCII.
 *
 * The token is a field of an HTTP body from a page this process does not
 * control, and its destination is a file of `KEY=value` lines. A value holding
 * a newline is therefore a second line, and the second line it would choose is
 * `KAIROKU_DAEMON_TOKEN=…` — the app credential §43.9 says this lane leaves
 * alone. So the shape is checked where the value crosses the trust boundary,
 * before it can reach a writer, and again in the writer itself.
 */
const ONE_LINE = /^[\x21-\x7e]+$/;

export type LinkOutcome = { ok: true; daemonName?: string } | { ok: false; reason: string };

export type LinkListener = {
  readonly port: number;
  /** Where the page POSTs: `http://127.0.0.1:<port>/callback`. */
  readonly callbackUrl: string;
  /** The app page to open — the callback and the nonce, never a token. */
  readonly linkUrl: string;
  readonly outcome: Promise<LinkOutcome>;
  close(): void;
};

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function listenForLink(opts: {
  appUrl: string;
  /** Must have RETURNED before the page is told 204. Throwing means 400. */
  persist: (token: string) => void | Promise<void>;
  timeoutMs?: number;
}): LinkListener {
  // Before the bind: an app URL that is not a URL has no origin to allow, and
  // failing here leaves nothing listening and nothing opened.
  const origin = new URL(opts.appUrl).origin;
  const nonce = randomBytes(16).toString("hex");

  const cors: Record<string, string> = {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": String(CORS_MAX_AGE_SECONDS),
  };
  // Every response is empty: a body is one more place a token could appear.
  const bad = () => new Response(null, { status: 400, headers: cors });

  let settle: (outcome: LinkOutcome) => void = () => {};
  const outcome = new Promise<LinkOutcome>((resolve) => {
    settle = resolve;
  });
  // "open" is the one state that accepts: a request in flight and a spent
  // nonce both refuse, so a replay cannot race the write it replays.
  let state: "open" | "writing" | "spent" = "open";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (req.method !== "POST" || url.pathname !== CALLBACK_PATH) return bad();
      if (state !== "open") return bad();

      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return bad();
      }
      const token = body?.token;
      const given = body?.nonce;
      // An empty, multi-line or space-padded token is one of the empty 400s
      // above: never written, never logged, never echoed.
      if (typeof token !== "string" || !ONE_LINE.test(token) || typeof given !== "string") return bad();
      if (!equal(given, nonce)) return bad();

      state = "writing";
      try {
        await opts.persist(token);
      } catch {
        // The use is NOT spent: the page's retry is the only way back from a
        // write we refused, and it needs this nonce to still be live.
        state = "open";
        return bad();
      }
      state = "spent";
      const daemonName = body.daemonName;
      settle({ ok: true, ...(typeof daemonName === "string" ? { daemonName } : {}) });
      return new Response(null, { status: 204, headers: cors });
    },
  });

  const port = server.port!;
  const callbackUrl = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const link = new URL("/link", opts.appUrl);
  link.searchParams.set("callback", callbackUrl);
  link.searchParams.set("nonce", nonce);

  const windowMs = opts.timeoutMs ?? LINK_WINDOW_MS;
  const timer = setTimeout(
    () => settle({ ok: false, reason: `no response from the browser in ${Math.round(windowMs / 60_000)} minutes` }),
    windowMs,
  );

  // Item 6 — closed on EVERY path: the 204, the refusal the caller gives up
  // on, the ten minutes, the error. `stop()` is the graceful form on purpose:
  // the accepted POST's own 204 is still being written when this runs, and
  // force-closing it would turn the one success into a network error.
  void outcome.then(() => {
    clearTimeout(timer);
    void server.stop();
  });

  return {
    port,
    callbackUrl,
    linkUrl: link.toString(),
    outcome,
    close: () => settle({ ok: false, reason: "the link was closed" }),
  };
}

/**
 * The ONE writer of `~/.kairoku/token.env`, for both of the keys §43.9 says
 * live there until phase 7: `KAIROKU_DAEMON_TOKEN` (the Bun daemon's, written
 * by `writeAppLink`) and `KAIROKUD_LINK_TOKEN` (kairokud's, written here).
 * Every other line is carried over untouched — adding a key must never remove
 * one, which is exactly what a whole-file overwrite does.
 *
 * Card 24's corrupt-file write refusal: a `token.env` that cannot be read, or
 * that holds a line which is not `KEY=value`, is LEFT AS IT IS rather than
 * replaced, because a credential whose only copy is that file would be gone.
 *
 * The write itself is a temp file renamed over the target, so a crash mid-write
 * leaves either the old file or the new one and never half of either.
 */
export function setTokenEnv(io: Io, key: string, value: string): void {
  const path = join(kairokuHome(io.home), "token.env");
  const existing = io.exists(path) ? io.readFile(path) : "";
  if (existing === null) {
    throw new Error(`refusing to write ${path}: it exists and cannot be read — left as it is`);
  }
  // Defence in depth behind the boundary check: whatever a caller hands over,
  // one key can never become two lines here.
  if (!ONE_LINE.test(value)) {
    throw new Error(`refusing to write ${path}: the value for ${key} is not one line — left as it is`);
  }
  const lines = existing.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) {
      throw new Error(
        `refusing to write ${path}: line ${index + 1} is not KEY=value — left as it is, so nothing already in it is lost`,
      );
    }
  }

  // Replaced in place when it is already there (item 7 — a repeated setup),
  // appended when it is not; every other line is carried over untouched.
  let found = false;
  const replaced = lines.map((line) => {
    if (parseEnvFile(line)[key] === undefined) return line;
    found = true;
    return `${key}=${value}`;
  });
  const body = replaced.join("\n").replace(/\n+$/, "");
  const next = (found ? body : body ? `${body}\n${key}=${value}` : `${key}=${value}`) + "\n";

  const temp = `${path}.tmp`;
  io.writeFile(temp, next, 0o600);
  io.rename(temp, path);
}

/** `open` on macOS, `xdg-open` elsewhere; absent is normal on a headless box. */
async function openLink(io: Io, url: string): Promise<void> {
  const opener = io.platform === "darwin" ? "open" : "xdg-open";
  if (io.which(opener)) await io.shell([opener, url]);
}

/**
 * The whole step: bind, print and open the URL, wait out the window, and hand
 * back a Step for `setup` to show. The listener is closed on every path.
 */
export async function linkDaemon(io: Io, appUrl: string, opts: { timeoutMs?: number } = {}): Promise<Step> {
  const name = "daemon link";
  let listener: LinkListener;
  try {
    listener = listenForLink({
      appUrl,
      persist: (token) => setTokenEnv(io, LINK_TOKEN_KEY, token),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
  } catch (e) {
    // Nothing is listening, so nothing is opened: a browser sent to a page
    // whose callback cannot be received is worse than this message.
    return { name, outcome: "manual", detail: `could not open a callback listener — ${(e as Error).message}` };
  }

  try {
    io.out(`   … waiting for ${listener.linkUrl}`);
    await openLink(io, listener.linkUrl);
    const outcome = await listener.outcome;
    if (!outcome.ok) {
      return {
        name,
        outcome: "manual",
        detail: `${outcome.reason} — sign in at the URL above, then rerun: kairoku setup --daemon --link`,
      };
    }
    return {
      name,
      outcome: "done",
      detail: `linked${outcome.daemonName ? ` as ${outcome.daemonName}` : ""} — ${LINK_TOKEN_KEY} written to ~/.kairoku/token.env`,
    };
  } finally {
    listener.close();
  }
}
