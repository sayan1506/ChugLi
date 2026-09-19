# ChugLi

ChugLi is an installable React Native + Expo mobile application backed by AWS AppSync, Lambda, DynamoDB, and Cognito guest identities. Users enter without registration, discover short-lived clans near their current location, create or join a clan, and exchange live text messages under temporary aliases.

## Current Implementation Status

**Implementation is present through Phase 3.** Phase 1 guest-session fixes and the verified Phase 2 realtime clan-chat flow are retained. Phase 3 adds geohash-backed nearby discovery without adding another AWS service.

Implemented through Phase 3:

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
- One-hour server-generated clan lifetime
- Temporary clan member IDs and aliases
- Message send, recent history, single-message fetch, pagination, and retry deduplication
- Basic create/send rate limits
- Backend-only `publishClanEvent` mutation
- Membership-authorized, clan-filtered `onClanEvent` subscription
- Foreground reconciliation after subscription, reconnect, app resume, and every 30 seconds while active
- Foreground location handling for discovery/create/join, including denied, unavailable, stale, last-known, and approximate-location states
- No chat text persisted to SecureStore

## Repository Structure

```text
ChugLi-main/
├── .response/                  # Local phase reports; gitignored
├── infra/
│   ├── bin/                    # CDK entry
│   ├── lambda/
│   │   ├── start-session.ts    # Guest application-session resolver
│   │   └── app.ts              # Clan/chat/discovery/subscription resolvers
│   ├── lib/chugli-stack.ts     # AWS resources, IAM, resolvers
│   ├── test/                   # Vitest resolver/discovery tests
│   └── schema.graphql          # AppSync schema
├── mobile/
│   ├── app/                    # Expo Router screens
│   └── src/
│       ├── auth/               # Cognito guest credentials
│       ├── aws/                # SigV4 HTTP + AppSync realtime client
│       ├── chat/               # Chat GraphQL documents/types
│       ├── clan/               # Clan/discovery GraphQL documents/types
│       ├── discovery/          # Nearby-page merge/format helpers
│       ├── hooks/              # Session + live chat hooks
│       ├── location/           # Foreground coordinate acquisition
│       └── session/            # SecureStore session metadata
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
```

Or run the clean-container verification path:

```bash
docker compose run --rm verify
```

## Deploy Backend

The existing `ChugLi` stack is updated in place; Phase 3 does not create another stack or add Amazon Location Service.

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

## Run the Mobile App

```bash
npm run mobile:start
```

Phase 3 phone flow:

1. Start or restore the guest session.
2. On Home, tap **Find** under **Nearby clans** and grant foreground location when requested.
3. Confirm active clans within 5 km are shown with rounded distance and no exact coordinates.
4. Create a clan on one client, then refresh discovery from another client near the creator.
5. Verify a nearby clan still appears when the two positions fall on opposite sides of a geohash-cell boundary.
6. Verify a clan just outside 5 km is not returned.
7. Tap **Join** on a discovered clan. The phone obtains a fresh location and the backend rechecks the base-table clan state and exact distance before creating membership.
8. Use **Load more nearby clans** when a continuation token is returned; accumulated results are deduplicated by clan ID.

## Phase 3 API

Client-accessible fields:

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

## Nearby Discovery Design

Clan creation stores a five-character geohash calculated by the backend:

```text
geoPK = GEO#<geohash5>
geoSK = expiresAt
```

`nearbyClans`:

1. validates the caller's active guest session and coordinates;
2. calculates the 5 km latitude/longitude bounding box;
3. enumerates every geohash-5 cell intersecting that box, including dateline and high-latitude wraparound cases;
4. queries `GSI_GEO` with `geoPK = <cell>` and `geoSK > serverNow` using bounded query work;
5. calculates exact Haversine distance for each candidate;
6. removes expired/out-of-radius candidates and deduplicates by clan ID;
7. returns public clan metadata plus rounded `distanceMeters`;
8. returns an opaque continuation token when cell/index work remains.

The discovery query does not authorize membership. A join always rereads the current clan item and performs a fresh exact-distance check, so stale discovery results cannot authorize entry.

## Data and Security Rules

- Caller identity comes from AppSync's verified IAM/Cognito context.
- Application sessions use server-generated IDs and rolling 24-hour inactivity expiry.
- Clan IDs, member IDs, aliases, message IDs, timestamps, and status are generated or validated server-side.
- Clan centre coordinates remain private backend/index data and are not returned by `Clan` or `NearbyClan`.
- The client never supplies a geohash; the backend calculates it from validated coordinates.
- Joining performs a fresh server-side distance check against the stored clan centre.
- Clan and clan-owned records use the same server-generated one-hour expiry.
- Reads, sends, and subscription registration require active membership and an unexpired clan.
- Message text is limited to 500 Unicode characters.
- Send retries use `requestId` + payload hash so a retried committed request does not create another message.
- Subscription events contain IDs/status/revision/expiry only; clients fetch authorized message content after an approved event.
- Chat text is kept in React state/Apollo responses and is not stored in SecureStore.
- Guest role has no DynamoDB, Bedrock, or internal publisher permissions.
- Operational Lambda logging records operation/error type rather than message text or coordinates.

## Realtime Behavior

`sendMessage` commits the message and deduplication row transactionally. The Lambda then invokes the IAM-protected backend-only `publishClanEvent` mutation. Publication failure does not roll back the committed message; clients recover through reconciliation.

The mobile app:

- establishes an IAM-authenticated AppSync WebSocket connection;
- registers `onClanEvent(clanId)`;
- fetches message content after an `APPROVED` event;
- reconciles immediately after subscription readiness;
- reconnects automatically after socket loss;
- reconnects and reconciles when returning to the foreground;
- reconciles every 30 seconds only while the app is active.

## EAS APK Build

The existing preview profile produces an installable APK:

```bash
cd mobile
eas build --platform android --profile preview
```

The final project submission still requires standalone APK verification in the later packaging phase. Development builds are sufficient for the Phase 3 discovery acceptance checks.

## Intentionally Deferred

The following remain later-phase work:

- Full expiry/countdown lifecycle UX and cold-start expiry enforcement (Phase 4)
- Reporting and AI moderation (Phase 5)
- Personal mute (Phase 5)
- Full leave/expired-clan product flow
- Maps
- Push notifications
- Direct messages
- Media uploads
- iOS release/store submission

See `.response/phase-3-report.md` for this handoff's implementation and verification status.

## License

Proprietary — AWS Hackathon MVP
