# ChugLi

ChugLi is an installable React Native + Expo mobile application backed by AWS AppSync, Lambda, DynamoDB, and Cognito guest identities. Users enter without registration, discover short-lived clans near their current location, create or join a clan, and exchange live text messages under temporary aliases.

## Current Implementation Status

**Source implementation is present through Phase 4.** Phase 1 guest-session fixes, the Phase 2 realtime clan-chat path, and Phase 3 geohash discovery are retained. Phase 4 adds the complete clan-expiry/mobile-lifecycle behavior required by the build roadmap.

Phase 4 packaging performed dependency-free source checks successfully, but this packaging environment could not complete `npm ci` because DNS resolution for `registry.npmjs.org` failed with `EAI_AGAIN`. Therefore the exact Phase 4 ZIP is **not** falsely marked as having rerun the full typecheck/test/lint/CDK-synth/Expo-Doctor suite. Run the commands below locally before deployment.

Implemented through Phase 4:

- React Native + Expo 54 + TypeScript + Expo Router
- AWS CDK v2 backend in TypeScript
- Single on-demand DynamoDB table with `PK`, `SK`, TTL `expiresAt`, and sparse `GSI_GEO`
- AppSync GraphQL API with `AWS_IAM`
- Cognito Identity Pool unauthenticated guest credentials
- SigV4-signed HTTP GraphQL requests and IAM-authenticated AppSync WebSocket subscriptions
- Rolling 24-hour guest application sessions
- Clan creation with creator membership in one DynamoDB transaction
- Server-generated geohash-5 index keys for clan metadata
- Nearby discovery over every geohash cell intersecting the 5 km search bounding box
- Exact Haversine filtering after the geo-index query
- Opaque continuation tokens and client-side deduplication for paginated discovery
- Public discovery results containing rounded distance but no stored clan coordinates
- Join-by-ID and discovery-list joining with a fresh server-side 5 km check
- One-hour server-generated clan lifetime by default
- Shared expiry inherited by clan membership, messages, and retry-deduplication records
- Backend expiry checks independent of delayed DynamoDB TTL deletion
- Server-time-based native expiry countdown using monotonic elapsed time instead of the device wall clock
- Expired-clan screen that clears transient message state and stops realtime activity
- Cold-start clan validation before restoring realtime
- Foreground-resume credential refresh, expiry revalidation, subscription restoration, and reconciliation
- Temporary clan member IDs and aliases
- Message send, recent history, single-message fetch, pagination, and retry deduplication
- Basic create/send rate limits
- Backend-only `publishClanEvent` mutation
- Membership-authorized, clan-filtered `onClanEvent` subscription
- Foreground reconciliation after subscription, reconnect, app resume, and every 30 seconds while active
- Foreground location handling for discovery/create/join, including denied, unavailable, stale, last-known, and approximate-location states
- No chat text persisted to SecureStore, AsyncStorage, or an offline database

## Repository Structure

