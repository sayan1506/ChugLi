# ChugLi

ChugLi is an installable React Native + Expo mobile application backed by AWS AppSync, Lambda, DynamoDB, Cognito guest identities, and selected Amazon Bedrock moderation reviews. Guests discover nearby short-lived clans, create or join them, and chat under temporary aliases without registration.

## Current implementation status

**Source implementation is present through Phase 5.** Phases 1–4 remain intact: guest AWS authorization, realtime clan chat, geohash discovery, and server-authoritative clan expiry/mobile lifecycle. Phase 5 adds moderation, reporting, review control, hidden-message propagation, and personal mute.

Phase 5 includes:

- pre-publication spam and narrow threat-pattern checks;
- `APPROVED`, `PENDING`, `BLOCKED`, and `HIDDEN` message states;
- bounded Nova Lite review through Bedrock Converse with an 8-second application deadline and capped output;
- strict `ALLOW` / `BLOCK` / `REVIEW` verdict validation;
- review leases and cooldowns to prevent duplicate uncontrolled model work;
- one report per message per application session, with controlled retry of unfinished reviews;
- sender retry for held `PENDING` messages after cooldown;
- content-free `APPROVED` / `HIDDEN` clan events, with authorized reads remaining the source of truth;
- reporter-side immediate local hiding while a report is reviewed;
- server-enforced personal mute that redacts the muted member's text on future reads;
- an `aiReviewEnabled` CDK switch so mute and the rest of the app continue to work when AI review is paused;
- report, mute, and retry-review actions in the native chat screen;
- privacy hardening so another member's `PENDING` or `BLOCKED` submission is not returned through history/direct reads.

The normal clan lifetime remains **3600 seconds**. Chat text remains transient on mobile; it is not persisted in SecureStore, AsyncStorage, SQLite, or an offline message cache.

## Repository structure

```text
ChugLi-main/
├── .response/
│   └── phase-5-report.md       # Phase 5 implementation/verification handoff; gitignored
├── infra/
│   ├── bin/
│   ├── lambda/
│   │   ├── start-session.ts
│   │   ├── app.ts              # clan/chat/discovery/moderation/mute resolvers
│   │   └── moderation.ts       # local rules, verdict validation, Bedrock Converse call
│   ├── lib/chugli-stack.ts
│   ├── test/
│   └── schema.graphql
├── mobile/
│   ├── app/
│   └── src/
│       ├── auth/
│       ├── aws/
│       ├── chat/
│       ├── clan/
│       ├── discovery/
│       ├── hooks/
│       ├── location/
│       └── session/
├── sync-config.ts
├── Dockerfile
├── docker-compose.yml
└── package.json
```

`.response/` is intentionally listed in the root `.gitignore`; the phase report is included in handoff ZIPs but should not be committed.

## Prerequisites

- Node.js 22+
- npm 10+
- AWS CLI configured with the project deployment profile
- Android device/emulator for native verification
- working access to the configured Bedrock model/inference profile for the full moderation acceptance path
- Docker only if using the repository verification container
- EAS CLI only if using EAS cloud APK builds

## Install and verify

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

Or use the clean-container path:

```bash
docker compose run --rm verify
```

The source package was dependency-free syntax/smoke audited during packaging. The packaging environment could not complete `npm ci` because `registry.npmjs.org` DNS resolution returned `EAI_AGAIN`, so the full npm-based suite must be run locally before claiming automated acceptance for this exact ZIP. See `.response/phase-5-report.md` for the exact verification record.

## Deploy backend

Normal deployment:

```bash
cd infra
npx cdk bootstrap --profile chugli --region us-east-1   # first deployment only
npx cdk deploy --profile chugli --region us-east-1 --require-approval never
cd ..
npm run sync-config -- --profile chugli --region us-east-1
```

Only public identifiers belong in `mobile/.env`:

- `EXPO_PUBLIC_APPSYNC_GRAPHQL_URL`
- `EXPO_PUBLIC_AWS_REGION`
- `EXPO_PUBLIC_COGNITO_IDENTITY_POOL_ID`
- `EXPO_PUBLIC_APPSYNC_API_ID`

Never commit `.env`, AWS credentials, APK signing keys, or long-lived access keys.

### Moderation configuration

Default model:

```text
amazon.nova-lite-v1:0
```

Override the model/inference-profile ID if the selected account/region uses a different accessible identifier:

```bash
npx cdk deploy \
  -c moderationModelId=<model-or-inference-profile-id> \
  --profile chugli \
  --region us-east-1 \
  --require-approval never
```

Pause AI review without disabling personal mute or normal chat:

```bash
npx cdk deploy \
  -c aiReviewEnabled=false \
  --profile chugli \
  --region us-east-1 \
  --require-approval never
```

When AI review is paused, locally held messages remain `PENDING`; reported approved messages remain in their pre-review state for other members, while the reporter still hides the reported text locally. The Lambda receives no Bedrock invocation permission in that deployment mode.

## Phase 5 API

Client-accessible fields:

- `Mutation.startSession`
- `Mutation.createClan`
- `Mutation.joinClan`
- `Mutation.sendMessage`
- `Mutation.retryMessageReview`
- `Mutation.reportMessage`
- `Mutation.muteMember`
- `Query.nearbyClans`
- `Query.getClan`
- `Query.listMessages`
- `Query.getMessage`
- `Subscription.onClanEvent`

