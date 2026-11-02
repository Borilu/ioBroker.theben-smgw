# Theben CONEXA 3.0 Smart Meter Gateway

This beta adapter reads the local HAN HTTPS/JSON M2M interface of a [Theben CONEXA 3.0 smart meter gateway](https://www.theben.de/service/fachpresse/sicherer-rollout-theben-erhaelt-bsi-zertifizierung-fuer-das-smart-meter-gateway-conexa-3-0-performance/). It uses HTTP Digest authentication and does not depend on Home Assistant or a cloud service. It has been tested with a local mock server and one CONEXA 3.0 installation; other gateway configurations and firmware versions remain unverified.

[German documentation](docs/de/README.md)

This is a beta release and is not yet part of the official ioBroker adapter repository. The npm package is `iobroker.theben-smgw`.

## Setup

1. Ensure the ioBroker host can reach the gateway's HAN address. If networks overlap, check the precise route to the gateway and adapt the host's networking to the actual environment.
2. Install the adapter and create an instance in ioBroker. If your Admin version supports installing from a local package, the corresponding option is available in the adapter installation dialog.
3. Enter the gateway address or hostname, HTTPS port, HAN username and password supplied by the gateway operator. Enter the password only in the ioBroker password field; do not put it in commands or logs. ioBroker encrypts and protects the field using `encryptedNative` and `protectedNative`.
4. Leave the optional M2M path empty to use `/smgw/m2m/<HAN-username>.sm/json`. If your operator supplies a different path, enter a relative path under `/smgw/m2m/`; requests remain on the configured gateway.
5. Configure server identity verification as described below. Pause other integrations polling the same account before testing, to avoid simultaneous requests and a possible gateway lockout.
6. Start the instance. Under **Objects**, inspect `theben-smgw.0.info.connection` and `theben-smgw.0.profiles`. The log provides status information without printing the password.
7. For additional credentials, create a separate adapter instance for each account. Do not poll the same credentials simultaneously from several instances.

## Gateway certificate verification

The standard certificate-chain and hostname check is enabled by default when the fingerprint field is empty. A self-signed certificate or a certificate not valid for the configured address will be rejected.

Alternatively, enter the server certificate's **SHA-256 fingerprint confirmed through an independent trusted channel**. A configured fingerprint takes precedence over the standard verification checkbox: the adapter checks the exact certificate and its validity period, but does not additionally verify its CA chain or hostname. Each new TLS connection is checked before any request or Digest authentication header is sent. A mismatch or expired certificate terminates the connection.

Ask the gateway operator to confirm the fingerprint or certificate through an independently trusted channel. A fingerprint obtained solely over the unchecked connection does not prove the gateway's identity. When the gateway certificate is renewed, independently confirm and configure its new fingerprint.

If neither a fingerprint nor the standard check is enabled, the TLS connection remains encrypted but the peer's identity is not verified. An incorrectly formatted fingerprint causes an error; the adapter does not silently fall back to another mode. Existing configurations without a fingerprint keep their previous behavior.

## Readings and datapoints

The adapter discovers usage points using `user-info`. It processes profiles with status `running`, plus profiles without a status, individually and sequentially: it requests `usage-point-info` for channel metadata and then `readings` for the latest origin reading. Profiles known not to be running are skipped; the `status` of an already discovered profile is updated. Reading signatures are not verified.

Each account can access only profiles made available by the meter operator. The adapter cannot enable missing meters or feed-in channels.

Objects are created under `profiles.p_<id>.c_<id>`; the identifiers are stable hashes of the usage-point ID and OBIS code. Each profile provides `usagePointId`, `taf` and `status`. Each channel provides `obis`, `meter`, `raw` and `captureTime`, plus `scaler` and `unitCode` when metadata is available. OBIS codes `0100010800ff` and `0100020800ff` are named import 1.8.0 and export 2.8.0; other returned codes are also exposed.

The numeric `value` is created only when the scale and unit are supported and the raw number fits the safe numeric range. It is calculated as **raw value × 10^scaler**. Unit code 30 means Wh and 26 means J. If metadata is missing or unsupported, the raw reading remains available and an older scaled value is set to `null`. If the metadata request fails, the adapter still attempts to fetch raw values, but marks `info.connection` false.

ioBroker numbers are floating-point values. For exact traceability, retain `raw` together with `scaler` and `unitCode`. If a channel disappears or a profile becomes inactive, earlier objects and values remain: check the profile status, `captureTime` and `info.connection` before using them.

The first poll occurs at startup, with subsequent polls no sooner than 15 minutes after the preceding poll finishes. These are not live power readings: the gateway typically provides new energy readings every 15 minutes. A failed profile is logged and sets `info.connection` false even if another profile succeeded.

## Development and testing

Requires Node.js 22 or newer, js-controller 6.0.11 or newer and Admin 7.6.20 or newer. Run `node --test test/*.test.js` from the adapter directory for local tests, including mocked profile processing and an HTTPS/Digest test server. The test certificate and key are synthetic fixtures, not gateway credentials. The repository also contains ioBroker package and integration tests.

The implementation is informed by the [Home Assistant Theben CONEXA integration](https://www.home-assistant.io/integrations/theben_conexa/) and its [Python client library](https://gitlab.com/michael.dluhosch/theben-conexa-smgw). The library obtains `scaler` and `unit` from `usage-point-info`. Unlike the library, this adapter processes all active profiles. The default M2M path has been tested with one gateway; other configurations have not yet been verified.

## Changelog

### 0.3.2

- Improve release verification for the official ioBroker repository.

### 0.3.1

- Improve documentation, adapter metadata and compatibility with the official ioBroker repository checks.

### 0.3.0

- First public beta with local M2M readings, multiple instances, clear certificate verification settings, optional certificate pinning and automated tests.

## License

MIT License. See [LICENSE](LICENSE) for the full text.

Copyright (c) 2026 Borilu <borilu@fn.de> and contributors.