```text
ChugLi-main/
├── .response/                  # Local phase reports; gitignored
├── infra/
│   ├── bin/                    # CDK entry
│   ├── lambda/
│   │   ├── start-session.ts    # Guest application-session resolver
│   │   └── app.ts              # Clan/chat/discovery/subscription resolvers
│   ├── lib/chugli-stack.ts     # AWS resources, IAM, resolvers, lifetime config
│   ├── test/                   # Vitest resolver/discovery/expiry tests
│   └── schema.graphql          # AppSync schema
├── mobile/
│   ├── app/                    # Expo Router screens
│   └── src/
│       ├── auth/               # Cognito guest credentials
│       ├── aws/                # SigV4 HTTP + AppSync realtime client
│       ├── chat/               # Chat GraphQL documents/types
│       ├── clan/               # Clan operations/types + expiry clock helpers
│       ├── discovery/          # Nearby-page merge/format helpers
│       ├── hooks/              # Session + live chat/lifecycle hooks
│       ├── location/           # Foreground coordinate acquisition
│       └── session/            # SecureStore session metadata only
├── sync-config.ts              # CloudFormation outputs -> mobile/.env
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Prerequisites

- Node.js 22+
- npm 10+
- AWS CLI configured with the project deployment profile
- Android device/emulator for native verification
- Docker if using the repository verification container
- EAS CLI only if using EAS cloud APK builds

## Install and Verify

From the repository root:

```bash
npm ci
npm run typecheck
npm run test
npm run lint
npm run infra:synth
cd mobile
npx expo-doctor
```

Or run the clean-container verification path:

```bash
docker compose run --rm verify
```

Do not mark Phase 4 fully complete until these checks pass for this exact revision and the live expiry scenarios below are verified on Android.

## Deploy Backend

The existing `ChugLi` stack is updated in place; Phase 4 does not add another AWS service.

Normal one-hour deployment:

```bash
cd infra
npx cdk bootstrap --profile chugli --region us-east-1   # first deployment only
npx cdk deploy --profile chugli --region us-east-1 --require-approval never
cd ..
npm run sync-config -- --profile chugli --region us-east-1
```

Only public identifiers are written to `mobile/.env`:

- `EXPO_PUBLIC_APPSYNC_GRAPHQL_URL`
- `EXPO_PUBLIC_AWS_REGION`
- `EXPO_PUBLIC_COGNITO_IDENTITY_POOL_ID`
- `EXPO_PUBLIC_APPSYNC_API_ID`

Never commit `.env`, credentials, signing keys, or long-lived AWS keys.

## Accelerated Phase 4 Expiry Test

The normal clan lifetime remains **3600 seconds**. For a clearly labelled live acceptance test, deploy the same stack with an explicit CDK context override, for example 120 seconds:

```bash
cd infra
npx cdk deploy \
  -c clanLifetimeSeconds=120 \
  --profile chugli \
  --region us-east-1 \
  --require-approval never
