# GuildHub 1.43.20 – Support-Navigation & Rollen-Sichtbarkeit

Behebt: Stimmte ein Umgebungs-Credential mit dem Wort „officer“ überein, ersetzte die Bereinigung den Rollenwert, und SupportAI wurde als Member behandelt (Diagnostics, Shotcaller usw. versteckt).

- Feldnamen der API bleiben erhalten; Discord-ID-Schlüssel werden weiter zu Aliasen, Credential-Felder weiter entfernt.
- Support-State enthält feste öffentliche Rechte-Metadaten (canViewLeadership, support/readOnly), unabhängig vom bereinigten Rollen-String.
- Badge zeigt „Support · Read-only“.
- Einmalcodes, Read-Allowlist, Schreibsperre und Bereinigung unverändert.

Update: Container neu bauen, Version via /api/config prüfen, Browser neu laden.
