import { View, Text, StyleSheet } from 'react-native';
import { useAuth } from '@/auth/AuthContext';

export default function HomeScreen() {
  const { session, isAuthenticated } = useAuth();

  if (!isAuthenticated || !session) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>ChugLi</Text>
        <Text style={styles.subtitle}>Please sign in first</Text>
      </View>
    );
  }

  const formatTimestamp = (ts: number) => new Date(ts * 1000).toISOString();
  const formatExpiry = (expiresAt: number, serverNow: number) => {
    const remaining = expiresAt - serverNow;
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const seconds = remaining % 60;
    return `${hours}h ${minutes}m ${seconds}s`;
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>ChugLi</Text>
      <Text style={styles.subtitle}>App screen — Phase 2+</Text>
      <View style={styles.card}>
        <Text style={styles.detailLabel}>Session ID</Text>
        <Text style={styles.detailValue}>{session.sessionId}</Text>
        <Text style={styles.detailLabel}>Server Time</Text>
        <Text style={styles.detailValue}>{formatTimestamp(session.serverNow)}</Text>
        <Text style={styles.detailLabel}>Expires At</Text>
        <Text style={styles.detailValue}>{formatTimestamp(session.expiresAt)}</Text>
        <Text style={styles.detailLabel}>Time Remaining</Text>
        <Text style={styles.detailValue}>{formatExpiry(session.expiresAt, session.serverNow)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F5F5F5',
    padding: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: '#0A0A0A',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginBottom: 24,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 400,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  detailLabel: {
    fontSize: 14,
    color: '#666',
    marginTop: 12,
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '500',
    color: '#0A0A0A',
    fontFamily: 'monospace',
    marginTop: 4,
  },
});
