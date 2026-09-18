import { StyleSheet, View, Text, Button, ActivityIndicator, ScrollView, SafeAreaView } from 'react-native';
import { useAuth } from '@/auth/AuthContext';

export default function SessionScreen() {
  const { session, state, error, startSession, clearError } = useAuth();

  const formatTimestamp = (ts: number) => new Date(ts * 1000).toISOString();
  const formatExpiry = (expiresAt: number, serverNow: number) => {
    const remaining = expiresAt - serverNow;
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const seconds = remaining % 60;
    return `${hours}h ${minutes}m ${seconds}s`;
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>ChugLi</Text>
          <Text style={styles.subtitle}>Guest Session</Text>
        </View>

        <View style={styles.card}>
          {state === 'loading' && (
            <View style={styles.loading}>
              <ActivityIndicator size="large" color="#0A0A0A" />
              <Text style={styles.loadingText}>Starting session…</Text>
            </View>
          )}

          {state === 'error' && (
            <View style={styles.error}>
              <Text style={styles.errorText}>Error: {error}</Text>
              <View style={styles.errorButton}>
                <Button title="Retry" onPress={() => { clearError(); startSession(); }} />
              </View>
            </View>
          )}

          {state === 'success' && session && (
            <View style={styles.success}>
              <Text style={styles.successLabel}>Session Active</Text>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Session ID</Text>
                <Text style={styles.detailValue}>{session.sessionId}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Server Time</Text>
                <Text style={styles.detailValue}>{formatTimestamp(session.serverNow)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Expires At</Text>
                <Text style={styles.detailValue}>{formatTimestamp(session.expiresAt)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Time Remaining</Text>
                <Text style={styles.detailValue}>{formatExpiry(session.expiresAt, session.serverNow)}</Text>
              </View>
              <View style={styles.restartButton}>
                <Button title="Restart Session" onPress={startSession} />
              </View>
            </View>
          )}

          {state === 'idle' && (
            <View style={styles.idle}>
              <Text style={styles.idleText}>No active session</Text>
              <View style={styles.idleButton}>
                <Button title="Start Guest Session" onPress={startSession} />
              </View>
            </View>
          )}
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Phase 1 — Native Foundation</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  content: {
    flexGrow: 1,
    padding: 24,
    paddingBottom: 40,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  title: {
    fontSize: 42,
    fontWeight: '700',
    color: '#0A0A0A',
    letterSpacing: -1,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginTop: 4,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  loading: {
    alignItems: 'center',
    padding: 16,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#666',
  },
  error: {
    alignItems: 'center',
    padding: 16,
  },
  errorText: {
    color: '#C62828',
    fontSize: 16,
    marginBottom: 16,
    textAlign: 'center',
  },
  success: {
    alignItems: 'stretch',
  },
  successLabel: {
    fontSize: 18,
    fontWeight: '600',
    color: '#2E7D32',
    textAlign: 'center',
    marginBottom: 16,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#EEE',
  },
  detailLabel: {
    fontSize: 14,
    color: '#666',
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '500',
    color: '#0A0A0A',
    fontFamily: 'monospace',
    textAlign: 'right',
    flex: 1,
    marginLeft: 16,
  },
  restartButton: {
    marginTop: 20,
  },
  idle: {
    alignItems: 'center',
    padding: 16,
  },
  idleText: {
    fontSize: 16,
    color: '#666',
    marginBottom: 16,
  },
  idleButton: {
    marginTop: 16,
  },
  footer: {
    alignItems: 'center',
    paddingTop: 24,
  },
  footerText: {
    fontSize: 12,
    color: '#999',
  },
  errorButton: {
    marginTop: 16,
  },
});
