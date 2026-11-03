# GuildHub 1.46.0 + Shotcaller 4.6.0 – Bridge Control Matrix

Beide aktualisieren und neu bauen. Keine neuen Variablen; Runtime-Schema bleibt Version 1.

- Shotcaller → Bridge & Comms neu gestaltet: Insanity links, Bridge-Steuerung mittig, Alliance rechts, Einstellungsleiste darunter (auf schmaleren Bildschirmen untereinander).
- Neu: Pause / Resume der Bridge (stoppt nur die Cross-Server-Audiowege, Sessions und Relays bleiben; Pause übersteht einen Neustart) und Restart (baut nur die Bridge-Audiorouten neu auf).
- Pause/Resume/Restart auch im Alliance-Portal und im Alliance Management; Audit mit Bridge-ID.
- Wartet die Bridge, erreichen interne Callouts weiterhin den eigenen Main Caller.
Rollback-Hinweis: Vor einem Rückschritt auf eine ältere Bot-Version die Bridge beenden (ältere Versionen kennen Pause nicht).
