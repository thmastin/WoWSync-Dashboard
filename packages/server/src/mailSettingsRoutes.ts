import type { Express } from "express";
import { MailSettingsValidationError, resolveMailSettingsCharacter, validateMailPlanSettingsInput, validateMailSettingsScope, type MailPlanSettingsScope, type SnapshotStore } from "@wowsync-dashboard/core";

function scopeFrom(value: Record<string, unknown>): MailPlanSettingsScope {
  return validateMailSettingsScope(value);
}

export function registerMailSettingsRoutes(app: Express, store: SnapshotStore): void {
  app.get("/api/mail-plan-settings", (req, res) => {
    try {
      const scope = scopeFrom({ accountId: req.query.accountId, version: req.query.version, realm: req.query.realm, faction: req.query.faction });
      const settings = store.getMailPlanSettings(scope);
      const roster = store.listCharacters(scope.version);
      res.json({
        scope,
        settings: settings ?? null,
        auctionCharacter: resolveMailSettingsCharacter(settings?.auctionCharacterIdentityKey, scope, roster),
        mainCharacter: resolveMailSettingsCharacter(settings?.mainCharacterIdentityKey, scope, roster),
      });
    } catch (error) {
      if (error instanceof MailSettingsValidationError || error instanceof TypeError) return res.status(400).json({ error: error.message, code: "INVALID_MAIL_SETTINGS_SCOPE" });
      throw error;
    }
  });

  app.put("/api/mail-plan-settings", (req, res) => {
    try {
      const settings = validateMailPlanSettingsInput(req.body, store.listCharacters(req.body?.version));
      res.json({ settings: store.setMailPlanSettings(settings) });
    } catch (error) {
      if (error instanceof MailSettingsValidationError || error instanceof TypeError) return res.status(400).json({ error: error.message, code: "INVALID_MAIL_SETTINGS" });
      throw error;
    }
  });
}
