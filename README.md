# Battlelands Royale Private Server

A self-hosted Node.js backend for a Battlelands Royale client. The game-facing API follows a selected subset of PlayFab Client and Authentication request conventions. PostgreSQL stores persistent player, inventory, economy, session, and administrative data. Redis handles session and queue state. Nginx provides the public HTTPS reverse proxy.

This repository is configured around Battlelands-specific data and game behavior. It is not the official PlayFab service and does not provide a complete implementation of every PlayFab API.

## 1. How the backend fits the game

The Battlelands client sends HTTP API requests to a configured service origin. This backend receives those calls under `/Client/*` and `/Authentication/*`, validates the configured Title ID during login, creates or retrieves player records, issues session tickets, and serves the player, inventory, economy, catalog, store, title-data, leaderboard, friend, and CloudScript operations implemented by the project.

The client and server must agree on both values:

- The API origin configured in the game client, for example `https://YOUR_DOMAIN`.
- The Title ID sent in the login request. The known Battlelands client configuration used by this project is `299E`.

Changing the backend's `TITLE_ID` does not rewrite the value inside the game client. The client must send the same Title ID that the server expects.

## 2. Architecture

| Component | Responsibility |
|---|---|
| Node.js 20 / Express | Battlelands-oriented Client API, Authentication API, admin API, game services, and background work |
| PostgreSQL 16 | Accounts, sessions, inventories, virtual currencies, player data, statistics, friends, stores, catalog, events, and related records |
| Redis 7 | Session lookup cache and queue/job state |
| Nginx | Public HTTP/HTTPS entry point and reverse proxy |
| Metabase | Database exploration and reporting interface |
| Prometheus | Application metrics collection |
| Grafana | Metrics dashboards |
| Optional Discord bot | Discord account-linking and moderation integration when configured and enabled |

The application listens on port `3000` inside the Docker network. Nginx publishes ports `80` and `443` on the host. PostgreSQL and Redis are not published as public host ports by the default Compose file.

### Request flow

```text
Battlelands client
        | HTTPS request to its configured API origin
        v
DNS hostname -> server public IP
        | TCP 443
        v
Nginx reverse proxy
        | internal HTTP request
        v
Node.js / Express API
        |                  |
        v                  v
PostgreSQL             Redis
(player and game       (session and
 records)              queue state)
```

The backend does not change the destination address inside the game. The client must be configured to use this server, and the server must implement the methods and response fields that the Battlelands build actually requests.

## 3. Requirements

Recommended deployment environment:

- Ubuntu Server 22.04 or 24.04, or another Linux distribution supported by Docker Engine.
- Docker Engine.
- Docker Compose plugin (`docker compose`).
- OpenSSL and Python 3 on the host; the startup script uses them for certificate and secret generation.
- A DNS hostname whose A/AAAA record resolves to the server's public IP address.
- Host firewall rules and any cloud-provider firewall rules permitting inbound TCP ports `80` and `443`.
- The Battlelands Title ID expected by the client; for the known client build, use `299E`.
- A Photon App ID only when the game expects Photon configuration in title data.

Node.js 20 or later is required on the host only when running source checks or the application outside Docker. The application container is based on Node.js 20.

## 4. First deployment

Clone or upload the repository to the Linux host, enter the repository directory, and run:

```bash
chmod +x start.sh
./start.sh
```

On the first run, the script asks for:

- `TITLE_ID`: enter `299E` for the known Battlelands client build. Use the value actually sent by the client if working with a different build.
- `DOMAIN`: enter the public hostname only, without `https://` and without a URL path. For example, enter `battlelands.duckdns.org`, not `https://battlelands.duckdns.org`.
- The administrator email address.
- An optional `PHOTON_APP_ID`.

The script generates the PostgreSQL password, session secret, administrator password, TOTP secret, and Grafana password. It writes the values to `.env` and restricts that file's permissions. Save the generated credentials securely before closing the terminal.