Backend-only field:

- `Mutation.publishClanEvent`

The guest IAM role has no direct DynamoDB permission, no Bedrock permission, and no permission to call `publishClanEvent`. Bedrock invocation is granted only to the application Lambda when AI review is enabled.

## Moderation flow

### Send path

1. Validate session, membership, clan expiry, message length, rate limit, and retry-deduplication state.
2. Run cheap local checks before shared publication.
3. Ordinary text is committed as `APPROVED` and emits a content-free clan event.
4. Narrow threat/spam patterns are committed as `PENDING` and **not published**.
5. If AI review is enabled, acquire a per-message review lease and call Bedrock with at most five recent approved context messages.
6. `ALLOW` moves a held message to `APPROVED` and publishes the change event.
7. `BLOCK` moves a held message to `BLOCKED`; it is not published to other members.
8. `REVIEW`, timeout, HTTP failure, or invalid output leaves the held message pending and applies a cooldown before retry.

### Report path

- Reports use `REPORT#<messageId>#<sessionId>`, so one session cannot create duplicate report rows for the same message.
- The reporter hides the text immediately in local state.
- The backend reviews an approved reported message under the same lease/cooldown mechanism.
- A `BLOCK` verdict changes the message to `HIDDEN`, increments its revision, and publishes a content-free hidden event so active clients remove the text.
- Duplicate report requests never create another report row. If the previous review is unfinished, a duplicate request can retry only through the existing lease/cooldown gate; a completed review is not invoked again.

### Personal mute

`muteMember` stores a clan-scoped mute row tied to the requesting application session and clan expiry. `listMessages` and `getMessage` redact text from muted members on the server. The client also clears already-visible text from that member immediately after a successful mute. Mute does not depend on Bedrock.

## Privacy and state visibility

- Exact clan coordinates remain backend-only.
- Message bodies are never placed in subscription events.
- Another member's `PENDING` and `BLOCKED` submissions are filtered out of history and direct-message reads.
- A `HIDDEN` message is returned as a content-free tombstone so clients can remove previously visible text.
- Muted member text is redacted on authorized reads.
- Operational error logs record operation/error type, not message bodies or coordinates.
- AI context is bounded to the target text, the report trigger/reason, and at most five recent approved clan messages.
- Conversation text is serialized as untrusted input; it is not allowed to become model instructions.

## Language coverage and limitations

The cheap pre-check intentionally uses narrow examples rather than claiming broad language understanding. Current patterns include simple English threat forms and a small set of Hindi/Hinglish phrases such as `jaan se maar dunga` and `goli maar dunga`, plus obvious spam patterns such as repeated URLs/characters/words.

These heuristics can miss slang, obfuscation, spelling variants, context-dependent harassment, and many languages. They can also produce false positives. Bedrock review is therefore treated as a bounded classifier, not a perfect safety system; malformed or uncertain model output does not automatically publish held content.

## Phase 5 live acceptance

After deploying with a working moderation model:

1. Use two member sessions in the same active clan.
2. Send an ordinary benign message and verify the other client receives it normally.
3. Send a labelled threat-pattern test message and verify the other member never sees its text while it is `PENDING`/`BLOCKED`.
4. Exercise an AI `ALLOW` outcome and verify an approved held message appears only after the approved event/read.
5. Report an approved test message and verify the reporter hides it immediately.
6. Exercise a violating report outcome and verify both active clients remove the message after the `HIDDEN` event; subsequent history reads must return no original text.
7. Repeat the same report and verify only one report row exists and completed review work is not repeated.
8. Force a model failure/invalid output and verify the controlled pending/cooldown behavior.
9. Mute another member and verify their existing/future text is hidden even with `aiReviewEnabled=false`.
10. Re-run the Phase 4 expiry/resume/cold-start checks to confirm moderation did not regress lifecycle enforcement.

## Existing expiry/discovery behavior

The normal clan lifetime is generated by the backend. Clan-owned records inherit the same `expiresAt`; functional access rejects expired clans independently of delayed DynamoDB TTL deletion. The mobile countdown is anchored to backend time and monotonic elapsed time, with fresh server validation on foreground resume/cold start.

Discovery uses backend-generated geohash-5 index keys plus exact Haversine filtering. Discovery never grants membership; joining performs a fresh server-side distance and expiry check.

For an accelerated expiry acceptance test only:

```bash
cd infra
npx cdk deploy -c clanLifetimeSeconds=120 --profile chugli --region us-east-1 --require-approval never
```

Redeploy without the context override afterward to restore 3600 seconds.

## APK build

The existing EAS preview profile produces an installable APK:

```bash
cd mobile
eas build --platform android --profile preview
```

Standalone APK/submission verification remains Phase 7. Phase 5 acceptance can use the native development/preview build against the deployed AWS stack.

## Intentionally deferred

Phase 6+ still includes:

- full native UX polish and leave-flow completion;
- broader loading/offline/retry product polish;
- final physical-device accessibility/keyboard/back-navigation checks;
- maps;
- push notifications;
- direct messages;
- media uploads;
- iOS release/store submission;
- final signed standalone APK and submission/demo packaging.

See `.response/phase-5-report.md` for the exact Phase 5 handoff and verification status.

## License

Proprietary — AWS Hackathon MVP
