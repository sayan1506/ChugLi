# ChugLi

ChugLi is an installable React Native + Expo mobile application backed by AWS AppSync, Lambda, DynamoDB, and Cognito guest identities. Users enter without registration, create short-lived location-bound clans, join by clan ID when nearby, and exchange live text messages under temporary aliases.

## Current Implementation Status

**Phase 2 implementation is present in this repository.** Phase 1 guest-session fixes are retained. The final Phase 2 acceptance check still requires deployment plus two app instances (and a third non-member session) against the live AWS stack.

Implemented through Phase 2:

- React Native + Expo 54 + TypeScript + Expo Router
- AWS CDK v2 backend in TypeScript
- Single on-demand DynamoDB table with `PK`, `SK`, TTL `expiresAt`, and reserved sparse `GSI_GEO`
- AppSync GraphQL API with `AWS_IAM`
- Cognito Identity Pool unauthenticated guest credentials
- SigV4-signed HTTP GraphQL requests and IAM-authenticated AppSync WebSocket subscriptions
- Rolling 24-hour guest application sessions
- Clan creation with creator membership in one DynamoDB transaction
- Join-by-ID with a fresh server-side 5 km Haversine check
- One-hour server-generated clan lifetime
- Temporary clan member IDs and aliases
- Message send, recent history, single-message fetch, pagination, and retry deduplication
- Basic create/send rate limits
- Backend-only `publishClanEvent` mutation
- Membership-authorized, clan-filtered `onClanEvent` subscription
- Foreground reconciliation after subscription, reconnect, app resume, and every 30 seconds while active
- Foreground device location for create/join
- No chat text persisted to SecureStore

## Repository Structure

```text
ChugLi-main/
├── .response/                  # Local phase reports; gitignored
├── infra/
│   ├── bin/                    # CDK entry
│   ├── lambda/
│   │   ├── start-session.ts    # Guest application-session resolver
│   │   └── app.ts              # Clan/chat/subscription authorization resolvers
│   ├── lib/chugli-stack.ts     # AWS resources, IAM, resolvers
│   ├── test/                   # Vitest resolver tests
│   └── schema.graphql          # AppSync schema
├── mobile/
│   ├── app/                    # Expo Router screens
│   └── src/
│       ├── auth/               # Cognito guest credentials
│       ├── aws/                # SigV4 HTTP + AppSync realtime client
│       ├── chat/               # Chat GraphQL documents/types
│       ├── clan/               # Clan GraphQL documents/types
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

The existing stack is updated in place; Phase 2 does not introduce another AWS stack.

```bash
cd infra
npx cdk bootstrap --profile chugli --region us-east-1   # first deployment only
npx cdk deploy --profile chugli --region us-east-1 --require-approval never
cd ..
npm run sync-config
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

The Phase 2 test flow is:

1. Start a guest session.
2. Create a clan on client A using its foreground location.
3. Share the displayed clan ID with client B.
4. Join on client B while within 5 km of the creator's fixed clan centre.
5. Exchange messages and verify they appear without manual refresh.
6. Retry a send with the same request ID path and verify only one committed message exists.
7. Use a third guest session that is not a member and verify clan content/subscription access is denied.

## Phase 2 API

Client-accessible fields:

- `Mutation.startSession`
- `Mutation.createClan`
- `Mutation.joinClan`
- `Mutation.sendMessage`
- `Query.getClan`
- `Query.listMessages`
- `Query.getMessage`
- `Subscription.onClanEvent`

Backend-only field:

- `Mutation.publishClanEvent`

The guest IAM role has no direct DynamoDB access and cannot call `publishClanEvent`.

## Data and Security Rules

- Caller identity comes from AppSync's verified IAM/Cognito context.
- Application sessions use server-generated IDs and rolling 24-hour inactivity expiry.
- Clan IDs, member IDs, aliases, message IDs, timestamps, and status are generated or validated server-side.
- Clan centre coordinates remain backend data and are not returned by the public `Clan` GraphQL type.
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

The final project submission still requires a standalone APK verification in the later packaging phase. Phase 2 may be tested with development builds.

## Intentionally Deferred

The following are not part of Phase 2 and should not be treated as implemented yet:

- Nearby clan discovery and geohash-cell querying
- Storing/querying clan geohashes for discovery
- Full expiry/countdown lifecycle UX
- Reporting and AI moderation
- Personal mute
- Full leave/expired-clan product flow
- Maps
- Push notifications
- Direct messages
- Media uploads
- iOS release/store submission

See `.response/phase-2-report.md` for the implementation and verification status of this handoff.

## License

Proprietary — AWS Hackathon MVP
