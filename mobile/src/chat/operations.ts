import { gql } from '@apollo/client';

export const LIST_MESSAGES_QUERY = gql`
  query ListMessages($clanId: ID!, $nextToken: String) {
    listMessages(clanId: $clanId, nextToken: $nextToken) {
      items {
        messageId
        clanId
        memberId
        alias
        text
        status
        revision
        createdAt
        expiresAt
      }
      nextToken
      serverNow
    }
  }
`;

export const GET_MESSAGE_QUERY = gql`
  query GetMessage($clanId: ID!, $messageId: ID!) {
    getMessage(clanId: $clanId, messageId: $messageId) {
      messageId
      clanId
      memberId
      alias
      text
      status
      revision
      createdAt
      expiresAt
    }
  }
`;

export const SEND_MESSAGE_MUTATION = gql`
  mutation SendMessage($clanId: ID!, $requestId: ID!, $text: String!) {
    sendMessage(clanId: $clanId, requestId: $requestId, text: $text) {
      messageId
      status
      revision
      expiresAt
      serverNow
    }
  }
`;

export const ON_CLAN_EVENT_SUBSCRIPTION = gql`
  subscription OnClanEvent($clanId: ID!) {
    onClanEvent(clanId: $clanId) {
      eventId
      clanId
      messageId
      status
      revision
      expiresAt
    }
  }
`;
