/**
 * Admin CRUD for SSO providers. Gated exactly like every other Pro feature:
 * requireFeature("sso") → 402 with the upsell, then requireRole("admin").
 *
 * The login flow itself lives in routes/auth-sso.ts and is deliberately NOT
 * gated by a preHandler — see the header there.
 */
import {
  createSsoProviderSchema,
  ssoSettingsSchema,
  updateSsoProviderSchema,
  type SsoProvider,
  type SsoSettings,
  type SsoTestResult,
} from "@bullpane/shared";
import type { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../auth/guards";
import { OidcError } from "../auth/sso/oidc";
import { SamlError } from "../auth/sso/saml";
import { blockInDemo, requireFeature } from "../plugins/gates";
import { HttpError, validation } from "../plugins/errors";
import { testProvider } from "./auth-sso";

type IdParams = { Params: { id: string } };

export async function ssoRoutes(app: FastifyInstance): Promise<void> {
  const admin = [requireAuth, requireFeature("sso"), requireRole("admin")];
  const adminMutating = [...admin, blockInDemo];

  app.get("/sso/providers", { preHandler: admin }, async (): Promise<SsoProvider[]> => app.ctx.sso.list());

  app.get("/sso/settings", { preHandler: admin }, async (): Promise<SsoSettings> => ({
    requireSso: await app.ctx.sso.requireSso(),
  }));

  app.put("/sso/settings", { preHandler: adminMutating }, async (request): Promise<SsoSettings> => {
    const input = ssoSettingsSchema.parse(request.body);
    await app.ctx.sso.setRequireSso(input.requireSso);
    request.auditTarget({ action: "sso.provider_update" });
    request.auditDetail({ requireSso: input.requireSso });
    request.log.info({ requireSso: input.requireSso, by: request.user?.id }, "sso requirement changed");
    return { requireSso: input.requireSso };
  });

  app.post("/sso/providers", { preHandler: adminMutating }, async (request, reply): Promise<SsoProvider> => {
    const input = createSsoProviderSchema.parse(request.body);
    const provider = await app.ctx.sso.create(input);
    // Name, kind and issuer are the finding; the client secret is never here
    // (and the audit sanitiser drops it anyway).
    request.auditTarget({ action: "sso.provider_create" });
    request.auditDetail({ providerId: provider.id, name: provider.name, kind: provider.kind });
    request.log.info({ providerId: provider.id, kind: provider.kind, by: request.user?.id }, "sso provider created");
    reply.status(201);
    return provider;
  });

  app.patch<IdParams>("/sso/providers/:id", { preHandler: adminMutating }, async (request): Promise<SsoProvider> => {
    const input = updateSsoProviderSchema.parse(request.body);
    const provider = await app.ctx.sso.update(request.params.id, input);
    request.auditTarget({ action: "sso.provider_update" });
    request.auditDetail({
      providerId: provider.id,
      name: provider.name,
      // "changed: [config]" is the finding; the values are not.
      changed: Object.keys(input),
    });
    return provider;
  });

  app.delete<IdParams>("/sso/providers/:id", { preHandler: adminMutating }, async (request) => {
    const provider = await app.ctx.sso.get(request.params.id);
    await app.ctx.sso.remove(request.params.id);
    request.auditTarget({ action: "sso.provider_delete" });
    request.auditDetail({ providerId: provider.id, name: provider.name, kind: provider.kind });
    request.log.info({ providerId: provider.id, by: request.user?.id }, "sso provider deleted");
    return { ok: true };
  });

  /**
   * "Test connection": resolves OIDC discovery (or parses the SAML cert) and
   * hands back the endpoints. It performs no login, so it is safe to click
   * repeatedly while getting the IdP config right — which is the whole point,
   * because the alternative is a redirect loop the admin has to decode.
   */
  app.post<IdParams>("/sso/providers/:id/test", { preHandler: admin }, async (request): Promise<SsoTestResult> => {
    const row = await app.ctx.sso.getRow(request.params.id);
    try {
      return await testProvider(row, app.ctx.sso.callbackUrl(row.id), app.ctx.sso.entityId());
    } catch (err) {
      /**
       * A failed test is information, not a server error: answer 200 with
       * ok:false so the UI can render the reason inline in the form.
       */
      if (err instanceof OidcError || err instanceof SamlError) {
        return { ok: false, message: err.publicMessage };
      }
      if (err instanceof HttpError) return { ok: false, message: err.message };
      throw err;
    }
  });

  /**
   * SAML SP metadata, so an admin can upload a file at the IdP instead of
   * copying two fields by hand. Admin-only: it is not secret, but there is no
   * reason to publish the install's topology to anonymous callers.
   */
  app.get("/sso/metadata", { preHandler: admin }, async (_request, reply) => {
    const providers = await app.ctx.sso.list();
    const saml = providers.find((p) => p.kind === "saml" && p.enabled) ?? providers.find((p) => p.kind === "saml");
    if (!saml) throw validation("Add a SAML provider first.");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${app.ctx.sso.entityId()}">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService index="0" isDefault="true" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${saml.callbackUrl}"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
    return reply.type("application/samlmetadata+xml").send(xml);
  });
}
