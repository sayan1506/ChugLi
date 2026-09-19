import { gql } from '@apollo/client';

export const CREATE_CLAN_MUTATION = gql`
  mutation CreateClan($title: String!, $category: String!, $lat: Float!, $lng: Float!) {
    createClan(title: $title, category: $category, lat: $lat, lng: $lng) {
      clanId
      title
      category
      createdAt
      expiresAt
      serverNow
      myMemberId
      myAlias
    }
  }
`;

export const JOIN_CLAN_MUTATION = gql`
  mutation JoinClan($clanId: ID!, $lat: Float!, $lng: Float!) {
    joinClan(clanId: $clanId, lat: $lat, lng: $lng) {
      clanId
      title
      category
      createdAt
      expiresAt
      serverNow
      myMemberId
      myAlias
    }
  }
`;

export const GET_CLAN_QUERY = gql`
  query GetClan($clanId: ID!) {
    getClan(clanId: $clanId) {
      clanId
      title
      category
      createdAt
      expiresAt
      serverNow
      myMemberId
      myAlias
    }
  }
`;
