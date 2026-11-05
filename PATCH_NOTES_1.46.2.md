# GuildHub 1.46.2 – Automatische Anwesenheit & Daily Schedule

Nur GuildHub; Shotcaller bleibt 4.6.0. Keine Migration, keine neuen Pflicht-Variablen.

- Automatisches Voice-Tracking startet jetzt zur Event-Zeit (+ Offset) mit jeder aktiven Shotcaller-Session – unabhängig davon, ob die Parties gepostet wurden.
- Fehlt dann die Session oder ein Channel, wird die Automatik nur für dieses Event abgeschaltet und der Grund angezeigt; manuelles Tracking bleibt möglich.
- Automatischer Start nur bis 15 Minuten nach der Tracking-Zeit (VOICE_AUTO_TRACK_WINDOW_MS); nachträglich eingetragene ältere Events werden nie automatisch getrackt.
- Wird „Automatisches Tracking“ nach einem Fehlschlag wieder eingeschaltet, gilt es für den nächsten Termin erneut.
- Alte, nie getrackte Events werden beim Update nicht als „fehlgeschlagen“ markiert.
- Der bereits gepostete Discord-Tagesplan von heute folgt Änderungen am Kalender (bearbeiten statt neu posten, gelöschte Events entfernen, sichere Wiederholung nach Fehlern).
