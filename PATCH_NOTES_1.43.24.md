# GuildHub 1.43.24 (+ Shotcaller 4.4.1)

Beide Anwendungen aktualisieren und Images neu bauen. Keine neuen Umgebungsvariablen.

- Pause/Resume der Shotcaller-Session (Attendance-Tracking läuft unabhängig weiter).
- Genau ein Main Caller; nach 30 s Abwesenheit Prompt „Main shotcaller unavailable“ mit Ersatz oder Warten.
- PTT-Prio/Callout geht an den verfügbaren Main Caller, sonst an alle anderen Parties.
- Preflight vor dem kombinierten Discord-Post/Start: Bei Fehler wird nichts gepostet.
- Max. 12 Party-Channels; weitere Parties zeigen „No Shotcaller channel“. Party-Leader optional.
- „Connection issue“ pro Party, Operation-IDs und Start-/Verbindungslog unter System status.
- Gemeinsames, pro Officer gespeichertes Session-Setup für Dashboard und Shotcaller.
- Extra-Channel-Presence: Fehlgeschlagene Abfragen machen den Run „incomplete“, nie No-Shows.
- Roster-Suche, Dashboard-Polling und Attendance-Auswahl ohne unnötige Redraws (1.43.21).
- Fix (Integration): Der Abwesenheits-Prompt blockiert die Seite dahinter nicht mehr („Loading voice session…“).

Update: aktives Tracking beenden, Session stoppen, beide Container neu bauen, Version 1.43.24 / 4.4.1 prüfen.