When no TLS certificate exists, the script creates a self-signed certificate under `nginx/certs/`. This is suitable only for initial testing. Browsers and game clients will not automatically trust it. Install a valid certificate for the public domain before production use.

After the Compose stack is started, verify application readiness rather than relying only on container state:

```bash
docker compose ps
docker compose logs --tail=100 app
curl -k https://localhost/health
```

Use `curl -k` only for local testing with the generated self-signed certificate. For a public deployment with a trusted certificate, use:

```bash
curl -i https://YOUR_DOMAIN/health
```

The health endpoint returns `status: ok` only when both PostgreSQL and Redis are reachable.

On later runs, `./start.sh` reuses the existing `.env` and does not rotate generated credentials. Do not delete or regenerate credentials on an existing installation without planning the effect on player accounts and dependent services.

### Changing the domain or TLS certificate

Set `DOMAIN` in `.env` to the same hostname configured in the game client, and make sure public DNS resolves that hostname to this server. The current startup script creates a self-signed certificate only when the certificate files are missing; changing `DOMAIN` alone does not replace an existing certificate. When changing domains, install a certificate whose names cover the new domain, or remove the old certificate pair and let the script create a new self-signed certificate for testing. Restart Nginx after replacing certificate files:

```bash
docker compose restart nginx
```

## 5. Configuration

`.env.example` documents the supported variables.

| Variable | Purpose |
|---|---|
| `TITLE_ID` | Must exactly match the Title ID sent by the client. Use `299E` for the known Battlelands build. |
| `DOMAIN` | Public hostname used for TLS and service URLs. Do not include a scheme or path. |
| `APP_NAME` | Application and admin-interface display name. |
| `POSTGRES_DB` | PostgreSQL database name. |
| `POSTGRES_USER` | PostgreSQL database user. |
| `POSTGRES_PASSWORD` | Generated PostgreSQL password. |
| `SESSION_SECRET` | Secret used to sign session/entity tokens. |
| `ADMIN_EMAIL` / `ADMIN_USERNAME` | Initial administrator identity. |
| `ADMIN_PASSWORD` | Generated initial administrator password. |
| `ADMIN_TOTP_SECRET` | Generated TOTP authenticator secret. |
| `GRAFANA_USER` / `GRAFANA_PASSWORD` | Grafana administrator credentials. |
| `PHOTON_APP_ID` | Optional value exposed through title data when configured. This repository does not host the Photon real-time networking service. |
| `SMTP_*` | Optional outbound email configuration. |
| `DISCORD_*` | Optional Discord bot configuration. |

Compose constructs the internal `DATABASE_URL` and `REDIS_URL` for the application. Keep `.env`, database dumps, TLS private keys, and generated credentials out of source control. Do not commit your local `.env` file.

## 6. How the Battlelands client connects

### When client source or settings are available

Configure the PlayFab Unity SDK with the backend origin and the Title ID used by the client:

```csharp
PlayFabSettings.TitleId = "299E";
PlayFabSettings.ProductionEnvironmentUrl = "https://YOUR_DOMAIN";
```

For the domain used in this deployment example, the URL would be:

```csharp
PlayFabSettings.ProductionEnvironmentUrl = "https://battlelands.duckdns.org";
```

Use the scheme and hostname only. Do not append `/Client`; the SDK method supplies the API path. The PlayFab SDK exposes `ProductionEnvironmentUrl` as a setting used by its URL builder. Confirm the exact initialization path in the SDK version bundled with the game.

### When the Android game is already built with Unity IL2CPP

If the source project is unavailable, inspect the exact APK before changing it. A common Unity IL2CPP Android layout contains:

```text
assets/bin/Data/Managed/Metadata/global-metadata.dat
lib/arm64-v8a/libil2cpp.so
```

