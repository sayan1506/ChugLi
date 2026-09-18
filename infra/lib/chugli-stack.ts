import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { GraphqlApi, AuthorizationType, FieldLogLevel, Definition } from 'aws-cdk-lib/aws-appsync';
import { CfnIdentityPool, CfnIdentityPoolRoleAttachment } from 'aws-cdk-lib/aws-cognito';
import { Effect, PolicyStatement, Role, WebIdentityPrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { join } from 'node:path';

const SESSION_INACTIVITY_SECONDS = 86400;

export class ChugLiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

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

    const lambdaLogGroup = new LogGroup(this, 'SessionLambdaLogs', {
      logGroupName: '/chugli/lambda/startSession',
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
      logGroup: lambdaLogGroup,
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

    const ds = api.addLambdaDataSource('StartSessionDS', startSessionFn);
    ds.createResolver('StartSessionResolver', {
      typeName: 'Mutation',
      fieldName: 'startSession',
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

    guestRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['appsync:GraphQL'],
        resources: [`${api.arn}/types/Mutation/fields/startSession`],
      }),
    );

    new CfnIdentityPoolRoleAttachment(this, 'GuestRoleAttachment', {
      identityPoolId: identityPool.ref,
      roles: { unauthenticated: guestRole.roleArn },
    });

    new CfnOutput(this, 'GraphqlUrl', { value: api.graphqlUrl });
    new CfnOutput(this, 'Region', { value: this.region });
    new CfnOutput(this, 'IdentityPoolId', { value: identityPool.ref });
    new CfnOutput(this, 'GuestRoleArn', { value: guestRole.roleArn });
    new CfnOutput(this, 'ApiId', { value: api.apiId });
  }
}