cd ..
npm run sync-config -- --profile chugli --region us-east-1
```

After the short-lifetime test, redeploy **without** `-c clanLifetimeSeconds=...` to restore the normal 3600-second configuration.

## Run the Mobile App

```bash
npm run mobile:start
```

Phase 4 phone flow:

1. Start or restore the guest session.
2. Create or join a clan and open chat.
3. Confirm the header countdown is based on backend `serverNow` / `expiresAt` and decreases normally.
4. With the accelerated test stack, keep the app open until expiry. The chat must close, transient messages must be cleared, and realtime must stop.
5. Create another short-lived clan, background the app until after expiry, then resume it. The app must revalidate with AWS and stay on the expired state rather than restoring chat.
6. Repeat after force-closing the app and reopening the same clan route. Cold start must verify server expiry before showing content or starting realtime.
7. Change the Android wall clock while testing. Device-clock manipulation must not restore backend access; the active countdown uses server time plus monotonic elapsed time and resume/cold-start always recheck the backend.
8. Confirm expired DynamoDB rows may still physically exist while AppSync reads/writes/subscription registration reject access.

## Phase 4 API

Client-accessible fields remain:

- `Mutation.startSession`
- `Mutation.createClan`
- `Mutation.joinClan`
- `Mutation.sendMessage`
- `Query.nearbyClans`
- `Query.getClan`
- `Query.listMessages`
- `Query.getMessage`
- `Subscription.onClanEvent`

Backend-only field:

- `Mutation.publishClanEvent`

The guest IAM role has no direct DynamoDB access and cannot call `publishClanEvent`.

## Expiry and Lifecycle Design

At clan creation the backend calculates:

```text
expiresAt = serverNow + clanLifetimeSeconds
```

The default `clanLifetimeSeconds` is 3600. Creator membership, joined memberships, chat messages, and send request-deduplication rows inherit the clan's exact `expiresAt` value.

Functional access never depends on DynamoDB TTL physically deleting an item. `getClan`, `listMessages`, `getMessage`, `sendMessage`, joining, and subscription registration all require an active clan at server time. Discovery also excludes expired index entries. DynamoDB TTL remains background cleanup only.

On mobile, `serverNow` establishes a server-time anchor. The countdown advances using monotonic elapsed time instead of trusting the device wall clock. At local countdown expiry, the hook clears in-memory chat state, stops the subscription, disables sending, and renders the expired-clan state. Foreground resume and cold start still perform fresh server reads so a suspended JavaScript timer is never treated as authoritative.

Returning from background clears the in-memory temporary-credential cache. The first signed HTTP reconciliation obtains current Cognito credentials, verifies clan state, then realtime is restored only if the clan is still active. The existing realtime client also obtains credentials again when reconnecting a lost socket.

## Nearby Discovery Design

Clan creation stores a five-character geohash calculated by the backend:

```text
geoPK = GEO#<geohash5>
geoSK = expiresAt
```

`nearbyClans` validates the caller/session and coordinates, enumerates intersecting cells, queries only index rows with `geoSK > serverNow`, applies exact Haversine filtering, removes expired/out-of-radius candidates, deduplicates by clan ID, and returns public metadata with rounded distance. Discovery never grants membership; joining rereads the current clan and performs a fresh server-side distance/expiry check.

## Data and Security Rules

- Caller identity comes from AppSync's verified IAM/Cognito context.
- Application sessions use server-generated IDs and rolling 24-hour inactivity expiry.
- Clan IDs, member IDs, aliases, message IDs, timestamps, and status are generated or validated server-side.
- Clan centre coordinates remain private backend/index data and are not returned by `Clan` or `NearbyClan`.
- The client never supplies a geohash; the backend calculates it from validated coordinates.
- Joining performs a fresh server-side distance check against the stored clan centre.
- Clan and clan-owned records use the same server-generated expiry.
- Reads, sends, and subscription registration require active membership and an unexpired clan.
- Message text is limited to 500 Unicode characters.
- Send retries use `requestId` + payload hash so a retried committed request does not create another message.
- Subscription events contain IDs/status/revision/expiry only; clients fetch authorized message content after an approved event.
- Chat text remains transient React/Apollo state and is not stored in SecureStore, AsyncStorage, or an offline database.
- Guest role has no DynamoDB, Bedrock, or internal publisher permissions.
- Operational Lambda logging records operation/error type rather than message text or coordinates.

## Realtime Behavior

`sendMessage` commits the message and deduplication row transactionally. The Lambda then invokes the IAM-protected backend-only `publishClanEvent` mutation. Publication failure does not roll back the committed message; clients recover through reconciliation.

The mobile app:

- validates the clan before starting realtime on cold load;
- establishes an IAM-authenticated AppSync WebSocket only for an active clan;
- registers `onClanEvent(clanId)`;
- fetches message content after an `APPROVED` event;
- reconciles immediately after subscription readiness;
- reconnects automatically after socket loss;
- stops realtime while backgrounded;
- refreshes temporary credentials, revalidates expiry, then restores realtime on foreground resume;
- reconciles every 30 seconds only while the app is active;
- stops realtime and clears transient chat state at expiry.

## EAS APK Build

The existing preview profile produces an installable APK:

```bash
cd mobile
eas build --platform android --profile preview
```

The final project submission still requires standalone APK verification in Phase 7. Development builds are sufficient for the Phase 4 lifecycle acceptance checks.

## Intentionally Deferred

The following remain later-phase work:

- Reporting and Nova Lite moderation (Phase 5)
- Personal mute (Phase 5)
- Full leave/report/mute product flow and native polish (Phase 6)
- Maps
- Push notifications
- Direct messages
- Media uploads
- iOS release/store submission

See `.response/phase-4-report.md` for this handoff's implementation and verification status.

## License

Proprietary — AWS Hackathon MVP
