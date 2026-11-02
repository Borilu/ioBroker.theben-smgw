# Theben CONEXA 3.0 für ioBroker – Testversion

Dieser Adapter liest die lokale HTTPS/M2M-Schnittstelle des Theben CONEXA 3.0. Er ist eine **Testversion**: Die Digest-Anmeldung und die Verarbeitung wurden mit einem lokalen Testserver und einem CONEXA-3.0-Gateway geprüft; andere Installationen können abweichen. Für die Inbetriebnahme muss das Gateway aus der ioBroker-Umgebung erreichbar sein.

Aktuell ist der Adapter als Beta gedacht und noch nicht Teil des offiziellen ioBroker-Adapterverzeichnisses. Das Paket ist unter `iobroker.theben-smgw` auf npm verfügbar.

## Einrichtung

1. Die ioBroker-VM muss die HAN-Adresse über das richtige Netz erreichen. Bei überlappenden Netzen insbesondere zuerst die konkrete Route prüfen. Netzwerkänderungen nur passend zur tatsächlich verwendeten VM und Netzwerkkonfiguration durchführen.
2. Das Paket in ioBroker installieren. Je nach Admin-Version ist im Adapter-Bereich unter „Installation aus eigener Quelle“ die Installation aus einer lokalen Paketdatei möglich. Alternativ ist eine Installation mit npm im ioBroker-Verzeichnis und anschließender Instanzerstellung möglich. Die genauen Schritte richten sich nach dem ioBroker-System und dem gewählten Paketformat.
3. Eine Instanz konfigurieren: die vom Betreiber mitgeteilte Gateway-IP beziehungsweise den Hostnamen, HTTPS-Port, HAN-Benutzernamen und das HAN-Passwort lokal im Passwortfeld eintragen. Das Passwort nicht in Befehle oder Logs kopieren. ioBroker verschlüsselt und schützt das Passwortfeld über `encryptedNative` und `protectedNative`. Das Feld M2M-Pfad zunächst leer lassen; dann wird der Standardpfad aus dem Benutzernamen gebildet. Falls erforderlich, kann ein anderer relativer Pfad unter `/smgw/m2m/` eingetragen werden; er wird nur auf dem konfigurierten Gateway aufgerufen.
4. Die **Standardprüfung von Zertifikatskette und Hostname** ist standardmäßig eingeschaltet und gilt, solange kein Fingerabdruck eingetragen ist. Ein selbstsigniertes oder für die konfigurierte IP ungültiges Zertifikat wird dadurch abgelehnt. Für ein Gateway mit selbstsigniertem Zertifikat kann stattdessen der **unabhängig bestätigte SHA-256-Fingerabdruck des Serverzertifikats** im dafür vorgesehenen Feld eingetragen werden. Ein eingetragener Fingerabdruck hat Vorrang: Der Adapter prüft das exakte Zertifikat und dessen Gültigkeitszeitraum, unabhängig vom Haken für die Standardprüfung. Zertifikatskette und Gateway-Hostname werden in diesem Fall nicht zusätzlich geprüft. Die Prüfung erfolgt bei jedem neuen TLS-Verbindungsaufbau, bevor Anmeldedaten oder Anfragen übertragen werden; bei Abweichung oder abgelaufenem Zertifikat wird die Verbindung abgebrochen. Der Betreiber sollte den Fingerabdruck oder das Zertifikat über einen unabhängigen vertrauenswürdigen Weg bestätigen. Ein Fingerabdruck, der lediglich über die ungeprüfte Verbindung selbst abgelesen wird, beweist die Echtheit nicht. Bei Erneuerung des Zertifikats muss der neue Fingerabdruck unabhängig bestätigt und aktualisiert werden.

   Ist weder ein Fingerabdruck hinterlegt noch die Standardprüfung eingeschaltet, bleibt die TLS-Verbindung verschlüsselt, aber die Identität der Gegenstelle wird nicht geprüft. Ein ungültig formatierter Fingerabdruck führt zu einem Fehler; es erfolgt kein Fallback auf eine andere Prüfung. Eine vorhandene Konfiguration ohne Fingerabdruck behält ihr bisheriges Verhalten.
5. Vor dem Start die Home-Assistant-Integration für denselben Zugang pausieren, um gleichzeitige Abrufe und eine mögliche Sperre des Gateways zu vermeiden. Die ioBroker-Instanz starten und unter Objekte nach `theben-smgw.0.info.connection` und `theben-smgw.0.profiles` suchen. In der Protokollansicht stehen Verbindungshinweise; das Passwort wird nicht ausgegeben.
6. Falls weitere Zugangsdaten bereitgestellt werden, eine zusätzliche Instanz für jeden Zugang anlegen. Dieselben Zugangsdaten nicht mehrfach parallel abfragen.

