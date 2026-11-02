# Alliance Bridge – Einrichtung und geprüfter Stand

**Aktuell:** GuildHub 1.44.2 enthält das Alliance-Portal im gezeigten Design. Siehe ALLIANCE_PORTAL_DESIGN_1.44.2.md für Gestaltung, Vorschau und die 100 bestandenen aktuellen Tests. Der Bot bleibt auf 4.5.1.

Dieses Paket erweitert die hochgeladenen Versionen `shotcallerbot-v4.4.1(1).zip` und `guildhall-1.43.26.zip`. Die Versionskennung im hochgeladenen GuildHub-Code lautet intern 1.43.25. Die erweiterten Pakete heißen Shotcaller 4.5.1 und GuildHub 1.44.2.

## Einrichtung

1. Vor dem Update beide bisherigen Programmordner, deren `.env` und die persistenten Datenverzeichnisse sichern. Das Paket enthält keine eingerichteten Bot-Tokens und keine Live-Datenbank.
2. Die Programmdateien aus `shotcallerbot/` und `guildhub/` in die jeweiligen bestehenden Deployments übernehmen. Die bisherigen `.env` und Docker-Datenvolumes erhalten. Beide Anwendungen neu bauen und aktualisieren; nicht nur die Webseiten-Dateien austauschen.
3. Im Bot zusätzlich setzen:

   ```dotenv
   INSANITY_GUILD_ID=<Discord-Server-ID von Insanity>
   ALLIANCE_GUILD_ID=<Discord-Server-ID der Partnergilde>
   ```

   Die IDs müssen verschieden sein. Ohne beide Werte bleibt die Bridge deaktiviert; bestehende interne Sessions bleiben nutzbar. Die alten `BRIDGE_PARTNERS`-Einträge ersetzen die eindeutige Insanity-/Alliance-Zuordnung nicht.
4. In GuildHub zusätzlich setzen:

   ```dotenv
   ALLIANCE_GUILD_ID=<dieselbe Partner-Server-ID>
   ALLIANCE_OFFICER_ROLE_IDS=<durch Komma getrennte Discord-Rollen-IDs>
   ALLIANCE_OFFICER_USER_IDS=<optional: durch Komma getrennte Discord-Benutzer-IDs>
   ```

   `DISCORD_GUILD_ID` bleibt Insanity. `SHOTCALLER_URL` und `SHOTCALLER_API_KEY` bleiben die bestehende Bot-Anbindung. Für den Partnerzugang muss die bestehende Discord-OAuth-Anmeldung eingerichtet sein. Es wird dieselbe Callback-Adresse verwendet. Die GuildHub-Compose-Datei reicht die neuen Werte an den Container weiter.
5. Der Hauptbot und dieselben zwölf Relay-Bots müssen auf beiden Discord-Servern Mitglied sein. Die bestehenden Discord-Intents und die erforderlichen Kanalrechte gelten auch auf der Partnerseite. Jeder Relay-Account meldet sich nur einmal am Gateway an und besitzt je Server einen getrennten Voice-Player und eine getrennte Verbindung.
6. Im Insanity-GuildHub die normale Shotcaller-Seite öffnen. Die Bridge lässt sich dort auch ohne laufende interne Session starten. Der Alliance-Zugang liegt unter **`/alliance.html`** auf derselben GuildHub-Adresse.
7. Unter **Admin → Shotcaller → Bridge settings** lassen sich die Alliance-Main-Berechtigung und der Audio-Puffer verwalten. Die Alliance darf standardmäßig keine Bridge-Mains ändern. Die bestehenden GuildHub-Officers sind in diesem Code die Administratorgruppe; eine separate neue Admin-Rolle wurde nicht eingeführt.

Die Partneranmeldung prüft Mitgliedschaft im Partner-Discord und die konfigurierten Officer-Rollen beziehungsweise Benutzer. Sie erzeugt eine auf acht Stunden begrenzte Alliance-Sitzung. Diese darf nur die ausdrücklich erlaubten Alliance-Voice-Endpunkte nutzen. Sie erhält weder Insanity-Roster noch Admin-Zugriff. Rollen-Claims werden bei erneuter Anmeldung aktualisiert; Änderungen an der konfigurierten Rollen-/Benutzerfreigabe wirken bereits bei nachfolgenden Anfragen.

## Bedienung

