import * as client from "openid-client";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Access, hash, token } from "./access.ts";
import { Problem } from "./domain.ts";

export function equalSecret(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export class IdentityProvider {
  private constructor(
    readonly access: Access,
    readonly config: client.Configuration,
    readonly origin: string,
  ) {}
  static async connect(
    access: Access,
    b: {
      issuer: string;
      clientId: string;
      clientSecret: string;
      origin: string;
      testTransport?: boolean;
    },
  ) {
    const issuer = new URL(b.issuer),
      origin = new URL(b.origin);
    const localTest =
      b.testTransport === true &&
      process.env.NODE_ENV === "test" &&
      issuer.hostname === "127.0.0.1" &&
      origin.hostname === "127.0.0.1";
    if (
      (issuer.protocol !== "https:" || origin.protocol !== "https:") &&
      !localTest
    )
      throw new Error("OIDC requires HTTPS.");
    if (
      origin.origin !== b.origin ||
      issuer.username ||
      issuer.password ||
      issuer.hash ||
      issuer.search
    )
      throw new Error("Invalid identity configuration.");
    const config = await client.discovery(
      issuer,
      b.clientId,
      b.clientSecret,
      undefined,
      localTest ? { execute: [client.allowInsecureRequests] } : undefined,
    );
    const metadata = config.serverMetadata();
    for (const endpoint of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.jwks_uri,
    ]) {
      if (!endpoint || (!localTest && new URL(endpoint).protocol !== "https:"))
        throw new Error(
          "Identity provider endpoints must use HTTPS and include JWKS.",
        );
    }
    client.enableNonRepudiationChecks(config);
    return new IdentityProvider(access, config, b.origin);
  }
  async begin() {
    const state = token(),
      browser = token(),
      nonce = token(),
      verifier = client.randomPKCECodeVerifier();
    await this.access.db.transaction(async (tx) => {
      await tx.query("DELETE FROM login_attempts WHERE expires_at<now()");
      await tx.query(
        "INSERT INTO login_attempts(state_hash,browser_hash,verifier,nonce,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",
        [hash(state), hash(browser), verifier, nonce],
      );
    });
    const url = client.buildAuthorizationUrl(this.config, {
      redirect_uri: `${this.origin}/auth/callback`,
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    });
    return { url: url.href, browser };
  }
  async finish(url: URL, browser: string | undefined) {
    const state = url.searchParams.get("state");
    if (!state || state.length > 128 || !browser || browser.length > 128)
      throw new Problem(400, "Sign-in expired. Start again.");
    const attempt = await this.access.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          "SELECT * FROM login_attempts WHERE state_hash=$1 AND expires_at>now() FOR UPDATE",
          [hash(state)],
        )
      ).rows[0];
      if (!row || !equalSecret(row.browser_hash, hash(browser)))
        throw new Problem(
          400,
          "Sign-in expired or belongs to another browser. Start again.",
        );
      await tx.query("DELETE FROM login_attempts WHERE state_hash=$1", [
        hash(state),
      ]);
      return row;
    });
    let claims;
    try {
      const result = await client.authorizationCodeGrant(this.config, url, {
        pkceCodeVerifier: attempt.verifier,
        expectedState: state,
        expectedNonce: attempt.nonce,
        idTokenExpected: true,
      });
      claims = z
        .object({
          sub: z.string().min(1).max(255),
          email: z.email().max(254),
          email_verified: z.literal(true),
          name: z.string().min(1).max(200).optional(),
        })
        .parse(result.claims());
    } catch {
      throw new Problem(
        401,
        "Identity could not be verified. Use an account with a verified email and try again.",
      );
    }
    return this.access.identity(this.config.serverMetadata().issuer, {
      sub: claims.sub,
      email: claims.email,
      name: claims.name || claims.email,
    });
  }
}
