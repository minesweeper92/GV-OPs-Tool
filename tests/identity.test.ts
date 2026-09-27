import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID as uuid } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { openDatabase, migrate, bindEnvironment } from "../server/db.ts";
import { Access, hash } from "../server/access.ts";
import { IdentityProvider } from "../server/oidc.ts";
import { createApp } from "../server/app.ts";

// A local protocol fixture, not an alternate production sign-in mechanism.
test("OIDC authorization-code flow verifies identity before granting access", async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const db = await openDatabase("memory://");
  t.after(() => db.close());
  await migrate(db);
  await bindEnvironment(db, "oidc");
  const { privateKey, publicKey } = await generateKeyPair("RS256"),
    wrongKey = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "fixture-key",
    alg: "RS256",
    use: "sig",
  };
  const codes = new Map<string, URLSearchParams>();
  let overrides: Record<string, unknown> = {},
    badSignature = false,
    issuer = "";
  const server = createServer(async (req, res) => {
    try {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/.well-known/openid-configuration")
        return res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
      if (req.url === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
      if (req.url?.startsWith("/authorize?")) {
        const params = new URL(req.url, issuer).searchParams,
          code = uuid();
        codes.set(code, params);
        const callback = new URL(params.get("redirect_uri")!);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", params.get("state")!);
        res.statusCode = 302;
        res.setHeader("Location", callback.href);
        return res.end();
      }
      if (req.url === "/token") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const params = new URLSearchParams(body),
          code = params.get("code") || "",
          saved = codes.get(code);
        codes.delete(code);
        const challenge = createHash("sha256")
          .update(params.get("code_verifier") || "")
          .digest("base64url");
        if (
          !saved ||
          saved.get("code_challenge") !== challenge ||
          params.get("client_id") !== "fixture-client" ||
          params.get("client_secret") !== "fixture-secret" ||
          params.get("redirect_uri") !== saved.get("redirect_uri")
        ) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: "invalid_grant" }));
        }
        const now = Math.floor(Date.now() / 1000);
        const id_token = await new SignJWT({
          iss: issuer,
          aud: "fixture-client",
          sub: "owner-subject",
          email: "owner@example.test",
          email_verified: true,
          name: "Verified Owner",
          iat: now,
          exp: now + 300,
          nonce: saved.get("nonce"),
          ...overrides,
        })
          .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
          .sign(badSignature ? wrongKey.privateKey : privateKey);
        return res.end(
          JSON.stringify({
            id_token,
            access_token: "fixture-access-token",
            token_type: "Bearer",
            expires_in: 300,
          }),
        );
      }
      res.statusCode = 404;
      res.end("{}");
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  );
  const access = new Access(db, "oidc"),
    origin = "http://127.0.0.1:4320";
  await assert.rejects(
    () =>
      IdentityProvider.connect(access, {
        issuer,
        origin,
        clientId: "fixture-client",
        clientSecret: "fixture-secret",
      }),
    /HTTPS/,
  );
  const provider = await IdentityProvider.connect(access, {
    issuer,
    origin,
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    testTransport: true,
  });
  const app = createApp(db, origin, provider);
  await app.ready();
  t.after(() => app.close());
  const headers = { host: "127.0.0.1:4320", origin };
  async function pending() {
    const start = await provider.begin();
    const response = await fetch(start.url, { redirect: "manual" });
    return { ...start, callback: new URL(response.headers.get("location")!) };
  }
  await t.test(
    "browser-bound state, single use, expiration and PKCE",
    async () => {
      const p = await pending();
      await assert.rejects(
        () => provider.finish(p.callback, "another-browser"),
        /another browser/,
      );
      const person = await provider.finish(p.callback, p.browser);
      assert.equal(person.tenantId, null);
      await assert.rejects(
        () => provider.finish(p.callback, p.browser),
        /expired/,
      );
      const expired = await pending();
      await db.query(
        "UPDATE login_attempts SET expires_at=now()-interval '1 minute'",
      );
      await assert.rejects(
        () => provider.finish(expired.callback, expired.browser),
        /expired/,
      );
      const tampered = await pending();
      await db.query(
        "UPDATE login_attempts SET verifier=$2 WHERE state_hash=$1",
        [hash(tampered.callback.searchParams.get("state")!), "wrong-verifier"],
      );
      await assert.rejects(
        () => provider.finish(tampered.callback, tampered.browser),
        /could not be verified/,
      );
    },
  );
  await t.test(
    "rejects unverified email, incorrect nonce, issuer, audience, expiry and signature",
    async () => {
      for (const claims of [
        { email_verified: false },
        { nonce: "wrong" },
        { iss: "https://wrong.example.test" },
        { aud: "wrong-client" },
        { exp: 1 },
        { email: "not-an-email" },
      ]) {
        overrides = claims;
        const p = await pending();
        await assert.rejects(
          () => provider.finish(p.callback, p.browser),
          /could not be verified/,
        );
      }
      overrides = {};
      badSignature = true;
      const p = await pending();
      await assert.rejects(
        () => provider.finish(p.callback, p.browser),
        /could not be verified/,
      );
      badSignature = false;
    },
  );
  await t.test(
    "same email never silently links a different subject",
    async () => {
      overrides = { sub: "different-subject" };
      const p = await pending();
      await assert.rejects(
        () => provider.finish(p.callback, p.browser),
        /Automatic account linking/,
      );
      overrides = {};
    },
  );
  await t.test(
    "HTTP routes issue session, require onboarding, exclude sample login and rotate on switch",
    async () => {
      const begin = await app.inject({ url: "/auth/login", headers });
      assert.equal(begin.statusCode, 302);
      const browserCookie =
        begin.headers["set-cookie"]!.toString().split(";")[0];
      const authorized = await fetch(begin.headers.location!, {
        redirect: "manual",
      });
      const callback = new URL(authorized.headers.get("location")!);
      const signed = await app.inject({
        url: callback.pathname + callback.search,
        headers: { ...headers, cookie: browserCookie },
      });
      assert.equal(signed.statusCode, 302, signed.body);
      const cookies = [signed.headers["set-cookie"]].flat() as string[],
        cookie = cookies
          .find((c) => c.startsWith("gv_workspace_session="))!
          .split(";")[0];
      assert.ok(cookies.some((c) => c.includes("HttpOnly")));
      const me = (
        await app.inject({ url: "/api/me", headers: { ...headers, cookie } })
      ).json();
      assert.equal(me.onboarding, true);
      assert.equal(me.user.email, "owner@example.test");
      const authenticated = { ...headers, cookie, "x-csrf-token": me.csrf };
      assert.equal(
        (await app.inject({ url: "/api/data", headers: authenticated }))
          .statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            url: "/api/demo-accounts",
            headers: authenticated,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/demo-login",
            headers: authenticated,
            payload: {},
          })
        ).statusCode,
        404,
      );
      const created = await app.inject({
        method: "POST",
        url: "/api/organizations",
        headers: authenticated,
        payload: {
          name: "Fixture organization",
          entityName: "Fixture entity",
          entityCode: "FIX",
          requestKey: uuid(),
        },
      });
      assert.equal(created.statusCode, 200, created.body);
      const switched = await app.inject({
        method: "POST",
        url: "/api/organizations/switch",
        headers: authenticated,
        payload: { id: created.json().id },
      });
      assert.equal(switched.statusCode, 200, switched.body);
      assert.equal(
        (await app.inject({ url: "/api/me", headers: authenticated }))
          .statusCode,
        401,
      );
      const newCookie =
        switched.headers["set-cookie"]!.toString().split(";")[0];
      const data = await app.inject({
        url: "/api/data",
        headers: { ...headers, cookie: newCookie },
      });
      assert.equal(data.statusCode, 200, data.body);
      assert.equal(data.json().entities.length, 1);
      const raw = newCookie.split("=")[1];
      await assert.rejects(
        () => new Access(db, "sample").read(raw),
        /session ended/,
      );
      overrides = { email: "changed@example.test" };
      const p = await pending();
      await provider.finish(p.callback, p.browser);
      overrides = {};
      assert.equal(
        (
          await app.inject({
            url: "/api/me",
            headers: { ...headers, cookie: newCookie },
          })
        ).statusCode,
        401,
        "email change revokes old sessions",
      );
    },
  );
  await assert.rejects(() => bindEnvironment(db, "sample"), /separate/);
});
