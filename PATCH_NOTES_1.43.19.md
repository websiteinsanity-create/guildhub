# GuildHub 1.43.19 – Einmaliger, schreibgeschützter Support-Zugang

- Admin erzeugt unter Leadership → Diagnostics → SupportAI access einen 12-stelligen Einmalcode (10 Min gültig, einmal einlösbar, danach 2 h Read-only-Session). Login unter /support, Benutzer „SupportAI“.
- Neues Erzeugen oder „Revoke“ beendet vorherigen Code und Session sofort. Code wird nie gespeichert oder auditiert (nur Hash).
- Support-Sessions sind charakterlos und strikt lesend (GET-Allowlist, alle Schreib-Routen gesperrt, kein DB-Export).
- Antworten werden bereinigt: Discord-IDs → stabile Aliase, Passwörter/Tokens/PINs/Secrets entfernt. Namen und Guild-Inhalte bleiben sichtbar; Bilder/Videos unverändert.
- Alte Support-Passwort-/Helper-Wege entfernt (SUPPORT_DISCORD_USER_IDS wirkt nicht mehr). Normale Discord-Anmeldung unverändert.

Update: Container neu bauen, Version via /api/config prüfen. Nach Backup-Restore zuerst Support-Zugang widerrufen.
