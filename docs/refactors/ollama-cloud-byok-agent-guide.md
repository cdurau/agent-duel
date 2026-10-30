# Agenten-Anleitung: Ollama Cloud BYOK umsetzen

Status: Übergabedokument für eine künftige Implementierung. Es aktiviert keine Projektregeln und behauptet keine bereits vorhandene Ollama-Unterstützung.

Repository: `/Users/cedi/Clouds/Projekte/KI/agent-duel`

## Auftrag und Autorisierung

Setze den [Umsetzungsplan](ollama-cloud-byok-plan.md) um. Der Plan besitzt Umfang, Produktentscheidungen, Etappen und Abnahme. Diese Anleitung besitzt Einstiegspunkte und Arbeitsweise; dupliziere seine Anforderungen nicht in neuen Dokumenten.

Diese Anfrage gibt keine Freigabe für kostenpflichtige Inferenz, Daemon-Neustarts während laufender Arbeit oder das Einchecken von Implementierungsänderungen. Vor Live-Inferenz explizit nachfragen. Keys nie im Chat anfordern oder in Ausgaben übernehmen.

## Vor dem ersten Code-Change

1. Lies die aktuellen `CLAUDE.md`-/`AGENTS.md`-Dateien entlang der bearbeiteten Verzeichnisse. Prüfe `git status --short`; fremde Änderungen bleiben erhalten.
2. Lies `docs/arena.md`, `docs/architecture.md`, `docs/coding-standards.md`, `docs/testing.md` und `docs/rpc-namespacing.md`.
3. Für UI-Arbeit zusätzlich `docs/forms.md`, `docs/design.md`, `docs/unistyles.md` und die jeweils relevanten Hover-/Menü-/Popover-Regeln. Lies `docs/qa.md`, bevor du Nachweise planst.
4. Für `arena-backend` dessen eigene `AGENTS.md` und die des Zielpakets. npm- und Bun-Paketgraph bleiben getrennt.
5. Lade aktuelle Ollama-Dokumentation über Context7: Bibliothek auflösen, dann die konkrete API-Frage abfragen. Quellen im Plan sind Einstiegspunkte, keine Garantie unveränderter APIs.
6. Prüfe die Verfügbarkeit der vorgeschriebenen context-mode-Tools. Verwende sie für große Suchen, Datei-Analysen und Webabrufe. Sind sie nicht verfügbar, halte dedizierte Reads/Suchen eng begrenzt; keine ungebremsten rekursiven Dumps, blockierten HTTP-Shellbefehle oder direkten URL-Fetches.

## Orientierung im Code

Die Pfade sind bestätigte Einstiegspunkte des Planungsstands. Suche Symbole erneut, statt Zeilennummern zu übernehmen.

### Schlüssel, UI und Wire-Vertrag

| Thema                           | Einstieg                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Client-Key-Lebenszyklus         | `packages/app/src/byok/key.ts`, `key.test.ts`                                                               |
| Bestehende Einstellungen        | `packages/app/src/byok/key-section.tsx`                                                                     |
| Neues Formular: Vorbild         | `packages/app/src/agent-profiles/internal/profile-form-model.ts` und zugehörige Adapter aus `docs/forms.md` |
| Sicherer Speicher               | `packages/desktop/src/features/encrypted-storage.ts`, `encrypted-storage.test.ts`                           |
| IPC-Brücke                      | `packages/desktop/src/preload.ts`; Desktop-Host-Typen über Verwendungen suchen                              |
| RPC-Schemas                     | `packages/protocol/src/arena/rpc-schemas.ts`; Registrierung/Union über bestehende BYOK-Symbole suchen       |
| Handgeschriebener Daemon-Client | `packages/client/src/daemon-client.ts`, `daemon-client.test.ts`                                             |
| RPC-Verarbeitung                | `packages/server/src/server/session.ts`, `session.test.ts`                                                  |
| Payload-Redaktion               | `packages/server/src/server/websocket-server.ts`; Suche nach `carriesByokKey`                               |
| Daemon-BYOK                     | `packages/server/src/server/accounts/byok.ts`, `byok.test.ts`, `credentials.ts`                             |
| Pipe zur Engine                 | `packages/server/src/server/agent/providers/opencode/server-manager.ts`                                     |
| Start-/Restart-Tests            | `packages/server/src/server/agent/providers/opencode-server-manager.test.ts`                                |

### Inferenz und persistente Arena