The actual layout can vary by Unity version and packaging method. Do not assume that the `ProductionEnvironmentUrl` property name proves the URL is stored as a literal at a specific offset. The SDK setting can be supplied by a serialized settings asset, initialized at runtime, or represented by one or more managed string literals.

If the source project is unavailable, the Battlelands APKs used for this deployment were patched with an integrated APK-aware workflow. The recorded offsets below belong to the tested 32-bit and 64-bit Battlelands builds; they are not universal offsets for other releases or Unity games.

#### Configured Battlelands URL entries

The 32-bit and 64-bit Battlelands APKs distributed with this project are already patched to use `battlelands.duckdns.org`. The following table records the final URL values present in the supplied patched builds. These offsets belong only to the tested APK builds and are not universal offsets for other Battlelands releases or other Unity IL2CPP games.

| Metadata offset | Final value in the supplied patched build | Role |
|---|---|---|
| `0x22DA6` | `@battlelands.duckdns.org/Client/LinkCustomID` | Custom ID account-linking endpoint string |
| `0x22F4F` | `@battlelands.duckdns.org/Client/LoginWithFacebook` | Facebook login endpoint string |
| `0x3F3E4` | `https://battlelands.duckdns.org` | Base production API origin used by the tested client build |

The successful patch run handled these three URL entries in the supplied client builds. The resulting `global-metadata.dat` measured `10,429,900` bytes and retained that size after the same-length replacement. The Title ID was not changed: the client continues to send `299E`, which must match the backend's `TITLE_ID` setting.

#### Integrated APK patch and verification workflow

The patch process is an APK transformation workflow, not a generic ZIP recompression. It processes each ABI package independently and performs the following checks and operations:

1. Open the APK and identify its ABI/build. Locate `assets/bin/Data/Managed/Metadata/global-metadata.dat` inside the APK.
2. Extract the metadata entry and inspect its current URL strings, file size, and relevant offsets. The APKs distributed below already contain `battlelands.duckdns.org` at the three offsets listed above. Stop rather than patch if the file does not match the build you are working with.
3. Replace the hostname bytes at the verified URL entries with the hostname you intend to use. A direct in-place replacement preserves the metadata layout only when the old and new hostname have the same byte length. If the length differs, use a metadata-aware patching tool that updates the related literal data and metadata references; do not force a longer or shorter string into the existing byte range.
4. Verify the patched metadata: the intended hostname appears at every required URL entry, the surrounding endpoint strings remain intact, and the metadata structure and file size are valid for the chosen patching method.
5. Put the modified metadata back at its original APK entry path, preserving the tested entry's `STORED` (uncompressed) method. Rebuild the APK as an Android application package; this is not equivalent to simply creating an arbitrary ZIP file.
6. Run APK archive-integrity and alignment checks. Align the rebuilt APK before signing it.
7. Sign the aligned APK with your signing key, then verify the resulting APK signature and certificate information with Android's APK signing tools.
8. Re-open the final signed APK and repeat the metadata, hostname, archive, alignment, and signature checks. Process 32-bit and 64-bit builds independently; do not assume that offsets from one ABI or release apply to another.

The hosted APKs below are already modified and signed for `battlelands.duckdns.org`; they are ready-made builds for that hostname, not generic templates for arbitrary domains. Anyone who wants to use a different hostname must run the inspection and patching workflow on their own APK copy, validate the new hostname, then rebuild, align, sign, and verify the result. The patching utility is separate from this backend repository; this README documents the workflow but does not claim that the utility is included in the backend source tree.

#### Distributed patched APKs

The following are the hosted files produced by the patching run. Both APKs are already configured for `https://battlelands.duckdns.org`; users deploying this same hostname do not need to patch them again. The `.bin` suffix was appended because the file-hosting platform would not accept the `.apk` extension directly. It is a filename workaround for hosting only; it does not change the APK bytes, create a different package format, or add another compression layer.

