import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/auth/AuthContext';

export default function SessionScreen() {
  const { state, error, startSession, clearError } = useAuth();

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.brand}>
          <Text style={styles.title}>ChugLi</Text>
          <Text style={styles.subtitle}>Nearby conversations that disappear after an hour.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Continue as a guest</Text>
          <Text style={styles.body}>
            No account or phone number is required. ChugLi creates a temporary guest session so you can discover and join nearby clans.
          </Text>

          {state === 'loading' ? (
            <View style={styles.statusRow}>
              <ActivityIndicator size="small" />
              <Text style={styles.statusText}>Starting your guest session…</Text>
            </View>
          ) : null}

          {state === 'error' ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error ?? 'Could not start your guest session.'}</Text>
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            style={[styles.primaryButton, state === 'loading' ? styles.disabled : null]}
            disabled={state === 'loading'}
            onPress={() => {
              clearError();
              void startSession();
            }}
          >
            <Text style={styles.primaryButtonText}>{state === 'error' ? 'Try again' : 'Enter ChugLi'}</Text>
          </Pressable>

          <Text style={styles.privacy}>
            Location is requested only when you discover, create, or join a clan. Your exact coordinates are not shown to other members.
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  content: { flex: 1, justifyContent: 'center', padding: 24, gap: 28 },
  brand: { gap: 8 },
  title: { fontSize: 44, fontWeight: '800', color: '#0A0A0A', letterSpacing: -1.5 },
  subtitle: { fontSize: 17, color: '#5F6368', lineHeight: 24, maxWidth: 360 },
  card: { backgroundColor: '#FFF', borderRadius: 20, padding: 22, gap: 16, elevation: 2 },
  cardTitle: { fontSize: 22, fontWeight: '700', color: '#151515' },
  body: { color: '#5F6368', fontSize: 15, lineHeight: 22 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  statusText: { color: '#555', flex: 1 },
  errorBox: { backgroundColor: '#FDECEC', padding: 12, borderRadius: 12 },
  errorText: { color: '#9F1D1D', lineHeight: 20 },
  primaryButton: { minHeight: 50, borderRadius: 14, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  primaryButtonText: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.55 },
  privacy: { color: '#777', fontSize: 12, lineHeight: 18 },
});