| Thema               | Einstieg unter `arena-backend/packages/`                             |
| ------------------- | -------------------------------------------------------------------- |
| Startup-Parsing     | `opencode/src/arena/credentials.ts`                                  |
| BYOK-Komposition    | `opencode/src/arena/backend.ts`, `runtime.ts`                        |
| Blinder Transport   | `opencode/src/arena/proxy.ts`, `privacy.ts`, `model-profile.ts`      |
| Engine-Anbindung    | `opencode/src/provider/provider.ts`; Suche nach `contestantFetch`    |
| Orchestrierung      | `opencode/src/arena/service.ts`, `assignment-client.ts`              |
| Service-Grenze      | `arena-service/src/service.ts`, `context.ts`                         |
| Modelle und Limits  | `arena-service/src/pool.ts`, `default-pool.ts`                       |
| Private Zuweisungen | `arena-service/src/assignments.ts`                                   |
| OpenRouter-Semantik | `arena-service/src/openrouter.ts` und gezielte zugehörige Tests      |
| Hilfsaufrufe        | `arena-service/src/utility-model.ts`, `comparison.ts`, `metadata.ts` |

Erweitere die vorhandene Arena. Die deaktivierten Paseo-Adapter für Claude/Codex/Pi sind kein Weg zur Ollama-Anbindung. `packages/protocol/src/provider-manifest.ts` muss nicht wegen eines neuen Inferenzanbieters einen weiteren Agent-Typ erhalten.

## Erster ausführbarer Arbeitsschritt

Beginne mit Etappe 1 des Plans, nicht mit dem Einstellungsformular:

1. Verifiziere den dokumentierten direkten Cloud-Katalog und die tatsächlichen API-Modellnamen.
2. Erfasse je ausgewähltem Kandidaten: Metadata-Quelle, Tool-/Bildfähigkeit, Reasoning-Steuerung und belegte Limits.
3. Prüfe, ob `/api/show` direkt in der Cloud funktioniert. Wenn nicht, dokumentiere die Lücke und nutze keine stillschweigend angenommenen lokalen Fähigkeiten.
4. Frage vor Live-Inferenz nach Freigabe. Vorhandene sichere UI oder eine ausdrücklich vereinbarte sichere Testübergabe verwenden. Kein Secret in Befehlsargumenten, Testdateien oder Ausgaben.
5. Mit Freigabe einen kleinen vollständigen Tool-Roundtrip nachweisen. Zwei passende Modelle und Vision gesondert prüfen.
6. Liefere entweder die belegte Kompatibilitätsmatrix oder einen konkreten Blocker. Fehlende Vision-/Tool-Eignung nicht durch einen ungefragten Text-only-Modus umgehen.

## Entwurfsregeln bei der Umsetzung

### Grenzen einhalten

- Discovery muss vor einer gültigen Arena-Konfiguration möglich sein. Vermeide einen Kaltstart-Zirkel „Modellliste braucht Arena, Arena braucht Modellwahl“.
- Neue Transporttypen besitzen einen fachlichen Owner. Parse externe Antworten und IPC/RPC/Startup-Payloads an ihren Grenzen; keine `any`-/Cast-Auswege.
- Erhalte den bisherigen Aufrufervertrag des geteilten `arena-service`, damit der private Hosted-Dienst keinen ungeplanten Pflicht-Deploy benötigt.
- Aktualisiere ersetzte lokale RPCs samt Client, Registrierung und Handler gemeinsam. Persistente Datenmigration und Altclient-Kompatibilität sind unterschiedliche Themen.
- Kein allgemeines Plugin-/Provider-Framework für hypothetische Anbieter bauen. Die Trennung muss durch OpenRouter und Ollama begründet sein.

### Race Conditions zuerst modellieren

- Cache-Einträge und in-flight Requests gehören zu Host/Anbieter/Credential-Generation.
- Refresh darf Entwürfe, Auswahl-Labels oder Modellzuweisungen nicht zurücksetzen.
- Ein fehlgeschlagener Refresh ist kein leerer Katalog.
- Das Anwenden neuer Konfiguration und der Start neuer Arena-Arbeit müssen dieselbe serialisierte Grenze benutzen. Ein vorheriger UI-Check allein verhindert keinen gleichzeitigen Send.
- Bei fehlgeschlagenem Anwenden darf nicht „gespeichert und aktiv“ erscheinen. Vorherige gültige Konfiguration erhalten oder einen eindeutigen wiederherstellbaren Fehlerzustand ausgeben.
- Mehrere Fenster und wiederholte Zustellung identischer Konfiguration dürfen keine Arena-Neustartschleife auslösen.

### Sicherheit und Blinding

- API-Key nur über bestehende sichere Speicher-/Pipe-Muster transportieren. Neue Secret-Payloads vollständig redigieren.
- Auswahl und Credential-Zustellung an den richtigen Host binden; vorhandenes Broadcast-Verhalten nicht ungeprüft auf Ollama ausdehnen.
- Modellnamen gehören in die Konfiguration und in private Assignments, nicht in laufende öffentliche Battle-Events, Fehlermeldungen oder Tool-IDs.
- Antworten und Reasoning müssen zur nächsten Modellanfrage zurückführbar bleiben, auch wenn öffentliche Identitäten und Reasoning-Anzeigen redigiert werden.
- Keine versteckten OpenRouter-Aufrufe als Hilfsmodell-/Compaction-Fallback.

