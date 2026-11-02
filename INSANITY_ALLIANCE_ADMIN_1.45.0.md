# Insanity Admin Access – GuildHub 1.45.0

Der Alliance-Zugang ist in die bestehende GuildHub-Anwendung integriert. Es gibt keine zweite Anwendung und keine neue Anmeldung für Insanity-Administratoren.

## Verwendung

1. GuildHub auf **1.45.0** aktualisieren; bestehende `.env`, Datenbank und Datenvolumes erhalten. Der Bot bleibt unverändert auf **4.5.1**.
2. Wie bisher über Discord-OAuth beim Insanity-GuildHub anmelden.
3. In der vorhandenen Seitenleiste unter **Leadership → Alliance Management** öffnen.
4. Die konfigurierte Alliance-Gilde und ihren Verbindungs-/Sessionstatus ansehen. **Open Alliance Portal** öffnet `/alliance.html` mit derselben angemeldeten Sitzung.
5. Alle fünf bisherigen Portalbereiche stehen zur Verfügung. Die Oberfläche kennzeichnet den Zugang als **Insanity Admin**, nennt den handelnden Administrator und bietet den Rückweg zu GuildHub.

Weder eine Mitgliedschaft im Alliance-Discord noch dortige Rollen sind für diesen Administratorzugang erforderlich. Die bestehende Insanity-Sitzung wird nicht durch ein Alliance-Token ersetzt; Rolle und Benutzer-ID bleiben erhalten. Es werden keine Tokens in Links übertragen.

## Administratorprüfung

Die bestehende Anwendung verwendet ihre Officer-Zuweisungen als Administratorgruppe. Für den neuen Verwaltungszugang prüft der Server:

- eine authentifizierte Discord-OAuth-Identität;
- einen bekannten, nicht gekickten Insanity-Benutzer mit bei der Anmeldung bestätigter Insanity-Mitgliedschaft;
- eine aktuelle explizite Insanity-Officer-Benutzerfreigabe oder eine passende Insanity-Officer-Rollenzuweisung aus den bestehenden Einstellungen beziehungsweise Discord-Konfigurationswerten.

Support-, Read-only-, Applicant-, Partner- und unbekannte Konten erhalten keine Insanity-Administratorrechte. Ein bloßes `role: officer` im Sitzungstoken genügt für den neuen Zugang nicht. Änderungen an den bestehenden GuildHub-Officer-Freigaben werden bei folgenden API-Anfragen neu ausgewertet. Discord-Mitgliedschaft und Discord-Rollen selbst werden weiterhin durch die bestehende OAuth-Anmeldung bestätigt und als Anmeldezustand gehalten; es wird kein zusätzlicher Discord-Membership-Aufruf für jede Verwaltungsaktion behauptet.

Normale Insanity-Mitglieder sehen den Menüpunkt nicht und können die Verwaltungsendpunkte auch nicht direkt verwenden. Administratoren aus dem lokalen Passcode-Demomodus erhalten diese neue OAuth-gebundene Berechtigung nicht automatisch. Die bisherigen Insanity-Berechtigungen anderer Funktionen werden nicht verändert.

Die übermittelte Anforderung endete nach dem Wort „Regular“. Für diesen Teil wurde die sichere Regel umgesetzt: normale Mitglieder ohne aktuelle Administratorfreigabe erhalten keinen neuen Verwaltungszugriff.

## Alliance Management

- **Alliance Overview:** konfigurierte Partnergilde, Erreichbarkeit der Bot-Schnittstelle, Zugriff des Bots auf den Discord-Server, Sessionstatus und aktive Party-Anzahl.
- **Open Alliance Portal:** bestehendes Portal mit bestehendem Insanity-Cookie öffnen; kein neuer OAuth-Durchlauf und kein Rollenwechsel.
- **Alliance Permissions:** Partnerzugang sperren/freigeben, Alliance-Officer-Rollen und zusätzliche Officer-Benutzer freigeben sowie Bridge-Main-Delegation und Audio-Puffer verwalten.
- **Bridge Status:** bestehende Start-/End-, Main- und Insanity-Swipe-Funktionen bedienen.

Die Verwaltungsseite verwendet die vorhandene Insanity-Seitenleiste, Icons, Panels, Buttons und Farben. Die bisherige Alliance-Portal-Gestaltung bleibt bestehen.

Die bestehende Bridge-Architektur unterstützt genau **eine konfigurierte Partnergilde**. Die Übersicht zeigt diese Gilde in einer Liste. Es wurde keine zusätzliche Mehrgilden-Bridge-Architektur oder frei wählbare Proxy-Zieladresse eingeführt.