## Abruf und Datenpunkte

Die Nutzungsprofile werden über `user-info` erkannt. Profile mit bekanntem Status `running` sowie Profile ohne Statusangabe werden einzeln und nacheinander abgefragt: erst `usage-point-info` für Metadaten, danach `readings` für den letzten Origin-Wert. Ist der Status bekannt und nicht `running`, wird das Profil ausgelassen; der Datenpunkt `status` eines bereits zuvor erkannten Profils wird entsprechend aktualisiert. Die Signatur wird nicht auf Gültigkeit geprüft. Jeder Zugang sieht ausschließlich die Profile, die der Messstellenbetreiber dafür freigegeben hat. Fehlende Einspeisekanäle oder Zähler können nicht durch diesen Adapter freigeschaltet werden.

Die Daten liegen unter `profiles.p_<Kennung>.c_<Kennung>`. Die Kennungen werden stabil aus Usage-Point-ID und OBIS-Code abgeleitet. Jedes Profil enthält `usagePointId`, `taf` und `status`. Jeder sichtbare Kanal enthält `obis`, `meter`, `raw` und `captureTime`. Wenn vom Gateway Kanalmetadaten geliefert werden, enthält er zusätzlich `scaler` und `unitCode`. Bekannte OBIS-Codes `0100010800ff` und `0100020800ff` werden als Bezug 1.8.0 und Einspeisung 2.8.0 bezeichnet; unbekannte Codes werden ebenfalls angezeigt.

Ein numerischer Datenpunkt `value` wird nur erzeugt, wenn Skalierung und Einheit erkannt werden und der Rohwert im sicher darstellbaren Zahlenbereich liegt. Die Berechnung ist **Rohwert × 10^scaler**. Die bekannten Einheitencodes 30 (Wh) und 26 (J) werden unterstützt. Bei fehlenden oder unbekannten Metadaten bleibt der Rohwert verfügbar; ein älterer `value` wird auf `null` gesetzt. Schlägt der Metadatenabruf fehl, wird die Abfrage der Rohwerte trotzdem versucht und `info.connection` auf falsch gesetzt. Zahlen in ioBroker sind Fließkommazahlen: Für die exakte Nachvollziehbarkeit den Rohwert zusammen mit `scaler` und `unitCode` verwenden. Zeigt das Gateway einen Kanal später nicht mehr an oder ist dessen Profil nicht mehr aktiv, bleiben bisherige Objekte und Werte bestehen; deshalb immer auch Profilstatus, `captureTime` und `info.connection` beachten.

Die Abfrage erfolgt beim Start und anschließend frühestens 15 Minuten nach Abschluss der letzten Abfrage. Keine Echtzeitwerte: Das Gateway liefert typischerweise nur alle 15 Minuten neue Messwerte. Fehler pro Profil werden protokolliert; sind Profile fehlgeschlagen, ist `info.connection` falsch, auch wenn andere Profile erfolgreich gelesen wurden.

## Technische Voraussetzungen und Test

Node.js ab Version 22, js-controller ab 6.0.11 und Admin ab 7.6.20. Für den unabhängigen Code-Test im entpackten Adapter-Verzeichnis `node --test test/*.test.js` ausführen. Das Testzertifikat und der Testschlüssel im Ordner `test` dienen nur dem lokalen Testserver und sind keine Zugangsdaten des Gateways.

Die Implementierung orientiert sich an den veröffentlichten Schnittstelleninformationen der [Theben-Conexa-Home-Assistant-Integration](https://www.home-assistant.io/integrations/theben_conexa/) und der [zugehörigen Python-Bibliothek](https://gitlab.com/michael.dluhosch/theben-conexa-smgw). Die Bibliothek liest `scaler` und `unit` über `usage-point-info`; Einheit 30 steht für Wh, 26 für J. Anders als die Bibliothek fragt dieser Adapter alle aktiven Profile ab. Der direkte M2M-Pfad `/smgw/m2m/<HAN-Benutzername>.sm/json` wurde mit einem Gateway getestet; andere Gateway-Konfigurationen wurden nicht geprüft.

## Changelog

### 0.3.1

- Dokumentation, Adapter-Metadaten und Kompatibilität mit den Prüfungen des offiziellen ioBroker-Verzeichnisses verbessert.

### 0.3.0

- Erste öffentliche Betaversion mit lokaler M2M-Auslesung, mehreren Instanzen, Zertifikatsprüfung und automatisierten Tests.

## Lizenz

MIT-Lizenz. Copyright (c) 2026 Borilu <borilu@fn.de> und Mitwirkende. Der vollständige Lizenztext steht in [LICENSE](../../LICENSE).
