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
import { CREATE_CLAN_MUTATION, JOIN_CLAN_MUTATION } from '@/clan/operations';
import type { Clan } from '@/clan/types';
import { getForegroundCoordinates } from '@/location/current';

export default function HomeScreen() {
  const router = useRouter();
  const { session, isAuthenticated } = useAuth();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('General');
  const [joinId, setJoinId] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openClan = (clanId: string) => {
    router.push({ pathname: '/clan/[clanId]', params: { clanId } });
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
      const { lat, lng } = await getForegroundCoordinates();
      const { data } = await apolloClient.mutate<{ createClan: Clan }>({
        mutation: CREATE_CLAN_MUTATION,
        variables: { title: normalizedTitle, category: normalizedCategory, lat, lng },
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

  const handleJoin = async () => {
    const clanId = joinId.trim();
    if (!clanId) {
      setError('Enter the clan ID shared by the creator.');
      return;
    }

    setBusy('join');
    setError(null);
    try {
      const { lat, lng } = await getForegroundCoordinates();
      const { data } = await apolloClient.mutate<{ joinClan: Clan }>({
        mutation: JOIN_CLAN_MUTATION,
        variables: { clanId, lat, lng },
        fetchPolicy: 'network-only',
      });
      if (!data?.joinClan) {
        throw new Error('No clan data returned');
      }
      setJoinId('');
      openClan(data.joinClan.clanId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join clan');
    } finally {
      setBusy(null);
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

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.title}>ChugLi</Text>
          <Text style={styles.subtitle}>Create or join a temporary clan</Text>
          <Text style={styles.session}>Guest session active</Text>
        </View>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

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
            editable={!busy}
          />
          <TextInput
            accessibilityLabel="Clan category"
            style={styles.input}
            value={category}
            onChangeText={setCategory}
            placeholder="Category"
            maxLength={40}
            editable={!busy}
          />
          <Pressable
            accessibilityRole="button"
            style={[styles.button, busy ? styles.buttonDisabled : null]}
            onPress={() => void handleCreate()}
            disabled={busy !== null}
          >
            {busy === 'create' ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Create nearby clan</Text>}
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Join by clan ID</Text>
          <Text style={styles.help}>
            Use the clan ID shared by its creator. Nearby discovery comes later; the backend still verifies that you are within 5 km.
          </Text>
          <TextInput
            accessibilityLabel="Clan ID"
            style={styles.input}
            value={joinId}
            onChangeText={setJoinId}
            placeholder="Paste clan ID"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />
          <Pressable
            accessibilityRole="button"
            style={[styles.secondaryButton, busy ? styles.buttonDisabled : null]}
            onPress={() => void handleJoin()}
            disabled={busy !== null}
          >
            {busy === 'join' ? <ActivityIndicator /> : <Text style={styles.secondaryButtonText}>Join clan</Text>}
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F5F5F5' },
  content: { padding: 20, paddingTop: 56, paddingBottom: 40, gap: 16 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#F5F5F5' },
  header: { marginBottom: 4 },
  title: { fontSize: 34, fontWeight: '800', color: '#101010' },
  subtitle: { marginTop: 6, fontSize: 16, color: '#5F6368' },
  session: { marginTop: 8, fontSize: 13, color: '#3C6E47', fontWeight: '600' },
  muted: { marginTop: 8, color: '#666' },
  card: { backgroundColor: '#FFF', borderRadius: 18, padding: 18, gap: 12, elevation: 2 },
  cardTitle: { fontSize: 20, fontWeight: '700', color: '#171717' },
  help: { color: '#666', lineHeight: 20 },
  input: { borderWidth: 1, borderColor: '#D8D8D8', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, backgroundColor: '#FFF', color: '#111' },
  button: { minHeight: 48, borderRadius: 12, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonText: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  secondaryButton: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: '#111', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  secondaryButtonText: { color: '#111', fontSize: 16, fontWeight: '700' },
  buttonDisabled: { opacity: 0.55 },
  errorBox: { backgroundColor: '#FDECEC', borderRadius: 12, padding: 12 },
  errorText: { color: '#9F1D1D', lineHeight: 19 },
});
