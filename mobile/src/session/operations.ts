import { gql } from '@apollo/client';

export const START_SESSION_MUTATION = gql`
  mutation StartSession {
    startSession {
      sessionId
      expiresAt
      serverNow
    }
  }
`;

export const PLACEHOLDER_QUERY = gql`
  query Placeholder {
    placeholder
  }
`;