## Verhalten im Portal

Insanity-Administratoren können die Alliance-Session, Caller und die bestehenden Portalbereiche verwalten. Bridge-Mains können sie unabhängig von der Partnerdelegation ändern. Swipe und technische Audioeinstellungen verwenden dabei ausdrücklich die bereits vorhandene Insanity-Autorität.

Session-Operationen sind weiterhin fest an den Alliance-Server gebunden. Eine vom Browser eingesandte fremde Guild-ID ändert das Ziel nicht. Nur berechtigte Administratoraktionen für die Bridge werden serverseitig über die Insanity-Seite weitergereicht. Der Browser erhält weder den Bot-API-Schlüssel noch die Möglichkeit, den administrativen Bot-Header selbst festzulegen.

Im Bereich **Discord Settings** erscheinen für Administratoren zusätzlich die freigegebenen Alliance-Verwaltungseinstellungen. Bot-Tokens, OAuth-Secrets und Server-Identitäten bleiben wie bisher in der Deployment-Konfiguration; sie werden nicht im Browser offengelegt.

## Partnerrechte und Speicherung

Der bisherige Partnerzugang bleibt erhalten. Alliance-Konten bekommen keine Insanity-Navigation und keine Verwaltungsendpunkte. Die neuen Partnerfreigaben werden über die vorhandene GuildHub-Speicherung unter `settings.allianceAccess` gespeichert. Solange dort keine eigenen Listen gespeichert sind, gelten die bisherigen `ALLIANCE_OFFICER_ROLE_IDS` und `ALLIANCE_OFFICER_USER_IDS` als Standard. Danach haben die gespeicherten Listen Vorrang.

Eine Partnersperre sperrt Insanity-Administratoren nicht aus. Sie beendet auch keine laufende interne Session und trennt die Bridge nicht automatisch. Leere Partnerfreigabelisten sperren normale Partnerkonten, sofern keine andere explizite Partnerfreigabe gesetzt wird. Änderungen werden im bestehenden Audit-Log unter der echten Insanity-Identität protokolliert.

Es sind keine neuen Umgebungsvariablen erforderlich. `DISCORD_GUILD_ID` bleibt Insanity, `ALLIANCE_GUILD_ID` bleibt die vorhandene Partnergilde.

## Verifikation

- **30/30 gezielte Tests bestanden:** echte OAuth-/HTTP-Anmeldung gegen lokale Discord-/Bot-Testserver, Administratorzugang ohne Partnerprüfung, unveränderter Sitzungscookie und unveränderte Rolle, vorhandene Insanity-Schreibrechte, Session-Zielbindung, Bridge-Autorität, Partner-/Mitglieder-/Support-Sperren, Freigaben, Portal-Kontext und Navigation.
- **84/84 Bot- und gemeinsame Bridge-Modultests bestanden.** Der Bot-Code wurde für dieses Feature nicht geändert.
- **Breiter GuildHub-Lauf: 318/322 bestanden**, drei Fehler und ein Abbruch bei Potentials-/Skillcores-/Voice-Attendance-Neustarttests. Ein Vergleichslauf mit der unveränderten hochgeladenen ZIP reproduziert diese drei Fehler und den Abbruch. Anschließende kleine UI-/Entwurfsprüfungen sind im gezielten Lauf enthalten.
- Ein zusätzlicher temporärer Windows-Verzeichnisfehler beim Support-Test wurde durch Wiederholungsversuche beim Test-Cleanup behoben. Die Support-Implementierung ist bytegleich zur hochgeladenen Version; keine fachliche Assertion wurde entfernt oder gelockert.

Die vollständigen Protokolle liegen unter `validation/current/`. Der HTTP-Zugriff auf lokale Testserver war für diese Sitzung freigegeben; die neue Anmeldung und Autorisierung wurden deshalb tatsächlich über HTTP geprüft. Discord und Bot-Dienst wurden dabei simuliert. Es wurden keine Live-Anmeldedaten verwendet, keine produktiven Datenvolumes gelesen oder verändert und keine Live-Dienste aktualisiert.

Eine neue visuelle Browserabnahme und ein Docker-Build auf dem Zielserver wurden nicht durchgeführt. Die bisherigen Grenzen zu echten Voice-Verbindungen, PTT-Priority und Sprachlatenz bleiben bestehen. Die vollständige GuildHub-Suite wird nicht als vollständig grün bezeichnet.
