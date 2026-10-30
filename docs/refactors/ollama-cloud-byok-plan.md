# Ollama Cloud BYOK mit automatischem Modellkatalog

Status: Umsetzung begonnen, noch nicht abgenommen. Stand und Nachweise: [Umsetzungsstand](#umsetzungsstand-2026-10-30).

Repository: `/Users/cedi/Clouds/Projekte/KI/agent-duel`

Die [Agenten-Anleitung](ollama-cloud-byok-agent-guide.md) beschreibt Arbeitsregeln und Einstiegspunkte. Dieser Plan besitzt Anforderungen, Reihenfolge und Abnahmekriterien.

## Umsetzungsstand 2026-10-30

Die Umsetzung ist unvollständig. Der Ollama-Pfad ist noch nicht für einen vollständigen produktiven BYOK-Betrieb freigegeben. Nutze diesen Abschnitt als Übergabe; aktualisiere ihn nach weiteren verifizierten Etappen.

### Etappe 1: verifizierte Cloud-Kompatibilität

Die Cloud-Abfragen und begrenzten Live-Inferenztests wurden mit dem vom Nutzer bereitgestellten Key ausgeführt. Das Secret selbst wurde nicht in Ausgaben oder Repository-Dateien geschrieben.

- `GET https://ollama.com/api/tags` antwortete mit HTTP 200 und 23 Modellen. Der Katalog nennt `capabilities`; 12 Einträge hatten sowohl `vision` als auch `tools`. Die Abfrage ohne Authentifizierung antwortete ebenfalls mit HTTP 200.
- `POST https://ollama.com/api/show` mit Bearer-Key funktionierte direkt gegen die Cloud. Für `kimi-k2.6` kamen unter anderem `kimi-k2.context_length = 262144` und `thinking.values = [false, true]`; für `mistral-large-4` `mistral4.context_length = 1048576`; für `glm-5.3-flash` `glm5_next.context_length = 1048576` sowie `thinking.values = [low, high, max]` zurück.
- `GET https://ollama.com/v1/models` antwortete mit HTTP 200 und echten Modell-IDs. Der Endpoint lieferte keine Fähigkeiten; dafür ist `/api/tags` die verwendete Quelle.
- Mit `glm-5.3-flash` gelangen Chat Completions, ein vollständiger Tool-Zyklus (Tool-Aufruf, Tool-Ergebnis, abschließende Antwort), gestreamte Tool-Aufruf-Deltas und ein Vision-Aufruf mit Base64-Bild jeweils mit HTTP 200. `stream_options.include_usage` lieferte Nutzungsdaten.
- Ollamas OpenAI-kompatible Dokumentation markiert `tool_choice` als nicht unterstützt. Der neue Adapter entfernt dieses Feld, statt es ungeprüft weiterzuleiten. Modelle/Prompts, die erzwungene Toolwahl voraussetzen, sind noch nicht abgenommen.
- `reasoning_effort`-Werte wurden von der getesteten GLM-Instanz auch bei einem ungültigen Wert mit HTTP 200 angenommen. Daraus folgt kein Nachweis, dass die gewünschte Stufe angewendet wurde. Thinking-Steuerung und Metadaten müssen im Adapter konservativ behandelt und modellbezogen geprüft werden.

Die begrenzten Live-Aufrufe belegen die API-Kompatibilität der getesteten Pfade, nicht den kompletten Battle-/Desktop-Durchlauf, Bildqualität, parallele Belastbarkeit, Limits oder Hosted-Verhalten.

### Implementiert, aber noch nicht vollständig abgenommen

- BYOK-Startup-Credentials tragen jetzt Provider plus getrennte OpenRouter-/Ollama-Keyfelder; die Engine reicht den Key weiter über die bestehende Startup-Pipe, nicht über Contestant-Umgebungen.
- Protokoll, Client, Daemon-Hand-over, Desktop-IPC und Renderer-Keyablage wurden auf `openrouter`/`ollama` erweitert. Neue verschlüsselte Key-Slots und eine Legacy-OpenRouter-Migration sind begonnen.
- `arena-service` hat einen Ollama-Chat-Completions-Adapter, einen kleinen statischen Pool aus drei vision-/tool-fähigen Kandidaten, ein Utility-Modell sowie eine gemeinsame Response-Sanitizer-Datei. Der bestehende OpenRouter-Aufrufpfad bleibt erhalten.
- Die Settings zeigen eine Providerwahl und getrennte Schlüssel-Platzhalter. Die Katalog-Discovery, Rollen-/Pool-Konfiguration und Prüfung aus dem Plan fehlen noch; die Auswahl nutzt derzeit einen fest eingebauten Pool.

Gezielte Prüfungen am Übergabestand:

| Prüfung                                                                                                                                          | Ergebnis                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `npm run typecheck`                                                                                                                              | Grün                                            |
| `npm run lint`                                                                                                                                   | Grün, 0 Warnungen / 0 Fehler                    |
| `bun run typecheck` in `arena-backend/packages/arena-service`                                                                                    | Grün                                            |
| `bun run typecheck` in `arena-backend/packages/opencode`                                                                                         | Grün                                            |
| `bun test test/arena/credentials.test.ts --bail=1` im opencode-Paket                                                                             | 27 bestanden                                    |
| `bun test ./src/ollama.test.ts --bail=1` im arena-service-Paket, mit lokaler MongoDB                                                             | 6 bestanden                                     |
| `npm run test --workspace @getpaseo/app -- src/byok/key.test.ts`                                                                                 | 16 bestanden                                    |
| Gezielte OpenRouter-Regressionstests (Pool, Assignments, Comparison, Metadata, Proxy, Stream-Recovery, Reasoning, Budget, Calibration, Netzwerk) | bestanden; siehe Session-Ausgabe vom 2026-10-30 |

Ein erster Lauf des Service-Tests ohne `OPENCODE_ARENA_MONGODB_URI` schlug erwartungsgemäß wegen fehlender Testdatenbank fehl; mit lokaler MongoDB waren alle 12 Tests in `service.test.ts` grün. Ein vollständiger Battle im Electron-Stack wurde nicht durchgeführt. Die Änderungen wurden formatiert, sind aber nicht als Release verifiziert. Ein Commit ändert diesen Abnahmestatus nicht.

### Nächste Schritte für die Folgesession

1. `git status --short` prüfen und den eingecheckten Stand mit diesem Abschnitt abgleichen.
2. Zuerst Adapter-/Assignment-Lücken beheben und Tests ergänzen: OpenRouter-Responses-Pfade explizit ausschließen/unterstützen, Replay-/Streamverhalten, tatsächliche Reasoning-Weitergabe, Tool- und Bildverhalten; insbesondere keinen Retry oder Anbieter-Fallback hinzufügen.
3. Credential-/RPC-Schema, Storage-Migration und Host-Zustellung vollständig testen. Die aktuelle Renderer-Übertragung bei Verbindungen und die Providerwahl dürfen Keys nicht an ungewählte Remote-Hosts verteilen. Migration erst nach atomarem Zielschreiben bereinigen.
4. Discovery vertikal implementieren: validierter Katalog, `/api/show`-Metadaten mit begrenzter Parallelität, Snapshot/Refresh, Generation-Races und Fehlererhalt. Statische Poolwerte nicht als automatische Modellerkennung ausgeben.
5. Rollen-/Konfigurationsvertrag und private Assignments ergänzen; `medium` und Hilfsaufrufe über Ollama laufen lassen. Model identities/Secrets dürfen nicht vor der Abstimmung leaken.
6. Einstellungen auf Konfigurationsmodell, Katalogzustände, Eignung und explizite kostenpflichtige Modellprüfung umstellen.
7. Mit erneuter ausdrücklicher Freigabe den vollständigen Electron-Stack testen: zwei parallele Contestants, Tools, Vision, Vote/Übernahme/Folgefrage, Neustart und Beleg „kein OpenRouter-Verkehr“. Hosted-Pfad unverändert halten.
8. Format, Lint, Typecheck und nur betroffene Tests erneut ausführen; danach die Tabelle und offenen Punkte aktualisieren.

Der Test-Key ist eine Laufzeitvoraussetzung, kein Repository-Artefakt. Nicht in Befehlsargumente, Logs, Fixtures oder Dokumentation kopieren.

## 1. Ziel

Ein lokaler BYOK-Build von Agent Duel soll ausschließlich mit einem eigenen Ollama-Cloud-Key arbeiten können. Er erkennt angebotene Cloud-Modelle automatisch und lässt den Nutzer geeignete Modelle in den Einstellungen freigeben.

Zum Umfang gehören Battles, Einzelchat, Vergleichszusammenfassungen, Titel, Commit-/PR-Texte, Kontextverkürzung und Modellaufrufe von Unteragenten. Für keinen dieser Pfade darf zusätzlich ein OpenRouter-Key nötig sein.

OpenRouter bleibt als bestehender BYOK-Anbieter erhalten. Die offizielle gehostete Variante behält ihre Authentifizierung, Routen, Modellzuweisung und Forschungssynchronisierung.

Nicht im Umfang: lokale Ollama-Server, frei konfigurierbare API-URLs, ChatGPT-/Claude-Abos, neue Agent-Prozesse, gemischte Anbieter innerhalb eines Battles, Modellwahl pro Battle, Kosten-Dashboards und automatischer Anbieterwechsel bei Fehlern.

## 2. Ausgangslage

Der heutige BYOK-Pfad ist durchgehend OpenRouter-spezifisch:

| Bereich          | Einstiegspunkt                                                                              | Konsequenz                                                                |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Renderer         | `packages/app/src/byok/key.ts`, `key-section.tsx`                                           | Ein Schlüssel, keine Anbieterauswahl                                      |
| Desktop          | `packages/desktop/src/features/encrypted-storage.ts`, `src/preload.ts`                      | Verschlüsselter OpenRouter-Key und IPC-Brücke                             |
| Wire-Protokoll   | `packages/protocol/src/arena/rpc-schemas.ts`                                                | `arena.byok.*` beschreibt nur Schlüssel/Status                            |
| Client/Daemon    | `packages/client/src/daemon-client.ts`, `packages/server/src/server/session.ts`             | Hand-over und RPC-Verarbeitung                                            |
| Daemon-Zugang    | `packages/server/src/server/accounts/byok.ts`, `credentials.ts`                             | Schlüssel nur im Speicher; Wechsel kann Arena neu starten                 |
| Arena-Start      | `packages/server/src/server/agent/providers/opencode/server-manager.ts`                     | Einmaliger Credential-Transfer über stdin                                 |
| Engine           | `arena-backend/packages/opencode/src/arena/credentials.ts`, `backend.ts`, `runtime.ts`      | Lokaler Service mit OpenRouter-Key und festem Pool                        |
| Modellzuweisung  | `arena-backend/packages/arena-service/src/pool.ts`, `default-pool.ts`, `assignments.ts`     | OpenRouter-Katalog, festes Medium-Modell, private Modellprofile           |
| Inferenz         | `arena-backend/packages/arena-service/src/openrouter.ts`                                    | Festes Ziel, Routing-/Cache-/Reasoning-Felder von OpenRouter              |
| Hilfsmodelle     | `arena-backend/packages/arena-service/src/utility-model.ts`, `comparison.ts`, `metadata.ts` | Zusätzliche fest eingebaute OpenRouter-Aufrufe                            |
| Transportgrenzen | `arena-backend/packages/opencode/src/arena/model-profile.ts`, `proxy.ts`                    | Neutrale Platzhalter mit großen Kontextfenstern und erzwungenem Reasoning |

Ein bloßes Austauschen der Basis-URL reicht deshalb nicht.

## 3. Produktentscheidungen

### Anbieter und Rollen

- Pro Daemon ist genau ein BYOK-Anbieter aktiv: OpenRouter oder Ollama Cloud.
- Die Auswahl gilt für nachfolgende Arbeit. Laufende oder noch unaufgelöste Battles werden nicht umkonfiguriert.
- Der Nutzer wählt in den Einstellungen einen Battle-Pool mit mindestens zwei unterschiedlichen, geeigneten Modellen, ein Einzelchat-Modell und ein Hilfsmodell. Ein Modell darf mehrere Rollen übernehmen.
- Bestehende Größen-/Rollenbezeichnungen bleiben erhalten; insbesondere darf „Medium“ nicht heimlich weiter ein OpenRouter-Modell aufrufen.
- Die zufällige, verblindete Auswahl innerhalb des freigegebenen Battle-Pools bleibt bestehen.
- Neue Katalogeinträge werden angeboten, aber nie automatisch in den aktiven Pool übernommen.

### Bildfähigkeit

Die bestehende Arena verlangt Bild- und Tool-Unterstützung für jeden Battle-Kandidaten. Diese Bedingung bleibt bestehen. Falls sich keine zwei passenden Ollama-Cloud-Modelle nachweisen lassen, ist die Battle-Abnahme blockiert. Ein Text-only-Modus wäre eine separate Produktentscheidung, keine beiläufige Fehlerbehebung.

Reine Textmodelle dürfen für reine Text-Hilfsaufgaben angeboten werden. Beim Einzelchat müssen Modellfähigkeiten auch für Bilder im bisherigen Verlauf und Tool-Ergebnisse berücksichtigt werden; nur den aktuellen Prompt zu prüfen genügt nicht.

### Änderungen während aktiver Arbeit

Einrichtungsentwürfe, Katalogabfrage und ausdrücklich gestartete Tests dürfen bestehende Arbeit nicht verändern. Das Anwenden einer anderen aktiven Konfiguration wird verweigert, solange Arena noch arbeitet oder ein Battle nicht aufgelöst ist. Die UI nennt den Grund. Kein implizites Stoppen oder Neustarten aus einem Refresh heraus.

## 4. Automatische Modellerkennung

1. Der Daemon lädt beim ersten Einrichten den Katalog über `GET https://ollama.com/api/tags`.
2. Er validiert, normalisiert und dedupliziert die Antwort. API-Modellnamen bleiben unverändert; lokale `:cloud`-Aliasse werden nicht konstruiert.
3. Er ergänzt Fähigkeiten und Limits aus tatsächlich verfügbaren Cloud-Metadaten. Die Cloud-Verfügbarkeit von `/api/show` ist zuerst zu prüfen, nicht aus der lokalen API-Dokumentation abzuleiten.
4. Fehlen Angaben, bleibt der Eintrag sichtbar, aber ungeprüft. Ein kleines, versioniertes Register belegter Modelldaten kann Lücken schließen. Keine geratenen Kontextgrößen oder Fähigkeiten aus Modellnamen/Familien.
5. Für fehlende Auswahlvoraussetzungen steht ein expliziter Prüfablauf bereit. Inferenzprüfungen starten nur auf Nutzeraktion mit Hinweis auf mögliche Kosten.

Die Implementierung unterscheidet getrennt:

- **Katalog:** von Ollama angeboten oder zuletzt gesehen; Aktualisierungszeitpunkt.
- **Metadaten:** vorhanden, unvollständig oder widersprüchlich; Quelle der Angaben.
- **Zugriff:** noch ungeprüft, mit aktueller Credential-Generation bestätigt oder fehlgeschlagen.
- **Eignung pro Rolle:** geeignet, ungeprüft oder mit konkretem Grund ausgeschlossen.

Diese Dimensionen nicht in einem einzigen `available`-Boolean zusammenfassen. Ein erfolgreicher Textaufruf bestätigt weder Tools noch Vision oder sämtliche Kontextlimits.

### Cache und Lebenszyklus

- Ein gemeinsamer Katalog-Snapshot pro Host/Anbieter, begrenzte parallele Detailabfragen und Zusammenführung gleichzeitiger Refreshes.
- Nach dem ersten Laden nur explizit über „Modelle aktualisieren“ erneut abfragen; kein Polling, Focus-Refresh oder Refetch beim Öffnen der Auswahl.
- Reconnects verwenden vorhandene gültige Daten; ein kalter Prozess darf einmal laden.
- Cache-/Query-Identität berücksichtigt Host, Anbieter und die nicht geheime Credential-/Konfigurationsgeneration. Niemals den API-Key als Cache-Key verwenden.
- Ein Schlüsselwechsel verwirft alte Zugriffsnachweise. Späte Antworten einer alten Generation überschreiben keine neueren Daten.
- Ein fehlgeschlagener Refresh behält die letzte erfolgreiche Liste und gespeicherte Auswahl, zeigt aber Fehler und Alter der Daten.
- Verschwundene Modelle werden als nicht mehr angeboten markiert. Kein stilles Ersetzen oder Entfernen aus dem gespeicherten Pool. Neue Arbeit mit einem ungültigen Pool scheitert vor der Auslosung.

## 5. Technischer Zuschnitt

### A. Daemon und Konfigurationsvertrag

Den BYOK-Vertrag um Anbieter, Rollen und Modellprofile erweitern. Öffentlicher Status, nicht geheime Auswahl und geheime Zugangsdaten bleiben getrennt. Fachliche Zustände an den Grenzen mit Schemas validieren und intern aus den Schemas ableiten.

Discovery gehört in den Daemon, damit sie vor einem einsatzfähigen Arena-Start funktioniert. Der npm-Workspace importiert dafür keine internen Bun-Module aus `arena-backend`. Die Wire-Daten zur Engine werden auf beiden Seiten validiert; die getrennten Paketgraphen bleiben bestehen.

RPCs für Konfiguration, Kataloglesen, expliziten Refresh und kostenpflichtige Modellprüfung erhalten korrelierte `.request`/`.response`-Paare gemäß `docs/rpc-namespacing.md`. Namen und Payloads vor Implementierung zusammen festlegen. Bestehende Caller/Handler im selben Change migrieren; keine Altclient-Kompatibilitätsschicht.

### B. Schlüssel und bestehende Daten

- Electron speichert den Key verschlüsselt mit dem bestehenden Mechanismus. Ist sichere Speicherung nicht verfügbar, explizit fehlschlagen, nicht Klartext speichern.
- Die aktuelle Renderer-Übergabe darf den Key kurzzeitig zur Zustellung halten; ihn nicht in sichtbare Formzustände zurückladen oder über Status-RPCs ausgeben.
- Der Daemon hält Zugangsdaten nur im Speicher und übergibt sie der Engine über die bestehende Startup-Pipe. Kein Key in argv, Projektdateien, Logs oder Umgebungen von Contestant-Kommandos.
- Neue RPCs und IPCs in die bestehende Payload-Redaktion aufnehmen, insbesondere `packages/server/src/server/websocket-server.ts`.
- Bestehende verschlüsselte OpenRouter-Daten idempotent in das neue Speicherformat übernehmen. Erst nach erfolgreichem atomarem Schreiben den alten Speicher bereinigen. Bei Fehlern bleibt der alte Key nutzbar; keine Migration in Shell-Ausgaben prüfen.
- Den Browser-QA-Speicher als ungeschützten Testpfad behandeln, nicht als Produktionslösung.
- Keine neuen Ollama-Zugangsdaten stillschweigend an sämtliche verbundenen Remote-Hosts verteilen. Zustellung muss auf den ausdrücklich ausgewählten Host begrenzt sein; die bestehende OpenRouter-Migration gesondert testen.

### C. Inferenzadapter

Eine kleine gemeinsame Schnittstelle an der tatsächlich variierenden Provider-Grenze einführen. OpenRouter-spezifisches Routing und Caching bleiben im OpenRouter-Adapter. Ollama übersetzt nur nachgewiesen unterstützte Felder und normalisiert Antworten in den vorhandenen neutralen Arena-Transport.

Der bestehende OpenRouter-Service ist auch eine Abhängigkeit des privaten Control-Plane-Repositories. Dessen bisherige Exports, Defaults und HTTP-Verhalten erhalten; neue BYOK-Komposition ohne zwingenden privaten Folge-Deploy ermöglichen.

Für den ersten Ollama-Pfad Chat Completions bevorzugen, sofern der vollständige Tool-Zyklus damit funktioniert. Vorher prüfen, welche Engine-Pfade tatsächlich `/responses` benötigen. Diese Pfade entweder korrekt unterstützen oder bereits bei der Profilfreigabe ausschließen. Niemals Responses-Daten ungeprüft als Chat Completions weiterleiten. Ollamas Responses-API ist zustandslos und kein Ersatz für fremde serverseitige Konversationen.

### D. Rollen und Kontext

- `mediumModel` und `utilityModels` dürfen den Ollama-Pfad nicht mehr steuern; Rollen kommen dort aus der gespeicherten Konfiguration.
- Alle Aufrufstellen für Vergleich, Metadaten, Titel, Compaction und Unteragenten inventarisieren und auf den aktiven Anbieter zurückführen.
- Reasoning anhand des Modellprofils abbilden; nicht pauschal `high`/`xhigh` erzwingen.
- Bewiesene Eingabe-/Ausgabegrenzen in Budgetierung und Compaction verwenden. Die großen neutralen Platzhalterfenster sind keine Zusage für ein Ollama-Modell.
- Falls die Engine eine gemeinsame öffentliche Capability-Hülle benötigt, diese konservativ für den aktiven Pool bilden, ohne die gezogene Modellidentität preiszugeben. Die private Route erzwingt trotzdem die tatsächlichen Limits.
- Fehlenden Tokenverbrauch oder Preise als unbekannt ausweisen, nicht als null oder als OpenRouter-Kosten.

### E. Zuweisungen und gespeicherte Historie

Private Zuweisungen halten Anbieter, exaktes Modellprofil und Konfigurationsrevision stabil. Secrets gehören nicht in Assignment-Dokumente, SQLite-Transkripte oder Artefakte.

Alte gespeicherte OpenRouter-Zuweisungen bleiben lesbar. Wenn das neue Format einen Anbieter benötigt, alte Datensätze gezielt als OpenRouter migrieren/decodieren; das ist Datenmigration, kein Erlaubnis-Fallback für Inferenz. Für eine Wiederaufnahme mit inzwischen anderem Anbieter den konkreten Konflikt anzeigen, nicht neu auslosen.

## 6. Fehler- und Sicherheitsverhalten

- Nur fest erlaubte HTTPS-Ziele bei Ollama ansprechen. Keine benutzerdefinierten URLs oder Credential-Weiterleitung über fremde Redirect-Ziele.
- Unterschiede zwischen Schlüsselproblemen, Modellzugriff, fehlenden Fähigkeiten, Kontextfehlern, Limitierung und Netzfehlern erhalten.
- Vor der Auslosung konkrete Einrichtungsfehler erklären; innerhalb eines verblindeten Battles modellneutrale Fehlermeldungen ausgeben.
- Wiederholungen sind begrenzt und abbrechbar. `Retry-After` berücksichtigen, wenn vorhanden. Keine automatische Neugenerierung nach bereits begonnenem Stream und kein Anbieterwechsel bei 429/5xx.
- Gespeicherte Verläufe bleiben bei allen Providerfehlern lesbar. BYOK erzeugt weiterhin keine Research-Uploads.
- Bestehende Worktree-Isolation ist keine Secret-Sandbox: Contestants laufen als derselbe Nutzer. Die Erweiterung darf keine stärkere Sicherheitsgarantie behaupten als die bestehende Anwendung.

## 7. Umsetzung in überprüfbaren Etappen

Jede Etappe wird vertikal umgesetzt: ein Verhaltensfall, gezielter Test, Implementierung, Prüfung. Kein paralleles Umschreiben aller Schichten ohne lauffähigen Zwischenstand.

| Etappe                 | Arbeit                                                                                         | Fertig, wenn                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1. Kompatibilität      | Cloud-Katalog, Metadaten, echte Modellnamen, Streaming-/Tool-/Vision-Zyklus und Grenzen prüfen | Belegte Modellmatrix; unbekannte Angaben und Blocker ausdrücklich erfasst                  |
| 2. Discovery           | Daemon-Katalogservice, Snapshot, Refresh und öffentliche RPCs                                  | Erster Abruf, warmer Cache, Fehlererhalt und Generation-Races verhaltensgetestet           |
| 3. Konfiguration       | Storage-Migration, Rollen, Host-Bindung, Startup-Payload und Validierung                       | Bestehender OpenRouter-Key funktioniert weiter; neue Schlüssel werden korrekt isoliert     |
| 4. Ollama-Inferenz     | Provider-Adapter und ein vollständiger Einzelchat-Tool-Zyklus                                  | Text → Tool → Ergebnis → Antwort einschließlich Stop funktioniert                          |
| 5. Vollständige Arena  | Pool, private Assignments, Kontext, Vergleich, Metadaten und Unteragenten                      | Battle bis Folgefrage ohne OpenRouter-Verkehr möglich                                      |
| 6. Einstellungen       | Formularmodell, Katalogansicht, Auswahl, Prüfung und Fehlerzustände                            | Nutzer kann konfigurieren, prüfen, speichern und aktualisieren, ohne Entwürfe zu verlieren |
| 7. Regression und Doku | Desktop-/Browser-QA, bestehender OpenRouter-Pfad und persistente Historie                      | Abnahmematrix erfüllt; Lücken und Live-Testfreigaben dokumentiert                          |

Etappe 1 enthält nur nach ausdrücklicher Freigabe kostenpflichtige Cloud-Inferenz. Ohne Key/Freigabe bleiben diese Nachweise offen; keine erfolgreichen Tests behaupten.

## 8. Test- und Abnahmematrix

### Automatisierte Verträge

- Katalog: gültig, leer, doppelte IDs, unbekannte Felder, ungültige Antwort, Timeout und Teilfehler bei Details.
- Lebenszyklus: kalter Abruf genau einmal, warme Reads ohne Netz, expliziter Refresh, letzter Snapshot bei Fehler, keine Überschreibung nach Key-/Hostwechsel.
- Auswahl: weniger als zwei Battle-Modelle, fehlende Tools/Vision, ungültige Rollen, verschobenes Modell und stabile Labels während Refresh.
- Secrets: verschlüsseltes Schreiben, fehlende sichere Speicherung, wiederholbare Altformatmigration, redigierte RPC-Logs, isolierte Zustellung und saubere Child-Umgebung.
- Inferenz: fragmentierte Tool-Argumente, mehrere Tool-Aufrufe, Reasoning-Roundtrip, Nutzungsdaten, Kontextverkürzung, 401/403/404/429/5xx, Abbruch und Streamabbruch ohne Doppelgenerierung.
- Arena: stabile private Zuweisung, keine Identitätslecks vor Abstimmung, Enthüllung danach, Vote/Tie/Stop/Folgefrage sowie Unteragenten mit gleicher Anbieterbindung.
- Regression: bestehende OpenRouter-Defaults, keine notwendige Änderung am privaten Hosted-Aufrufer, alte Historie und keine Research-Uploads im BYOK-Betrieb.

### Prüfung mit echten Abhängigkeiten

Gezielte Tests verwenden echte temporäre Dateien und die vorhandene lokale Datenbank. Injizierbare Adapter für reproduzierbare Fehler sind zulässig; sie ersetzen keinen echten Ollama-Kompatibilitätsnachweis.

Mit freigegebenem Test-Key im vollständigen Electron-Stack nachweisen:

1. Erstkonfiguration zeigt automatisch echte Cloud-Modelle an.
2. Ein qualifizierter Pool und die übrigen Rollen lassen sich speichern.
3. Zwei Modelle arbeiten parallel und führen Tools aus.
4. Vergleich, Abstimmung, Übernahme und Folgefrage funktionieren.
5. Bilder funktionieren für den freigegebenen Pool.
6. App-/Daemon-Neustart stellt Auswahl und sicheren Key-Zugang wieder her.
7. Fehler bleiben in der UI sichtbar und behebbar; Refresh verändert keine laufende Arbeit.
8. Ein reiner Ollama-Durchlauf erzeugt keine OpenRouter-Anfrage. Nachweis durch redigierte Transport-/Request-Beobachtung, nicht durch das Vorhandensein eines Adapter-Tests.
9. OpenRouter bleibt separat nutzbar. Gehostete Verträge sind unverändert; ein nicht durchgeführter Hosted-Live-Test wird als offen markiert.

Format, Lint, Typecheck und nur betroffene Testdateien nach den Repository-Regeln ausführen. Konkrete Befehle stehen in der Agenten-Anleitung.

## 9. Projektdokumentation bei der späteren Umsetzung

Diese beiden Plan-Dateien sind kein bereits geltender Projektstandard. Nach Implementierung:

- In `docs/arena.md` den bestehenden BYOK-Abschnitt und betroffene Pool-/Anbieterregeln integrieren, nicht unten eine zweite Erklärung anhängen.
- Eine fokussierte `docs/byok.md` für Einrichtung, Anbieterwahl, automatische Discovery und bekannte Anbietergrenzen anlegen; von `docs/README.md` und `CLAUDE.md` verlinken. Alternativ vor Anlage prüfen, ob ein inzwischen vorhandenes Fach-Dokument den Bereich bereits besitzt.
- README-Voraussetzungen sowie die BYOK-Aussagen in `docs/development.md` und `docs/deployment.md` korrigieren und für Details auf das Fach-Dokument verweisen.
- Technische Parser-/Adapterdetails bei ihrem Code dokumentieren. Keine zukünftigen oder ungeprüften Fähigkeiten als bestehendes Verhalten veröffentlichen.

## 10. Noch zu verifizierende Punkte

- Liefert die direkte Cloud alle benötigten Modellmetadaten? Sind mindestens zwei Modelle für die bestehende Bild-/Tool-Anforderung geeignet?
- Welche Reasoning-, Tool- und Kontextparameter akzeptieren diese konkreten Modelle in Kombination mit dem Arena-Systemprompt?
- Benötigt ein aktiver Engine-Pfad Responses-spezifische Funktionen, die Ollama nicht unterstützt?
- Welche Limits gelten praktisch für zwei parallele Contestants und gleichzeitige Hilfsaufrufe auf dem vorgesehenen Konto?

Diese Punkte blockieren die jeweilige Freigabe, nicht die Dokumentation des Plans. Sie werden nicht durch geschätzte Werte oder einen versteckten OpenRouter-Fallback übergangen.

## Quellen

- [Ollama Cloud: Katalog und direkte Modellnamen](https://docs.ollama.com/cloud)
- [Ollama Authentifizierung](https://docs.ollama.com/api/authentication)
- [OpenAI-Kompatibilität und Einschränkungen](https://docs.ollama.com/api/openai-compatibility)
- [Modellinformationen; Cloud-Verfügbarkeit separat verifizieren](https://docs.ollama.com/api/show)
- Lokale maßgebliche Regeln: `CLAUDE.md`, `docs/arena.md`, `docs/architecture.md`, `docs/forms.md`, `docs/testing.md`, `docs/qa.md` und `docs/rpc-namespacing.md`.
