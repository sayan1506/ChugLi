import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

export const ddbMock = mockClient(DynamoDBDocumentClient);

export { GetCommand, PutCommand };
