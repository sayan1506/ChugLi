export const startSessionEvent = {
  typeName: 'Mutation',
  fieldName: 'startSession',
  arguments: {},
  identity: {
    identityPoolId: 'pool-1',
    identityId: 'identity-1',
    claims: undefined,
    sub: 'identity-1',
    issuer: 'https://cognito-idp.us-east-1.amazonaws.com',
  },
  request: { headers: { 'user-agent': 'test' } },
  info: {
    fieldName: 'startSession',
    parentTypeName: 'Mutation',
    variables: {},
    selectionSetList: ['sessionId', 'expiresAt', 'serverNow'],
  },
};