| ABI | Hosted file | Download |
|---|---|---|
| 64-bit | `patched-64bit.apk.bin` | [Download 64-bit APK](https://transfer.archivete.am/A7L6R/patched-64bit.apk.bin) |
| 32-bit | `patched-32bit.apk.bin` | [Download 32-bit APK](https://transfer.archivete.am/Heakx/patched-32bit.apk.bin) |

SHA-256 values supplied for these hosted artifacts:

| ABI | SHA-256 |
|---|---|
| 64-bit | `3d124babe56962ee604ed9ef70118711e1554e463d8381decb3e2f29440c0698` |
| 32-bit | `6d88e1967351fe0f6987f861bbde145995f43ed5567e68564af1c5ec0cbd7009` |

After downloading, rename `patched-64bit.apk.bin` to `patched-64bit.apk`, or `patched-32bit.apk.bin` to `patched-32bit.apk`, by removing only the final `.bin` suffix. Renaming does not change the file bytes, so the SHA-256 value remains the same. Verify the downloaded file against the matching hash before installing it.

The patched APKs use a different signing certificate from the original installed game. Android therefore will not install them as an in-place update over the differently signed package. Uninstall the original before installing the patched build; uninstalling can remove local application data, so back up anything important first.

The APK patch changes the service destination used by the client; it does not itself provide the API service. The backend at `battlelands.duckdns.org` must still return the API responses expected by the game. A network monitor showing a connection to this hostname on TCP 443 confirms that the client attempted to reach the configured host, not that login succeeded. To confirm game login, inspect the Nginx access log and application log, verify the requested API path and Title ID, and confirm a successful login response followed by an authenticated request.

## 7. Example client-to-server exchange

The backend checks the `TitleId` supplied in login requests against the `TITLE_ID` environment variable. The known Battlelands value is `299E`.

Login request:

```http
POST /Client/LoginWithCustomID HTTP/1.1
Host: YOUR_DOMAIN
Content-Type: application/json

{
  "TitleId": "299E",
  "CustomId": "example-installation-id",
  "CreateAccount": true
}
```

A successful response includes a session ticket and player ID:

```json
{
  "code": 200,
  "status": "OK",
  "data": {
    "SessionTicket": "SESSION_TICKET_VALUE",
    "PlayFabId": "PLAYER_ID",
    "NewlyCreated": true
  }
}
```

The client then sends the returned ticket in `X-Authorization` for protected Client API calls. For example, to request the title data configured on the server:

```http
POST /Client/GetTitleData HTTP/1.1
Host: YOUR_DOMAIN
Content-Type: application/json
X-Authorization: SESSION_TICKET_VALUE

{}
```

Other relevant calls include `GetCatalogItems`, `GetStoreItems`, `GetUserInventory`, `GetUserVirtualCurrency`, `PurchaseItem`, `ConsumeItem`, `GetPlayerStatistics`, `GetLeaderboard`, `GetFriendList`, and `ExecuteCloudScript`. The exact route list and behavior are defined in `src/routes/client.js` and `src/services/cloudscript.js`.

Successful API responses use the project's `{ "code", "status", "data" }` envelope. Error responses use `{ "code", "status", "error", "errorMessage", "errorDetails" }`. The backend uses PlayFab-style request conventions, but it is not a full PlayFab implementation.

## 8. Battlelands data files

The repository ships with empty data files so that no original title data is embedded in the source repository:

| File | Initial content | Expected structure |
|---|---|---|
| `src/data/catalog.json` | `[]` | Array of catalog item objects with unique, non-empty `ItemId` values |
| `src/data/stores.json` | `{}` | Object keyed by store ID; each value is an array of store item objects |
| `src/data/title_data.json` | `{}` | Object containing the title-data keys and values used by the game |

The original source data is supplied separately as `original-data-files.zip`. It contains `catalog.json` (575 items), `stores.json` (6 top-level store groups), and `title_data.json` (252 settings). Extract the files and copy them into `src/data/` before the first application start when restoring the original game data.

The application imports each file only when its corresponding database tables are empty. Replacing JSON files after the database has been seeded does not automatically overwrite existing records. The admin interface provides bulk JSON import for catalog and title data; manage store entries through the Stores section. For other changes, use a controlled database update and back up the database first.

The main data is stored in PostgreSQL. Catalog items are stored in `catalog_items`; store definitions and entries are stored in `stores` and `store_items`; title data is stored in `title_data`.

## 9. Battlelands features and API areas

The Client API includes handlers for:

- Login by Custom ID, Android device ID, iOS device ID, and email.
- Account information, player profile, display name, and player data.
- Catalog, stores, inventory, and virtual currency.
- Character lists, character inventory, character data, and leaderboards.
- Friends and friend requests.
- Player statistics and leaderboard queries.
- Item purchases, item consumption, loot crates, and economy events.
- Content-list and content-download URL responses backed by the admin-managed asset records.
- CloudScript functions implemented in `src/services/cloudscript.js`.

The Authentication API includes `GetEntityToken` and `ValidateEntityToken`. Some routes intentionally return simplified or empty data. For example, empty publisher data and placeholder news are not the same as implementing the full corresponding PlayFab service. Test the methods actually called by the Battlelands client before treating a feature as complete.

### Photon note

When `PHOTON_APP_ID` is configured, the backend can expose it through title data. This does not start or replace Photon servers, host real-time matches, or implement the Photon networking protocol. The game still needs its separate real-time networking service and valid configuration if its client uses Photon.

## 10. Services, updates, and backups

Useful commands:

```bash
# Start or rebuild the stack
./start.sh
docker compose up -d --build

# Inspect containers and logs
docker compose ps
docker compose logs -f app
docker compose logs -f nginx

# Run JavaScript and JSON source checks (Node.js 20 or later)
npm run check

# Back up PostgreSQL
bash scripts/backup.sh

# Enable the optional Discord bot after configuring its variables
docker compose --profile discord up -d --build
```

PostgreSQL initializes a new data volume using `scripts/init-db.sql`. The application then tracks and applies pending SQL migrations from `scripts/migrations/` through the `schema_migrations` table.

Normal updates preserve Docker volumes. Do not run `docker compose down -v` unless you intentionally want to delete PostgreSQL, Redis, and monitoring data. Backups are written under `backups/`; copy them off the host and test restoration periodically.

## 11. Security notes

- Keep `.env`, database backups, TLS private keys, and generated secrets out of Git.
- Replace the initial self-signed TLS certificate before public deployment.
- Restrict access to the administrator interface, Metabase, and Grafana.
- Expose only the required public ports.
- Use strong unique administrator credentials and protect the TOTP secret.
- Do not put server secrets or administrator credentials into the game client.
- Rotate credentials that are exposed.

## 12. Technical references

- [PlayFab Unity SDK settings example](https://github.com/PlayFab/PlayFab-Samples/blob/master/Recipes/PrizeWheel/Example-Unity3d/PrizeWheel/Assets/PlayFabSdk/Shared/Public/PlayFabSettings.cs)
- [PlayFab shared settings asset](https://github.com/PlayFab/UnitySDK/blob/master/ExampleMacProject/Assets/PlayFabSDK/Shared/Models/PlayFabSharedSettings.cs)
- [Unity discussion: IL2CPP string literals in global-metadata.dat](https://discussions.unity.com/t/const-vs-static-il2cpp-optimization/754416)
- [Example IL2CPP string-literal extraction and patching tool](https://github.com/jozsefsallai/il2cpp-stringliteral-patcher)
- [IL2CPP GlobalMetadata string-literal lookup implementation](https://github.com/Rigyuki/il2cpp/blob/main/vm/GlobalMetadata.cpp)
- [Android app signing documentation](https://source.android.com/docs/security/features/apksigning)
