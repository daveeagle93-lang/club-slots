import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAccessAuth, parseAccessConfig } from "./access";
import { base64urlEncode, utf8 } from "./crypto";

const TEAM = "club.cloudflareaccess.com";
const AUD = "aud-tag-1234567890";
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const SEC = NOW / 1000;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

interface TestKey { kid: string; pair: CryptoKeyPair; jwk: JsonWebKey & { kid: string } }
async function newKey(kid: string): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey({ ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { kid, pair, jwk: Object.assign((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey, { kid }) };
}

const part = (o: unknown) => base64urlEncode(utf8(JSON.stringify(o)));
const goodClaims = (over: Record<string, unknown> = {}) => ({
  iss: `https://${TEAM}`, aud: [AUD], email: "Admin@Club.Example", exp: SEC + 600, iat: SEC - 10, ...over,
});
async function jwt(key: TestKey, claims: unknown = goodClaims(), header: Record<string, unknown> = {}): Promise<string> {
  const signingInput = `${part({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })}.${part(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign(RS256, key.pair.privateKey, utf8(signingInput)));
  return `${signingInput}.${base64urlEncode(sig)}`;
}

let k1: TestKey, k2: TestKey, other: TestKey;
beforeAll(async () => {
  [k1, k2] = [await newKey("kid-1"), await newKey("kid-2")];
  other = await newKey("kid-1"); // same kid, a different key
});

/** A provider whose key endpoint serves `keys()` and records how often it is hit. */
function setup(keys: () => TestKey[] = () => [k1], over: { now?: { t: number }; respond?: () => Response } = {}) {
  const clock = over.now ?? { t: NOW };
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    expect(String(url)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    return over.respond?.() ?? Response.json({ keys: keys().map((k) => k.jwk), public_cert: { kid: "x", cert: "x" }, public_certs: [] });
  });
  const auth = createAccessAuth({ teamDomain: TEAM, aud: AUD }, { fetch: fetchMock as unknown as typeof fetch, now: () => clock.t });
  return { auth, fetchMock, clock };
}
const req = (headers: Record<string, string>) => new Request("https://club.example/api/admin/session", { headers });
const withJwt = (token: string) => req({ "Cf-Access-Jwt-Assertion": token });

describe("parseAccessConfig", () => {
  it("accepts only a cloudflareaccess.com host and a non-empty AUD", () => {
    expect(parseAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD })).toEqual({ teamDomain: TEAM, aud: AUD });
    expect(parseAccessConfig({ ACCESS_TEAM_DOMAIN: "Club-1.CloudflareAccess.com", ACCESS_AUD: AUD })).not.toBeNull();
    for (const domain of [
      undefined, "", "evil.example", "club.cloudflareaccess.com.evil.example", "https://club.cloudflareaccess.com",
      "club.cloudflareaccess.com/x", "a.b.cloudflareaccess.com", "-club.cloudflareaccess.com", "cloudflareaccess.com",
      "club.cloudflareaccess.com:8443", "evil.example#.cloudflareaccess.com", "club@evil.example/.cloudflareaccess.com",
    ]) {
      expect(parseAccessConfig({ ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: AUD }), String(domain)).toBeNull();
    }
    expect(parseAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "" })).toBeNull();
    expect(parseAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM })).toBeNull();
  });
});

describe("Access JWT verification", () => {
  it("accepts a valid token: identity is the verified email, the binding is the JWT", async () => {
    const { auth } = setup();
    const token = await jwt(k1);
    expect(await auth.authenticate(withJwt(token))).toEqual({ identity: "Admin@Club.Example", csrfBinding: token });
    expect(auth.kind).toBe("access");
  });

  it("accepts aud as a plain string and trims the email", async () => {
    const { auth } = setup();
    const session = await auth.authenticate(withJwt(await jwt(k1, goodClaims({ aud: AUD, email: " a@b.example " }))));
    expect(session?.identity).toBe("a@b.example");
  });

  it("denies a signature from a different key presented under the real kid", async () => {
    const { auth } = setup();
    expect(await auth.authenticate(withJwt(await jwt(other)))).toBeNull();
  });

  it("denies a payload with the email swapped but the original signature", async () => {
    const { auth } = setup();
    const [h, , s] = (await jwt(k1)).split(".");
    expect(await auth.authenticate(withJwt(`${h}.${part(goodClaims({ email: "attacker@evil.example" }))}.${s}`))).toBeNull();
  });

  it("denies the wrong audience (string and array forms) and the wrong issuer", async () => {
    const { auth } = setup();
    for (const claims of [
      goodClaims({ aud: "other-app" }), goodClaims({ aud: ["other-app", "another"] }), goodClaims({ aud: [] }), goodClaims({ aud: undefined }),
      goodClaims({ aud: 5 }), goodClaims({ iss: "https://evil.cloudflareaccess.com" }), goodClaims({ iss: `https://${TEAM}/` }),
      goodClaims({ iss: TEAM }), goodClaims({ iss: undefined }),
    ]) {
      expect(await auth.authenticate(withJwt(await jwt(k1, claims))), JSON.stringify(claims)).toBeNull();
    }
    expect(await auth.authenticate(withJwt(await jwt(k1, goodClaims({ aud: ["other", AUD] }))))).not.toBeNull();
  });

  it("denies expired tokens, and a token expiring exactly now", async () => {
    const { auth } = setup();
    expect(await auth.authenticate(withJwt(await jwt(k1, goodClaims({ exp: SEC - 1 }))))).toBeNull();
    expect(await auth.authenticate(withJwt(await jwt(k1, goodClaims({ exp: SEC }))))).toBeNull();
    expect(await auth.authenticate(withJwt(await jwt(k1, goodClaims({ exp: SEC + 1 }))))).not.toBeNull();
    for (const exp of [undefined, "9999999999", null]) {
      expect(await auth.authenticate(withJwt(await jwt(k1, goodClaims({ exp })))), String(exp)).toBeNull();
    }
  });

  it("honours nbf with 30 s of leeway", async () => {
    const { auth } = setup();
    expect(await auth.authenticate(withJwt(await jwt(k1, goodClaims({ nbf: SEC + 3600 }))))).toBeNull();
    expect(await auth.authenticate(withJwt(await jwt(k1, goodClaims({ nbf: SEC + 31 }))))).toBeNull();
    expect(await auth.authenticate(withJwt(await jwt(k1, goodClaims({ nbf: SEC + 30 }))))).not.toBeNull();
    expect(await auth.authenticate(withJwt(await jwt(k1, goodClaims({ nbf: SEC + 5 }))))).not.toBeNull();
    expect(await auth.authenticate(withJwt(await jwt(k1, goodClaims({ nbf: "soon" }))))).toBeNull();
  });

  it("denies alg none with an empty signature", async () => {
    const { auth } = setup();
    const unsigned = `${part({ alg: "none", kid: k1.kid })}.${part(goodClaims())}.`;
    expect(await auth.authenticate(withJwt(unsigned))).toBeNull();
    expect(await auth.authenticate(withJwt(unsigned + "AAAA"))).toBeNull();
    expect(await auth.authenticate(withJwt(await jwt(k1, goodClaims(), { alg: "none" })))).toBeNull();
  });

  it("denies the HS256 confusion attack: HMAC keyed with the public key's bytes", async () => {
    const { auth } = setup();
    const signingInput = `${part({ alg: "HS256", kid: k1.kid })}.${part(goodClaims())}`;
    for (const secret of [JSON.stringify(k1.jwk), k1.jwk.n!]) {
      const hmac = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = base64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", hmac, utf8(signingInput))));
      expect(await auth.authenticate(withJwt(`${signingInput}.${sig}`))).toBeNull();
    }
    for (const alg of ["RS384", "rs256", "ES256", "", 5]) {
      expect(await auth.authenticate(withJwt(await jwt(k1, goodClaims(), { alg }))), String(alg)).toBeNull();
    }
  });

  it("denies a header that says RS256 over a garbage signature", async () => {
    const { auth } = setup();
    const [h, p] = (await jwt(k1)).split(".");
    expect(await auth.authenticate(withJwt(`${h}.${p}.${base64urlEncode(new Uint8Array(256))}`))).toBeNull();
    expect(await auth.authenticate(withJwt(`${h}.${p}.AAAA`))).toBeNull();
  });

  it("denies a token with no usable email, including service tokens", async () => {
    const { auth } = setup();
    for (const email of [undefined, 42, null, "", "  ", "no-at-sign", ["a@b.example"]]) {
      expect(await auth.authenticate(withJwt(await jwt(k1, goodClaims({ email })))), String(email)).toBeNull();
    }
    const { email: _email, ...serviceToken } = goodClaims({ common_name: "abc.access" });
    expect(await auth.authenticate(withJwt(await jwt(k1, serviceToken)))).toBeNull();
  });

  it("denies non-JSON, non-object and non-string-kid headers and payloads", async () => {
    const { auth } = setup();
    const signed = async (header: string, payload: string) => {
      const input = `${header}.${payload}`;
      return `${input}.${base64urlEncode(new Uint8Array(await crypto.subtle.sign(RS256, k1.pair.privateKey, utf8(input))))}`;
    };
    expect(await auth.authenticate(withJwt(await signed(base64urlEncode(utf8("nope")), part(goodClaims()))))).toBeNull();
    expect(await auth.authenticate(withJwt(await signed(part([1]), part(goodClaims()))))).toBeNull();
    expect(await auth.authenticate(withJwt(await signed(part({ alg: "RS256" }), part(goodClaims()))))).toBeNull();
    expect(await auth.authenticate(withJwt(await signed(part({ alg: "RS256", kid: 1 }), part(goodClaims()))))).toBeNull();
    expect(await auth.authenticate(withJwt(await signed(part({ alg: "RS256", kid: k1.kid }), base64urlEncode(utf8("nope")))))).toBeNull();
    expect(await auth.authenticate(withJwt(await signed(part({ alg: "RS256", kid: k1.kid }), part("str"))))).toBeNull();
  });

  it("denies malformed and oversized tokens without fetching keys", async () => {
    const { auth, fetchMock } = setup();
    const good = await jwt(k1);
    for (const token of ["", "a", "a.b", "a.b.c.d", "..", "a..c", "a.b.c!", good + "x.y", "x".repeat(9000), `${good}${"A".repeat(9000)}`]) {
      expect(await auth.authenticate(withJwt(token)), token.slice(0, 20)).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores the CF_Authorization cookie and the unsigned email header", async () => {
    const { auth, fetchMock } = setup();
    const token = await jwt(k1);
    expect(await auth.authenticate(req({ Cookie: `CF_Authorization=${token}` }))).toBeNull();
    expect(await auth.authenticate(req({ "Cf-Access-Authenticated-User-Email": "admin@club.example" }))).toBeNull();
    expect(await auth.authenticate(req({ "Cf-Access-Authenticated-User-Email": "admin@club.example", Cookie: `CF_Authorization=${token}` }))).toBeNull();
    expect(await auth.authenticate(req({}))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Access key set", () => {
  it("caches the key set for an hour, then fetches again", async () => {
    const { auth, fetchMock, clock } = setup();
    const token = await jwt(k1, goodClaims({ exp: SEC + 7200 }));
    await auth.authenticate(withJwt(token));
    await auth.authenticate(withJwt(token));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock.t += 3600_000 - 1;
    await auth.authenticate(withJwt(token));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock.t += 1;
    await auth.authenticate(withJwt(token));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refetches once for an unknown kid, then throttles to one forced refetch per 60 s", async () => {
    const { auth, fetchMock, clock } = setup();
    await auth.authenticate(withJwt(await jwt(k1)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const ghost = await newKey("ghost-1");
    expect(await auth.authenticate(withJwt(await jwt(ghost)))).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const ghost2 = await newKey("ghost-2");
    expect(await auth.authenticate(withJwt(await jwt(ghost2)))).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    clock.t += 59_000;
    await auth.authenticate(withJwt(await jwt(ghost2)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    clock.t += 1_000;
    await auth.authenticate(withJwt(await jwt(ghost2)));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not refetch for an unknown kid when it has only just fetched", async () => {
    const { auth, fetchMock } = setup();
    expect(await auth.authenticate(withJwt(await jwt(await newKey("ghost"))))).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a rotated-in key after one refetch", async () => {
    let published = [k1];
    const { auth, fetchMock } = setup(() => published);
    expect(await auth.authenticate(withJwt(await jwt(k1)))).not.toBeNull();
    published = [k1, k2];
    expect(await auth.authenticate(withJwt(await jwt(k2)))).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await auth.authenticate(withJwt(await jwt(k1)))).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("denies, and logs without token contents, when the key endpoint fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = await jwt(k1);
    try {
      for (const respond of [
        () => new Response("nope", { status: 500 }),
        () => new Response("not json", { status: 200 }),
        () => Response.json({ keys: "no" }),
        () => Response.json({}),
        () => Response.json({ keys: [{ kty: "EC", kid: "kid-1", crv: "P-256", x: "a", y: "b" }, { kty: "RSA", kid: "kid-1" }, null] }),
        () => new Response("x".repeat(200_000)),
        () => { throw new Error("network down"); },
      ]) {
        const { auth } = setup(() => [k1], { respond });
        expect(await auth.authenticate(withJwt(token))).toBeNull();
      }
      expect(error).toHaveBeenCalled();
      expect(JSON.stringify(error.mock.calls)).not.toContain(token.split(".")[1]);
    } finally {
      error.mockRestore();
    }
  });

  it("does not hammer a failing endpoint: no second fetch within 60 s", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { auth, fetchMock, clock } = setup(() => [k1], { respond: () => new Response("", { status: 503 }) });
      const token = await jwt(k1);
      await auth.authenticate(withJwt(token));
      await auth.authenticate(withJwt(token));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      clock.t += 60_000;
      await auth.authenticate(withJwt(token));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });

  it("shares one in-flight fetch between concurrent requests", async () => {
    const { auth, fetchMock } = setup();
    const token = await jwt(k1);
    const results = await Promise.all(Array.from({ length: 5 }, () => auth.authenticate(withJwt(token))));
    expect(results.every((r) => r !== null)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