- Pro Server eine eigene interne Session mit bis zu zwölf Partys. Der ausgewählte Startchannel bleibt Party 1 und wird nicht vom Bot gelöscht. Ein durch einen bestehenden Join-to-create-Dienst erzeugter Startchannel kann weiterhin verwendet werden. Die ZIP enthielt keinen eigenen Join-to-create-Generator; dieser wurde nicht ersetzt.
- Bridge starten: Sind beide Sessions bereit, wird das gemeinsame Routing aktiv. Andernfalls wartet die Bridge. Bei Verlust der Session-/Caller-Quelle wechselt sie zu Waiting beziehungsweise Reconnecting. Ein einzelner ausgefallener Party-Relay stoppt die übrigen Partys nicht.
- Beim manuellen Session-Stop mit angeforderter Bridge muss zwischen **Keep Bridge Waiting** und **End Alliance Bridge** gewählt werden. Die API verlangt dieselbe ausdrückliche Auswahl. Automatisierte Ersetzungen durch Post to Discord + Shotcaller starten senden ausdrücklich Keep; manuelle Stops verlangen weiter die Auswahl.
- Beide Seiten dürfen die Bridge vollständig beenden. Die jeweils andere interne Session bleibt bestehen.
- Beide verfügbaren Shotcaller sind standardmäßig Bridge-Mains. Die beiden Schalter steuern unabhängig voneinander die Empfänger für PTT Priority. Ohne verfügbaren aktiven Main gehen die Callouts an alle anderen Partys. Normale Shotcaller-Ansagen werden weiterhin an beide Server verteilt.
- Insanity Swipe unterdrückt ausschließlich die ausgehenden, vom Bot weitergeleiteten Audiorouten des Alliance-Shotcallers. Eingehende Ansagen und PTT-Empfang bleiben möglich. Native Sprache innerhalb seines eigenen Discord-Channels kann ein reines Relay-Routing nicht ausblenden; der Bot verwendet dafür kein Discord-Server-Mute. Swipe wird bei Waiting/Reconnecting und nach Neustarts zurückgesetzt.
- Bridge-Mains sind von internen Main-Zuweisungen getrennt. Beim Bridge-Ende werden die vor Bridge-Start gespeicherten internen Caller-Zuweisungen wieder eingesetzt.

## Neustart und Daten

Der Bot speichert den gewünschten Session-/Bridge-Zustand in `data/runtime.json`. Das vorhandene persistente Bot-Volume muss erhalten bleiben. Ein absichtlich beendeter Bridge-Wunsch wird vor der Trennung als beendet gespeichert. Zuvor aktive interne Sessions werden nach einem Neustart erneut geprüft und aufgebaut; bestehende Party-Channels werden wiederverwendet und nur fehlende Channels ersetzt. Fehlgeschlagene Wiederherstellungen werden nach 30 Sekunden erneut versucht. Ein absichtlich gestoppter interner Session-Wunsch wird entfernt.

Relay-Ausfälle werden einzeln mit begrenztem Backoff von 1, 2, 5, 10 und danach 30 Sekunden erneut versucht. Diese Wartezeiten kommen zur jeweiligen Voice-Handshake-/Grace-Zeit hinzu. Nach 30 Sekunden Ausfalldauer zeigt GuildHub eine Warnung für den betroffenen Relay an. Veraltete Audio-Queues werden verworfen.

## Audio und Diagnose

Die Bridge nutzt die vorhandenen AudioRouter und einen zentral gemeinsam genutzten Mixer je Ziel. Quellen werden nach Server und Sprecher getrennt. Relay-/Bot-Identitäten werden nicht als Originalquellen eingespeist; der Quellchannel wird nicht zurückbeschallt. Gleichzeitige Sprecher werden zu einer Ausgabe pro Ziel gemischt.

Der anfängliche Bridge-Puffer beträgt zwei 20-ms-Frames, also nominell 40 ms. Das ist ein zu validierender Startwert, keine gemessene Ende-zu-Ende-Latenz. Es erfolgt weiterhin Opus-Decoding, PCM-Mixing und Opus-Encoding, wie in der bestehenden Mixer-Architektur. Diagnosewerte enthalten Mixframes, verworfene Frames, Unterläufe und Queue-Höchststände. Die tatsächliche Sprachlatenz wird ausdrücklich als nicht gemessen ausgewiesen.

## Prüfung und Grenzen

Für den aktuellen Korrekturstand, die 94 bestandenen Tests, die blockierten HTTP-Testläufe und die unveränderten Risiken gilt **KORREKTUREN_4.5.1_1.44.1.md**. Die vollständige GuildHub-Suite wurde für diese Version nicht erneut über HTTP ausgeführt. Die historischen Protokolle bleiben getrennt erhalten. Vor dem Update `npm run check-upgrade` im Bot-Verzeichnis mit dem bestehenden Datenvolume ausführen.

## Technische Referenzen

- [discord.js: Voice-Verbindungen werden über Guild-ID und Connection Group zugeordnet](https://discord.js.org/docs/packages/voice/0.19.0/getVoiceConnection%3AFunction)
- [discord.js: JoinVoiceChannelOptions einschließlich group und guildId](https://discord.js.org/docs/packages/voice/0.19.0/JoinVoiceChannelOptions%3AInterface)
- [Discord: Voice-/DAVE-Protokoll](https://github.com/discord/discord-api-docs/blob/main/developers/topics/voice-connections.mdx)

Die vorhandenen festgelegten Discord-/Voice-/DAVE-Abhängigkeiten wurden erhalten. Die Paket-Versionen wurden zur Kennzeichnung der gemeinsamen Erweiterung erhöht.
