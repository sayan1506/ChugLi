import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import {
  AuthorizationType,
  Definition,
  FieldLogLevel,
  GraphqlApi,
  MappingTemplate,
} from 'aws-cdk-lib/aws-appsync';
import { CfnIdentityPool, CfnIdentityPoolRoleAttachment } from 'aws-cdk-lib/aws-cognito';
import { Effect, PolicyStatement, Role, WebIdentityPrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { join } from 'node:path';

const SESSION_INACTIVITY_SECONDS = 86400;
const DEFAULT_CLAN_LIFETIME_SECONDS = 3600;
const JOIN_RADIUS_METERS = 5000;
const DEFAULT_MODERATION_MODEL_ID = 'amazon.nova-lite-v1:0';

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}


function booleanContext(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

export class ChugLiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const clanLifetimeSeconds = positiveInteger(
      this.node.tryGetContext('clanLifetimeSeconds'),
      DEFAULT_CLAN_LIFETIME_SECONDS,
      'clanLifetimeSeconds',
    );
    const aiReviewEnabled = booleanContext(
      this.node.tryGetContext('aiReviewEnabled'),
      true,
      'aiReviewEnabled',
    );
    const moderationModelId =
      String(this.node.tryGetContext('moderationModelId') ?? DEFAULT_MODERATION_MODEL_ID).trim() ||
      DEFAULT_MODERATION_MODEL_ID;

    const table = new Table(this, 'ChugLiTable', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecovery: false,
      timeToLiveAttribute: 'expiresAt',
    });

    table.addGlobalSecondaryIndex({
      indexName: 'GSI_GEO',
      partitionKey: { name: 'geoPK', type: AttributeType.STRING },
      sortKey: { name: 'geoSK', type: AttributeType.NUMBER },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: ['clanId', 'title', 'category', 'lat', 'lng', 'createdAt', 'expiresAt'],
    });

    const sessionLogGroup = new LogGroup(this, 'SessionLambdaLogs', {
      logGroupName: '/chugli/lambda/startSession',
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const appLogGroup = new LogGroup(this, 'AppLambdaLogs', {
      logGroupName: '/chugli/lambda/app',
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const startSessionFn = new NodejsFunction(this, 'StartSessionFunction', {
      entry: join(__dirname, '..', 'lambda', 'start-session.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      bundling: { externalModules: ['@aws-sdk/*'] },
      logGroup: sessionLogGroup,
      environment: {
        CHUGLI_TABLE_NAME: table.tableName,
        SESSION_INACTIVITY_SECONDS: String(SESSION_INACTIVITY_SECONDS),
      },
    });
    table.grantReadWriteData(startSessionFn);

    const api = new GraphqlApi(this, 'ChugLiApi', {
      name: 'ChugLi-API',
      definition: Definition.fromFile(join(__dirname, '..', 'schema.graphql')),
      authorizationConfig: {
        defaultAuthorization: { authorizationType: AuthorizationType.IAM },
      },
      logConfig: {
        fieldLogLevel: FieldLogLevel.ERROR,
        excludeVerboseContent: true,
        retention: RetentionDays.ONE_WEEK,
      },
      xrayEnabled: false,
    });

    const appFn = new NodejsFunction(this, 'AppFunction', {
      entry: join(__dirname, '..', 'lambda', 'app.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(15),
      bundling: { externalModules: ['@aws-sdk/*'] },
      logGroup: appLogGroup,
      environment: {
        CHUGLI_TABLE_NAME: table.tableName,
        SESSION_INACTIVITY_SECONDS: String(SESSION_INACTIVITY_SECONDS),
        CLAN_LIFETIME_SECONDS: String(clanLifetimeSeconds),
        JOIN_RADIUS_METERS: String(JOIN_RADIUS_METERS),
        APPSYNC_GRAPHQL_URL: api.graphqlUrl,
        APPSYNC_REGION: this.region,
        AI_REVIEW_ENABLED: String(aiReviewEnabled),
        MODERATION_MODEL_ID: moderationModelId,
        MODERATION_REGION: this.region,
        REVIEW_LEASE_SECONDS: '15',
        REVIEW_COOLDOWN_SECONDS: '30',
      },
    });
    table.grantReadWriteData(appFn);

    const sessionDs = api.addLambdaDataSource('StartSessionDS', startSessionFn);
    sessionDs.createResolver('StartSessionResolver', {
      typeName: 'Mutation',
      fieldName: 'startSession',
    });

    const appDs = api.addLambdaDataSource('AppDS', appFn);
    const clientResolvers: Array<[string, string]> = [
      ['Mutation', 'createClan'],
      ['Mutation', 'joinClan'],
      ['Mutation', 'sendMessage'],
      ['Mutation', 'retryMessageReview'],
      ['Mutation', 'reportMessage'],
      ['Mutation', 'muteMember'],
      ['Mutation', 'leaveClan'],
      ['Query', 'nearbyClans'],
      ['Query', 'getClan'],
      ['Query', 'listMessages'],
      ['Query', 'getMessage'],
    ];
    for (const [typeName, fieldName] of clientResolvers) {
      appDs.createResolver(`${typeName}${fieldName}Resolver`, { typeName, fieldName });
    }

    appDs.createResolver('OnClanEventResolver', {
      typeName: 'Subscription',
      fieldName: 'onClanEvent',
      requestMappingTemplate: MappingTemplate.lambdaRequest(),
      responseMappingTemplate: MappingTemplate.fromString(`
#if($ctx.error)
  $util.error($ctx.error.message, $ctx.error.type)
#end
#if(!$ctx.result.authorized)
  $util.unauthorized()
#end
#set($filter = {})
$util.qr($filter.put("clanId", {"eq": $ctx.args.clanId}))
$extensions.setSubscriptionFilter($util.transform.toSubscriptionFilter($filter))
$util.toJson(null)
`),
    });

    const publishDs = api.addNoneDataSource('PublishClanEventDS');
    publishDs.createResolver('PublishClanEventResolver', {
      typeName: 'Mutation',
      fieldName: 'publishClanEvent',
      requestMappingTemplate: MappingTemplate.fromString(`
{
  "version": "2018-05-29",
  "payload": $util.toJson($ctx.args.event)
}
`),
      responseMappingTemplate: MappingTemplate.fromString('$util.toJson($ctx.result)'),
    });

    const identityPool = new CfnIdentityPool(this, 'GuestIdentityPool', {
      allowUnauthenticatedIdentities: true,
      identityPoolName: 'ChugLiGuests',
    });

    const guestRole = new Role(this, 'GuestRole', {
      assumedBy: new WebIdentityPrincipal('cognito-identity.amazonaws.com', {
        StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPool.ref },
        'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'unauthenticated' },
      }),
      description: 'ChugLi guest access role',
    });

    const guestFields = [
      ['Mutation', 'startSession'],
      ['Mutation', 'createClan'],
      ['Mutation', 'joinClan'],
      ['Mutation', 'sendMessage'],
      ['Mutation', 'retryMessageReview'],
      ['Mutation', 'reportMessage'],
      ['Mutation', 'muteMember'],
      ['Mutation', 'leaveClan'],
      ['Query', 'nearbyClans'],
      ['Query', 'getClan'],
      ['Query', 'listMessages'],
      ['Query', 'getMessage'],
      ['Subscription', 'onClanEvent'],
    ];
    guestRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['appsync:GraphQL'],
        resources: guestFields.map(([typeName, fieldName]) => `${api.arn}/types/${typeName}/fields/${fieldName}`),
      }),
    );

    appFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['appsync:GraphQL'],
        resources: [`${api.arn}/types/Mutation/fields/publishClanEvent`],
      }),
    );

    if (aiReviewEnabled) {
      appFn.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['bedrock:InvokeModel'],
          resources: ['*'],
        }),
      );
    }

    new CfnIdentityPoolRoleAttachment(this, 'GuestRoleAttachment', {
      identityPoolId: identityPool.ref,
      roles: { unauthenticated: guestRole.roleArn },
    });

    new CfnOutput(this, 'GraphqlUrl', { value: api.graphqlUrl });
    new CfnOutput(this, 'Region', { value: this.region });
    new CfnOutput(this, 'IdentityPoolId', { value: identityPool.ref });
    new CfnOutput(this, 'GuestRoleArn', { value: guestRole.roleArn });
    new CfnOutput(this, 'ApiId', { value: api.apiId });
    new CfnOutput(this, 'ClanLifetimeSeconds', { value: String(clanLifetimeSeconds) });
    new CfnOutput(this, 'AiReviewEnabled', { value: String(aiReviewEnabled) });
    new CfnOutput(this, 'ModerationModelId', { value: moderationModelId });
  }
}
