import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { apolloClient } from '@/aws/clients';
import { useAuth } from '@/auth/AuthContext';
import {
  CREATE_CLAN_MUTATION,
  JOIN_CLAN_MUTATION,
  NEARBY_CLANS_QUERY,
} from '@/clan/operations';
import type { Clan, NearbyClan, NearbyClanPage } from '@/clan/types';
import { formatDistance, mergeNearbyClans } from '@/discovery/model';
import { getForegroundCoordinates, type Coordinates } from '@/location/current';

export default function HomeScreen() {
  const router = useRouter();
  const { session, isAuthenticated } = useAuth();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('General');
  const [joinId, setJoinId] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | 'discover' | 'more' | null>(null);
  const [joiningNearbyId, setJoiningNearbyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nearby, setNearby] = useState<NearbyClan[]>([]);
  const [nearbyNextToken, setNearbyNextToken] = useState<string | null>(null);
  const [nearbyOrigin, setNearbyOrigin] = useState<Coordinates | null>(null);
  const [nearbyLoaded, setNearbyLoaded] = useState(false);
  const [locationNote, setLocationNote] = useState<string | null>(null);

  const openClan = (clanId: string) => {
    router.push({ pathname: '/clan/[clanId]', params: { clanId } });
  };

  const updateLocationNote = (coords: Coordinates) => {
    if (coords.isApproximate) {
      setLocationNote('Using an approximate device location. Nearby results may be less precise.');
    } else if (coords.source === 'lastKnown') {
      setLocationNote('Using a recent last-known location because a fresh fix was unavailable.');
    } else {
      setLocationNote(null);
    }
  };

  const handleCreate = async () => {
    const normalizedTitle = title.trim();
    const normalizedCategory = category.trim();
    if (!normalizedTitle) {
      setError('Enter a clan title.');
      return;
    }
    if (!normalizedCategory) {
      setError('Enter a category.');
      return;
    }

    setBusy('create');
    setError(null);
    try {
      const coords = await getForegroundCoordinates();
      updateLocationNote(coords);
      const { data } = await apolloClient.mutate<{ createClan: Clan }>({
        mutation: CREATE_CLAN_MUTATION,
        variables: {
          title: normalizedTitle,
          category: normalizedCategory,
          lat: coords.lat,
          lng: coords.lng,
        },
        fetchPolicy: 'network-only',
      });
      if (!data?.createClan) {
        throw new Error('No clan data returned');
      }
      setTitle('');
      openClan(data.createClan.clanId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create clan');
    } finally {
      setBusy(null);
    }
  };

  const joinClanAtCurrentLocation = async (clanId: string) => {
    const coords = await getForegroundCoordinates();
    updateLocationNote(coords);
    const { data } = await apolloClient.mutate<{ joinClan: Clan }>({
      mutation: JOIN_CLAN_MUTATION,
      variables: { clanId, lat: coords.lat, lng: coords.lng },
      fetchPolicy: 'network-only',
    });
    if (!data?.joinClan) {
      throw new Error('No clan data returned');
    }
    return data.joinClan;
  };

  const handleJoin = async () => {
    const clanId = joinId.trim();
    if (!clanId) {
      setError('Enter the clan ID shared by the creator.');
      return;
    }

    setBusy('join');
    setError(null);
    try {
      const clan = await joinClanAtCurrentLocation(clanId);
      setJoinId('');
      openClan(clan.clanId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join clan');
    } finally {
      setBusy(null);
    }
  };

  const fetchNearby = async (reset: boolean) => {
    const mode = reset ? 'discover' : 'more';
    setBusy(mode);
    setError(null);
    try {
      const coords = reset || !nearbyOrigin ? await getForegroundCoordinates() : nearbyOrigin;
      updateLocationNote(coords);
      const nextToken = reset ? null : nearbyNextToken;
      const { data } = await apolloClient.query<{ nearbyClans: NearbyClanPage }>({
        query: NEARBY_CLANS_QUERY,
        variables: { lat: coords.lat, lng: coords.lng, nextToken },
        fetchPolicy: 'network-only',
      });
      if (!data?.nearbyClans) {
        throw new Error('No nearby clan data returned');
      }
      setNearbyOrigin(coords);
      setNearby((current) =>
        reset
          ? mergeNearbyClans([], data.nearbyClans.items)
          : mergeNearbyClans(current, data.nearbyClans.items),
      );
      setNearbyNextToken(data.nearbyClans.nextToken);
      setNearbyLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to discover nearby clans');
      if (reset) {
        setNearby([]);
        setNearbyNextToken(null);
        setNearbyLoaded(true);
      }
    } finally {
      setBusy(null);
    }
  };

  const handleJoinNearby = async (clanId: string) => {
    setJoiningNearbyId(clanId);
    setError(null);
    try {
      const clan = await joinClanAtCurrentLocation(clanId);
      openClan(clan.clanId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join nearby clan');
    } finally {
      setJoiningNearbyId(null);
    }
  };

  if (!isAuthenticated || !session) {
    return (
      <View style={styles.centered}>
        <Text style={styles.title}>ChugLi</Text>
        <Text style={styles.muted}>Start a guest session first.</Text>
      </View>
    );
  }

  const interactionBusy = busy !== null || joiningNearbyId !== null;

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.title}>ChugLi</Text>
          <Text style={styles.subtitle}>Find or create a temporary nearby clan</Text>
          <Text style={styles.session}>Guest session active</Text>
        </View>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {locationNote ? (
          <View style={styles.noteBox}>
            <Text style={styles.noteText}>{locationNote}</Text>
          </View>
        ) : null}

        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <View style={styles.cardHeaderText}>
              <Text style={styles.cardTitle}>Nearby clans</Text>
              <Text style={styles.help}>Active clans within 5 km of your current location.</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              style={[styles.compactButton, interactionBusy ? styles.buttonDisabled : null]}
              onPress={() => fetchNearby(true)}
              disabled={interactionBusy}
            >
              {busy === 'discover' ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.compactButtonText}>{nearbyLoaded ? 'Refresh' : 'Find'}</Text>
              )}
            </Pressable>
          </View>

          {nearbyLoaded && nearby.length === 0 && busy !== 'discover' ? (
            <Text style={styles.emptyText}>
              {nearbyNextToken
                ? 'No clans found in this area yet. Load more to search further.'
                : 'No active clans found within 5 km.'}
            </Text>
          ) : null}

          {nearby.map((clan) => (
            <View key={clan.clanId} style={styles.nearbyRow}>
              <View style={styles.nearbyText}>
                <Text style={styles.nearbyTitle}>{clan.title}</Text>
                <Text style={styles.nearbyMeta}>
                  {clan.category} · {formatDistance(clan.distanceMeters)} away
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                style={[styles.joinSmallButton, interactionBusy ? styles.buttonDisabled : null]}
                onPress={() => handleJoinNearby(clan.clanId)}
                disabled={interactionBusy}
              >
                {joiningNearbyId === clan.clanId ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.joinSmallButtonText}>Join</Text>
                )}
              </Pressable>
            </View>
          ))}

          {nearbyNextToken ? (
            <Pressable
              accessibilityRole="button"
              style={[styles.secondaryButton, interactionBusy ? styles.buttonDisabled : null]}
              onPress={() => fetchNearby(false)}
              disabled={interactionBusy}
            >
              {busy === 'more' ? (
                <ActivityIndicator />
              ) : (
                <Text style={styles.secondaryButtonText}>Load more nearby clans</Text>
              )}
            </Pressable>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Create a clan</Text>
          <Text style={styles.help}>
            The clan centre is fixed to your current foreground location and expires after one hour.
          </Text>
          <TextInput
            accessibilityLabel="Clan title"
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="Clan title"
            maxLength={80}
            editable={!interactionBusy}
          />
          <TextInput
            accessibilityLabel="Clan category"
            style={styles.input}
            value={category}
            onChangeText={setCategory}
            placeholder="Category"
            maxLength={40}
            editable={!interactionBusy}
          />
          <Pressable
            accessibilityRole="button"
            style={[styles.button, interactionBusy ? styles.buttonDisabled : null]}
            onPress={() => handleCreate()}
            disabled={interactionBusy}
          >
            {busy === 'create' ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Create nearby clan</Text>
            )}
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Join by clan ID</Text>
          <Text style={styles.help}>
            You can still join from a shared clan ID. The backend rechecks current distance and expiry.
          </Text>
          <TextInput
            accessibilityLabel="Clan ID"
            style={styles.input}
            value={joinId}
            onChangeText={setJoinId}
            placeholder="Paste clan ID"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!interactionBusy}
          />
          <Pressable
            accessibilityRole="button"
            style={[styles.secondaryButton, interactionBusy ? styles.buttonDisabled : null]}
            onPress={() => handleJoin()}
            disabled={interactionBusy}
          >
            {busy === 'join' ? (
              <ActivityIndicator />
            ) : (
              <Text style={styles.secondaryButtonText}>Join clan</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F5F5F5' },
  content: { padding: 20, paddingTop: 56, paddingBottom: 40, gap: 16 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#F5F5F5',
  },
  header: { marginBottom: 4 },
  title: { fontSize: 34, fontWeight: '800', color: '#101010' },
  subtitle: { marginTop: 6, fontSize: 16, color: '#5F6368' },
  session: { marginTop: 8, fontSize: 13, color: '#3C6E47', fontWeight: '600' },
  muted: { marginTop: 8, color: '#666' },
  card: { backgroundColor: '#FFF', borderRadius: 18, padding: 18, gap: 12, elevation: 2 },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  cardHeaderText: { flex: 1, gap: 4 },
  cardTitle: { fontSize: 20, fontWeight: '700', color: '#171717' },
  help: { color: '#666', lineHeight: 20 },
  emptyText: { color: '#666', paddingVertical: 8 },
  nearbyRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E2E2E2',
    paddingTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  nearbyText: { flex: 1 },
  nearbyTitle: { fontSize: 16, fontWeight: '700', color: '#171717' },
  nearbyMeta: { marginTop: 3, color: '#666' },
  input: {
    borderWidth: 1,
    borderColor: '#D8D8D8',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    backgroundColor: '#FFF',
    color: '#111',
  },
  button: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#111',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonText: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  compactButton: {
    minWidth: 72,
    minHeight: 40,
    borderRadius: 10,
    backgroundColor: '#111',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  compactButtonText: { color: '#FFF', fontWeight: '700' },
  joinSmallButton: {
    minWidth: 64,
    minHeight: 38,
    borderRadius: 10,
    backgroundColor: '#111',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  joinSmallButtonText: { color: '#FFF', fontWeight: '700' },
  secondaryButton: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#111',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  secondaryButtonText: { color: '#111', fontSize: 16, fontWeight: '700' },
  buttonDisabled: { opacity: 0.55 },
  errorBox: { backgroundColor: '#FDECEC', borderRadius: 12, padding: 12 },
  errorText: { color: '#9F1D1D', lineHeight: 19 },
  noteBox: { backgroundColor: '#FFF7DE', borderRadius: 12, padding: 12 },
  noteText: { color: '#6D5515', lineHeight: 19 },
});
