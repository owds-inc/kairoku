/**
 * The loopback link listener — Q12, DECISIONS §43.3 and §43.9, and the
 * contract note `planning/link-callback-contract.md` §3/§4.
 *
 * Two properties are worth more than the rest and both are asserted here from
 * the outside, over a real socket, rather than by reading the module:
 * NOTHING but the happy path answers anything but 400, and the token reaches
 * the disk BEFORE the 204 that tells the page it is safe to forget it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io as realIo } from "./io";
import {
  CALLBACK_PATH,
  LINK_TOKEN_KEY,
  LINK_WINDOW_MS,
  linkDaemon,
  listenForLink,
  setTokenEnv,
  type LinkListener,
} from "./link-callback";
import { fakeIo, type FakeIo } from "./testkit";

const APP = "https://app.test";
const TOKEN = "kai_a_minted_daemon_token";
const home = "/home/neil";
const tokenEnv = `${home}/.kairoku/token.env`;

let live: LinkListener[] = [];
afterEach(() => {
  for (const l of live) l.close();
  live = [];
});

function listener(over: { appUrl?: string; persist?: (t: string) => void | Promise<void>; timeoutMs?: number } = {}) {
  const written: string[] = [];
  const l = listenForLink({
    appUrl: over.appUrl ?? APP,
    persist: over.persist ?? ((t: string) => void written.push(t)),
    ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }),
  });
  live.push(l);
  return { l, written };
}

const nonceOf = (l: LinkListener) => new URL(l.linkUrl).searchParams.get("nonce")!;

function post(l: LinkListener, body: unknown, path = CALLBACK_PATH): Promise<Response> {
  return fetch(`http://127.0.0.1:${l.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const good = (l: LinkListener, over: Record<string, unknown> = {}) => ({
  token: TOKEN,
  nonce: nonceOf(l),
  daemonName: "neil-mbp",
  ...over,
});

describe("the loopback listener — where it binds and what it advertises", () => {
  test("an OS-chosen port on 127.0.0.1 only, and a link URL carrying that port and the nonce", async () => {
    const { l } = listener();
    expect(l.port).toBeGreaterThan(0);
    expect(l.callbackUrl).toBe(`http://127.0.0.1:${l.port}${CALLBACK_PATH}`);
    // A listener on 0.0.0.0 is a token-acceptor on the LAN (item 1).
    expect(l.callbackUrl).not.toContain("0.0.0.0");

    const url = new URL(l.linkUrl);
    expect(url.origin).toBe(APP);
    expect(url.pathname).toBe("/link");
    expect(url.searchParams.get("callback")).toBe(l.callbackUrl);
    expect(nonceOf(l)).toMatch(/^[0-9a-f]{32}$/);
    // §36.1 — the token never travels in a URL; this one is opened in a browser.
    expect(l.linkUrl).not.toContain(TOKEN);

    // Bound, not merely constructed: the socket answers before anyone browses.
    expect((await fetch(l.callbackUrl, { method: "OPTIONS", headers: { origin: APP } })).status).toBe(204);
  });

  test("two listeners get two nonces — the nonce is this run's, not a constant", () => {
    const a = listener();
    const b = listener();
    expect(nonceOf(a.l)).not.toBe(nonceOf(b.l));
  });

  test("an app URL that is not a URL fails before anything is bound", () => {
    expect(() => listenForLink({ appUrl: "not a url", persist: () => {} })).toThrow();
  });

  test("the window is ten minutes", () => {
    expect(LINK_WINDOW_MS).toBe(600_000);
  });
});

describe("the preflight (contract §3) — the exact app origin, never *", () => {
  test("OPTIONS /callback answers 204 with the app's origin, POST, content-type and a max-age", async () => {
    const { l } = listener();
    const res = await fetch(l.callbackUrl, { method: "OPTIONS", headers: { origin: APP } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("POST");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(Number(res.headers.get("access-control-max-age"))).toBeGreaterThan(0);
    // The browser demanded nothing yet: PNA is not sent speculatively (item 4).
    expect(res.headers.get("access-control-allow-private-network")).toBeNull();
  });

  test("the origin follows the app URL the CLI was given, so a self-hosted app is not locked out", async () => {
    const { l } = listener({ appUrl: "http://localhost:3000" });
    const res = await fetch(l.callbackUrl, { method: "OPTIONS", headers: { origin: "http://localhost:3000" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  test("a 400 still carries the headers, or the page sees a network error instead of the refusal", async () => {
    const { l } = listener();
    const res = await post(l, good(l, { nonce: "0".repeat(32) }));
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
  });
});

describe("everything that is not the happy path is a 400, and none of them leak", () => {
  test("a wrong nonce is refused and does NOT spend the single use", async () => {
    const { l, written } = listener();
    const wrong = await post(l, good(l, { nonce: "f".repeat(32) }));
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toBe("");
    expect(written).toEqual([]);
    // The real page's retry still works: the nonce was not consumed by a miss.
    expect((await post(l, good(l))).status).toBe(204);
    expect(written).toEqual([TOKEN]);
  });

  test("a replay of the accepted body is 400 — the token is persisted exactly once", async () => {
    const { l, written } = listener();
    expect((await post(l, good(l))).status).toBe(204);
    const replay = await post(l, good(l));
    expect(replay.status).toBe(400);
    expect(await replay.text()).toBe("");
    expect(written).toEqual([TOKEN]);
  });

  test("the wrong method, the wrong path, malformed JSON and a missing field are each 400", async () => {
    const { l, written } = listener();
    const nonce = nonceOf(l);
    expect((await fetch(l.callbackUrl, { method: "GET", headers: { origin: APP } })).status).toBe(400);
    expect((await fetch(l.callbackUrl, { method: "PUT", headers: { origin: APP } })).status).toBe(400);
    expect((await post(l, good(l), "/")).status).toBe(400);
    expect((await post(l, good(l), "/callback/extra")).status).toBe(400);
    expect((await post(l, "{not json")).status).toBe(400);
    expect((await post(l, { nonce })).status).toBe(400);
    expect((await post(l, { token: TOKEN })).status).toBe(400);
    expect((await post(l, { token: "", nonce })).status).toBe(400);
    expect(written).toEqual([]);
    // Every refusal above left the one use unspent.
    expect((await post(l, good(l))).status).toBe(204);
  });

  test("no response body — success or refusal — carries the token", async () => {
    const { l } = listener();
    const bodies = [
      await (await post(l, good(l, { nonce: "a".repeat(32) }))).text(),
      await (await post(l, "{not json")).text(),
      await (await post(l, good(l))).text(),
      await (await post(l, good(l))).text(),
    ];
    for (const body of bodies) expect(body).not.toContain(TOKEN);
    expect(bodies.join("")).toBe("");
  });

  test("nothing the listener does reaches a log line", async () => {
    const said: string[] = [];
    const console_ = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = (...args: unknown[]) => void said.push(args.join(" "));
    try {
      const { l } = listener();
      await post(l, good(l, { nonce: "b".repeat(32) }));
      await post(l, good(l));
      await post(l, good(l));
    } finally {
      Object.assign(console, console_);
    }
    expect(said.join("\n")).not.toContain(TOKEN);
    expect(said).toEqual([]);
  });
});

describe("persist before the 204 (item 3) — a 204 the CLI cannot honour is worse than a 400", () => {
  test("the write has RETURNED by the time the page is told 204", async () => {
    const written: string[] = [];
    const { l } = listener({
      persist: async (t) => {
        await Bun.sleep(20);
        written.push(t);
      },
    });
    const res = await post(l, good(l));
    expect(res.status).toBe(204);
    // Read at the instant the page would show success.
    expect(written).toEqual([TOKEN]);
  });

  test("a write that refuses is a 400, and the single use survives for a retry", async () => {
    let fail = true;
    const written: string[] = [];
    const { l } = listener({
      persist: (t) => {
        if (fail) throw new Error("refusing to write ~/.kairoku/token.env");
        written.push(t);
      },
    });
    const refused = await post(l, good(l));
    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe("");
    expect(written).toEqual([]);

    fail = false;
    expect((await post(l, good(l))).status).toBe(204);
    expect(written).toEqual([TOKEN]);
  });

  test("the outcome carries the daemon name the page sent, and never the token", async () => {
    const { l } = listener();
    await post(l, good(l));
    const outcome = await l.outcome;
    expect(outcome.ok).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    if (outcome.ok) expect(outcome.daemonName).toBe("neil-mbp");
  });
});

describe("the window closes (item 6)", () => {
  test("a window that expires resolves as not-ok with a reason, and the socket is gone", async () => {
    const { l } = listener({ timeoutMs: 20 });
    const outcome = await l.outcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("no response");
    await expect(fetch(l.callbackUrl, { method: "OPTIONS" })).rejects.toThrow();
  });
});

describe("setTokenEnv — atomic, 0600, and refusing a file it cannot read (item 3)", () => {
  function io(): FakeIo {
    return fakeIo({ home });
  }

  test("the new key is added and the Bun daemon's own key is left exactly alone (§43.9)", () => {
    const fake = io();
    fake.files[tokenEnv] = "KAIROKU_DAEMON_TOKEN=kai_the_old_one\n";
    fake.modes[tokenEnv] = 0o600;
    setTokenEnv(fake, LINK_TOKEN_KEY, TOKEN);
    expect(fake.files[tokenEnv]).toBe(`KAIROKU_DAEMON_TOKEN=kai_the_old_one\n${LINK_TOKEN_KEY}=${TOKEN}\n`);
    expect(fake.modes[tokenEnv]).toBe(0o600);
  });

  test("a repeated setup REPLACES the link token in place, once (item 7)", () => {
    const fake = io();
    fake.files[tokenEnv] = `KAIROKU_DAEMON_TOKEN=kai_the_old_one\n${LINK_TOKEN_KEY}=kai_stale\nOTHER=keep\n`;
    setTokenEnv(fake, LINK_TOKEN_KEY, TOKEN);
    expect(fake.files[tokenEnv]).toBe(
      `KAIROKU_DAEMON_TOKEN=kai_the_old_one\n${LINK_TOKEN_KEY}=${TOKEN}\nOTHER=keep\n`,
    );
    expect(fake.files[tokenEnv]!.match(new RegExp(LINK_TOKEN_KEY, "g"))).toHaveLength(1);
  });

  test("an absent file is created with the one key", () => {
    const fake = io();
    setTokenEnv(fake, LINK_TOKEN_KEY, TOKEN);
    expect(fake.files[tokenEnv]).toBe(`${LINK_TOKEN_KEY}=${TOKEN}\n`);
    expect(fake.modes[tokenEnv]).toBe(0o600);
  });

  test("the write is atomic: the target is never opened, a temp file is renamed over it", () => {
    const fake = io();
    fake.files[tokenEnv] = "KAIROKU_DAEMON_TOKEN=kai_the_old_one\n";
    const opened: string[] = [];
    const inner = fake.writeFile;
    fake.writeFile = (path, data, mode) => {
      opened.push(path);
      inner(path, data, mode);
    };
    setTokenEnv(fake, LINK_TOKEN_KEY, TOKEN);
    expect(opened).toEqual([`${tokenEnv}.tmp`]);
    expect(fake.files[`${tokenEnv}.tmp`]).toBeUndefined();
    expect(fake.files[tokenEnv]).toContain(LINK_TOKEN_KEY);
  });

  test("a file that does not parse is REFUSED, and its bytes survive (card 24)", () => {
    const fake = io();
    const corrupt = "  this was never an env file\n";
    fake.files[tokenEnv] = corrupt;
    expect(() => setTokenEnv(fake, LINK_TOKEN_KEY, TOKEN)).toThrow(/refus/i);
    expect(fake.files[tokenEnv]).toBe(corrupt);
    expect(fake.files[`${tokenEnv}.tmp`]).toBeUndefined();
  });

  test("a file that exists and cannot be READ is refused too — an overwrite would destroy it", () => {
    const fake = io();
    fake.exists = (path) => path === tokenEnv || path in fake.files;
    fake.readFile = (path) => (path === tokenEnv ? null : (fake.files[path] ?? null));
    expect(() => setTokenEnv(fake, LINK_TOKEN_KEY, TOKEN)).toThrow(/refus/i);
    expect(fake.files[`${tokenEnv}.tmp`]).toBeUndefined();
  });

  test("the refusal names the file and never the token", () => {
    const fake = io();
    fake.files[tokenEnv] = "garbage\n";
    try {
      setTokenEnv(fake, LINK_TOKEN_KEY, TOKEN);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as Error).message).toContain("token.env");
      expect((e as Error).message).not.toContain(TOKEN);
    }
  });

  test("the app's own key goes through the same writer, and the link token survives it (§43.9)", () => {
    const fake = io();
    fake.files[tokenEnv] = `${LINK_TOKEN_KEY}=${TOKEN}\n`;
    setTokenEnv(fake, "KAIROKU_DAEMON_TOKEN", "kai_the_app_one");
    expect(fake.files[tokenEnv]).toBe(`${LINK_TOKEN_KEY}=${TOKEN}\nKAIROKU_DAEMON_TOKEN=kai_the_app_one\n`);
    expect(fake.modes[tokenEnv]).toBe(0o600);
  });

  test("on a real filesystem the file lands 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "kairoku-link-"));
    try {
      setTokenEnv({ ...realIo, home: dir }, LINK_TOKEN_KEY, TOKEN);
      const path = join(dir, ".kairoku", "token.env");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(Bun.file(path).text()).resolves.toContain(LINK_TOKEN_KEY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("linkDaemon — bind first, THEN open the browser (item 1)", () => {
  /** A fake browser: whatever `xdg-open` is handed, it preflights and POSTs. */
  function browser(fake: FakeIo, body: (link: URL) => unknown = (link) => ({ token: TOKEN, nonce: link.searchParams.get("nonce"), daemonName: "neil-mbp" })) {
    const seen: { preflight?: number; callback?: number } = {};
    fake.bins.add("xdg-open");
    fake.shell = async (argv) => {
      fake.calls.push(argv);
      if (argv[0] === "xdg-open") {
        const link = new URL(argv[1]!);
        const callback = link.searchParams.get("callback")!;
        seen.preflight = (await fetch(callback, { method: "OPTIONS", headers: { origin: APP } })).status;
        seen.callback = (
          await fetch(callback, {
            method: "POST",
            headers: { "content-type": "application/json", origin: APP },
            body: JSON.stringify(body(link)),
          })
        ).status;
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    return seen;
  }

  test("the page the browser is sent to can reach the callback the moment it opens", async () => {
    const fake = fakeIo({ platform: "linux", home });
    fake.files[tokenEnv] = "KAIROKU_DAEMON_TOKEN=kai_the_old_one\n";
    const seen = browser(fake);

    const step = await linkDaemon(fake, APP);
    // The listener was already bound when the browser was handed the URL:
    // both of the browser's requests were answered.
    expect(seen.preflight).toBe(204);
    expect(seen.callback).toBe(204);
    expect(step.outcome).toBe("done");
    expect(step.detail).toContain("neil-mbp");
    expect(fake.files[tokenEnv]).toBe(`KAIROKU_DAEMON_TOKEN=kai_the_old_one\n${LINK_TOKEN_KEY}=${TOKEN}\n`);
    expect(fake.modes[tokenEnv]).toBe(0o600);
  });

  test("the URL is printed for a machine with no browser, and it carries no token", async () => {
    const fake = fakeIo({ platform: "linux", home });
    browser(fake);
    await linkDaemon(fake, APP);
    const said = fake.lines.join("\n") + fake.errors.join("\n");
    expect(said).toContain("/link?");
    expect(said).not.toContain(TOKEN);
  });

  test("a listener that cannot be opened means the browser is never opened", async () => {
    const fake = fakeIo({ platform: "linux", home });
    browser(fake);
    const step = await linkDaemon(fake, "not a url");
    expect(step.outcome).toBe("manual");
    expect(fake.calls).toEqual([]);
  });

  test("a window that closes with no callback is a manual step naming what to do next", async () => {
    const fake = fakeIo({ platform: "linux", home });
    fake.bins.add("xdg-open");
    const step = await linkDaemon(fake, APP, { timeoutMs: 20 });
    expect(step.outcome).toBe("manual");
    expect(step.detail).toContain("kairoku setup --daemon --link");
    expect(fake.files[tokenEnv]).toBeUndefined();
  });

  test("a page that answers with the wrong nonce leaves nothing on disk", async () => {
    const fake = fakeIo({ platform: "linux", home });
    browser(fake, () => ({ token: TOKEN, nonce: "c".repeat(32) }));
    const step = await linkDaemon(fake, APP, { timeoutMs: 200 });
    expect(step.outcome).toBe("manual");
    expect(fake.files[tokenEnv]).toBeUndefined();
    expect((fake.lines.join("\n") + fake.errors.join("\n"))).not.toContain(TOKEN);
  });
});
