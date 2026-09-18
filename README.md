# ChugLi

ChugLi is an installable mobile application built with React Native, Expo, and TypeScript. It lets people discover nearby, short-lived clans and chat using temporary aliases without registering an account or sharing contact details.

## Current Implementation Status

**Phase 1 Complete** — Native foundation with AWS backend:
- ✅ React Native + Expo + TypeScript mobile app
- ✅ Expo Router navigation
- ✅ AWS CDK backend (TypeScript)
- ✅ DynamoDB table with PK, SK, TTL (expiresAt), GSI_GEO
- ✅ AppSync GraphQL API with AWS_IAM authorization
- ✅ Cognito Identity Pool with unauthenticated guest access
- ✅ Narrow guest IAM permissions (Mutation.startSession only)
- ✅ Lambda function for startSession
- ✅ Mobile app obtains temporary Cognito credentials
- ✅ Mobile app signs AppSync requests with SigV4
- ✅ SecureStore for session persistence
- ✅ Android package identifier configured
- ✅ EAS configuration for APK builds

## Tech Stack

| Layer | Technology |
|-------|------------|
| Mobile | React Native, Expo 54, TypeScript, Expo Router |
| GraphQL | Apollo Client 3, AWS AppSync |
| Auth | Amazon Cognito Identity Pool (guest), AWS IAM |
| Backend | AWS CDK v2, TypeScript, Lambda (Node.js 22) |
| Database | DynamoDB (on-demand), TTL, GSI |
| Testing | Vitest (infra), Jest (mobile) |
| Build | EAS (cloud), Docker (verification) |

## Repository Structure

```
chugli/
├── infra/                 # AWS CDK backend
│   ├── bin/              # CDK app entry
│   ├── lib/              # Stack definitions
│   ├── lambda/           # Lambda functions
│   ├── test/             # Unit tests
│   └── schema.graphql    # AppSync schema
├── mobile/               # Expo mobile app
│   ├── app/              # Expo Router screens
│   │   ├── (auth)/       # Guest entry flow
│   │   └── (app)/        # Authenticated app screens
│   ├── src/
│   │   ├── aws/          # AppSync client + SigV4
│   │   ├── auth/         # Cognito credentials
│   │   ├── session/      # SecureStore + operations
│   │   ├── hooks/        # React hooks
│   │   ├── components/   # UI components
│   │   ├── config/       # Environment config
│   │   └── providers/    # Apollo provider
│   └── assets/
├── sync-config.ts        # CDK outputs → mobile .env
├── docker-compose.yml    # Verification container
├── Dockerfile
└── package.json          # Monorepo root
```

## Prerequisites

- Node.js 22+
- npm 10+
- AWS CLI with `chugli` profile configured
- Docker (for verification)
- Expo CLI (`npm i -g expo-cli`)
- EAS CLI (`npm i -g eas-cli`) for APK builds
- Android device/emulator for testing

## Local Setup

```bash
# Install all dependencies
npm run install:all

# Type-check everything
npm run typecheck

# Run tests
npm run test

# Start Expo development server
npm run mobile:start
```

## Docker Verification

Runs type-checking, tests, linting, and CDK synth in a clean container:

```bash
docker compose run --rm verify
```

This verifies:
- Dependency installation
- TypeScript type checking (infra + mobile)
- Unit tests (infra + mobile)
- CDK synthesis

## AWS Profile Requirement

All AWS operations use the `chugli` profile in `us-east-1`:

```bash
aws sts get-caller-identity --profile chugli --region us-east-1
```

The ARN must identify the ChugLi development identity (not root).

## AWS Deployment

```bash
# Bootstrap CDK (first time only)
cd infra && npx cdk bootstrap --profile chugli --region us-east-1

# Deploy
cd infra && npm run deploy
```

After deployment, sync public config to mobile app:

```bash
npm run sync-config
```

This creates `mobile/.env` with:
- `EXPO_PUBLIC_APPSYNC_GRAPHQL_URL`
- `EXPO_PUBLIC_AWS_REGION`
- `EXPO_PUBLIC_COGNITO_IDENTITY_POOL_ID`
- `EXPO_PUBLIC_APPSYNC_API_ID`

**Never commits secrets** — only public identifiers.

## Mobile Configuration Sync

The `sync-config.ts` script reads CDK stack outputs and writes `mobile/.env`. Run after any backend deployment:

```bash
npm run sync-config
```

Or manually:
```bash
tsx sync-config.ts
```

## Running the Expo App

```bash
# Development server
npm run mobile:start

# Android (requires local Android SDK or EAS)
npm run mobile:android

# iOS (requires macOS + Xcode)
npm run mobile:ios
```

The first screen shows ChugLi branding with a "Start Guest Session" button. On success it displays:
- Session ID
- Server time (ISO 8601)
- Session expiry (ISO 8601)
- Time remaining (human-readable)

## EAS APK Build

Configured for Android preview builds producing installable APKs:

```bash
# First time: configure project
cd mobile && eas build:configure

# Build preview APK
cd mobile && eas build --platform android --profile preview
```

The `preview` profile in `eas.json` produces an APK (not AAB) for direct installation.

## Security Rules

- **No long-lived AWS keys** in source or mobile bundle
- **Guest IAM role** allows only `appsync:GraphQL` on `Mutation/startSession`
- **No direct DynamoDB access** for guests
- **No Bedrock/model access** for guests
- **No internal publisher access** for guests
- **SecureStore** used only for sessionId, expiresAt, serverNow, identityId
- **No chat text** in SecureStore
- **Public config only** in mobile bundle (AppSync URL, region, identity pool ID)

## What Is Implemented (Phase 1)

- Guest session creation/resume via `startSession` mutation
- Server-generated session IDs (UUID v4)
- 24-hour inactivity expiry (server-enforced)
- Server time returned with each response
- Conditional writes for session creation (concurrency-safe)
- Secure credential refresh (Cognito Identity Pool)
- SigV4-signed AppSync requests
- Native navigation with Expo Router
- Loading/success/error states
- Session persistence across app restarts

## What Is NOT Implemented (Phase 2+)

- Clan creation, discovery, joining
- Real-time chat messaging
- Geohash-based nearby clan search
- Haversine distance filtering
- Clan/message expiry enforcement UX
- Message history/pagination
- Reporting and moderation
- Personal mute
- Push notifications
- Maps/location UI
- Direct messages
- Media uploads
- AI moderation (Bedrock)

## Troubleshooting

| Issue | Resolution |
|-------|------------|
| `Missing required environment variable` | Run `npm run sync-config` after deployment |
| `Unauthorized` on startSession | Verify Cognito Identity Pool allows unauthenticated identities |
| `SignatureDoesNotMatch` | Check system clock sync; verify region matches |
| CDK deploy fails | Ensure `chugli` profile has permissions; run `cdk bootstrap` |
| Metro bundler errors | Clear cache: `expo start -c` |
| Android build fails | Use EAS cloud build; ensure `app.chugli.mobile` package ID |

## License

Proprietary — AWS Hackathon MVP