### UI

Nutze für die mehrteilige Einrichtung ein React-freies Formularmodell gemäß `docs/forms.md`. React Query besitzt den Serverzustand; Komponenten rendern und senden Intents.

Katalog, Eignung und Zugriff sind getrennte Zustände aus dem Plan. Ausschlussgründe gehören in die Modellübersicht; Auswahlfelder bieten nur für die Rolle gültige Optionen. Kopiere nicht pauschal dauerhaft deaktivierte Felder in Formulare, wenn deren Capability gar nicht gilt. Zusätzliche erklärende Texte nach den Regeln von `docs/forms.md` abstimmen.

Jede Aktion braucht Pending-, Erfolgs- und sichtbaren Fehlerzustand: Laden, Refresh, Modellprüfung, Speichern und Entfernen. Bei Netzwerkfehlern weder den Formularentwurf noch den letzten Katalog verlieren.

## Testbefehle und Arbeitsrhythmus

Arbeite in kleinen vertikalen Änderungen. Lass jeweils den passenden Verhaltenstest scheitern, implementiere und prüfe nur die betroffenen Dateien. Keine Testsuites pauschal wiederholen, die ein anderer Agent bereits grün gemeldet hat.

### npm-Workspace

Vom Repository-Root aus:

- Gezielter Vitest-Lauf: `npx vitest run <betroffene-testdatei> --bail=1`.
- Nach Codeänderungen: `npm run typecheck` und `npm run lint`.
- Bei stale Cross-Package-Deklarationen zuerst `npm run build:client` oder für den Server-Stack `npm run build:server`; keine lokalen Typduplikate als Workaround.
- Formatierung gezielt über `npm run format:files -- <dateien>`; vor einem Commit `npm run format` und resultierende Änderungen kontrollieren.

### Bun-Workspace

Mit Arbeitsverzeichnis im jeweiligen Paket, nicht im Repository-Root:

- `arena-backend/packages/arena-service`: `bun test ./src/<betroffene-datei>.test.ts --bail=1`, danach `bun run typecheck`.
- `arena-backend/packages/opencode`: tatsächlichen zugehörigen Testpfad suchen, dann `bun test <betroffene-testdatei> --bail=1`, danach `bun run typecheck`.
- Die Root-Typechecks umfassen den separaten Bun-Paketgraph nicht automatisch.
- Wenn eine öffentliche Backend-HttpApi verändert wird, generierte Clients über den passenden Generator erzeugen; niemals generierte SDK-Dateien von Hand ändern. Interne Provider-Arbeit allein ist kein Grund für eine öffentliche API-Änderung.

Prüfausgaben begrenzen oder in einen freigegebenen Temp-Pfad schreiben. Nie die gesamte Testsuite oder alle Workspaces mit `npm run test` starten. Lint-/Format-Tools ausschließlich über npm-Scripts aufrufen.

### Laufende Anwendung

Nach separater Freigabe zum Starten/Live-Test die vollständige Desktop-Umgebung mit `npm run dev:desktop -- --byok` starten und auf `[dev] healthy:` warten. Fehlende Root-Abhängigkeiten mit npm, Backend-Abhängigkeiten separat mit Bun vorbereiten.

Keinesfalls den Hauptdaemon auf Port 6767 neu starten. Checkout-lokale Dev-Zustände und Produktionsdaemon nicht verwechseln. Ein Timeout rechtfertigt keinen Neustart.

Für Electron-/Browser-Steuerung vorher die jeweils passende Browser-/Computer-Skill laden. Browser-QA ersetzt nicht die Electron-Abnahme und den verschlüsselten Desktop-Speicher.

## Dokumentation und Abschluss

Während der Umsetzung belegte Entscheidungen, offene Risiken und ausgeführte gezielte Prüfungen festhalten. Ergebnisse nicht aus dem Plan ableiten: „vorgesehen“ ist nicht „getestet“.

Die spätere Projektdoku nach Abschnitt 9 des Plans integrieren. Root-`AGENTS.md` oder `CLAUDE.md` nicht mit dieser gesamten Anleitung füllen. Dort nur das besitzende Fach-Dokument verlinken.

Ein Abschlussbericht nennt:

1. Umgesetzte Etappen und verbleibende Blocker.
2. Geänderte Dateien und gezielte Testbefehle mit Ergebnis.
3. Tatsächlich geprüfte Cloud-Modelle und Grenzen des Nachweises.
4. Electron-/Browser-QA und nicht geprüfte Plattformen.
5. Ergebnis der Kontrolle auf unbeabsichtigten OpenRouter-Verkehr und Identitäts-/Secret-Leaks.
6. Offene Live-/Hosted-Nachweise, falls Zugang oder Freigabe fehlten.

Keine automatischen Commits, Releases, Key-Rotationen oder Daemon-Neustarts aus dieser Anleitung ableiten.
