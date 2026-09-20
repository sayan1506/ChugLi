import { gql } from '@apollo/client';

const MESSAGE_FIELDS = gql`
  fragment MessageFields on Message {
    messageId
    clanId
    memberId
    alias
    text
    status
    muted
    revision
    createdAt
    expiresAt
  }
`;

export const LIST_MESSAGES_QUERY = gql`
  ${MESSAGE_FIELDS}
  query ListMessages($clanId: ID!, $nextToken: String) {
    listMessages(clanId: $clanId, nextToken: $nextToken) {
      items { ...MessageFields }
      nextToken
      serverNow
    }
  }
`;

export const GET_MESSAGE_QUERY = gql`
  ${MESSAGE_FIELDS}
  query GetMessage($clanId: ID!, $messageId: ID!) {
    getMessage(clanId: $clanId, messageId: $messageId) { ...MessageFields }
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

export const REPORT_MESSAGE_MUTATION = gql`
  mutation ReportMessage($clanId: ID!, $messageId: ID!, $reason: ReportReason!) {
    reportMessage(clanId: $clanId, messageId: $messageId, reason: $reason) {
      messageId
      status
      revision
      expiresAt
      serverNow
      reviewPending
    }
  }
`;

export const RETRY_MESSAGE_REVIEW_MUTATION = gql`
  mutation RetryMessageReview($clanId: ID!, $messageId: ID!) {
    retryMessageReview(clanId: $clanId, messageId: $messageId) {
      messageId
      status
      revision
      expiresAt
      serverNow
      reviewPending
    }
  }
`;

export const MUTE_MEMBER_MUTATION = gql`
  mutation MuteMember($clanId: ID!, $memberId: ID!) {
    muteMember(clanId: $clanId, memberId: $memberId) {
      memberId
      muted
      serverNow
    }
  }
`;

export const LEAVE_CLAN_MUTATION = gql`
  mutation LeaveClan($clanId: ID!) {
    leaveClan(clanId: $clanId)
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
