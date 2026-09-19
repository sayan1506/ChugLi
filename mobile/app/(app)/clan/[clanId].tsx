import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { formatClanCountdown } from '@/clan/expiry';
import { useClanChat } from '@/hooks/useClanChat';
import type { ChatMessage } from '@/chat/types';

function MessageBubble({
  message,
  mine,
  busy,
  onReport,
  onMute,
  onRetryReview,
}: {
  message: ChatMessage;
  mine: boolean;
  busy: boolean;
  onReport: () => void;
  onMute: () => void;
  onRetryReview: () => void;
}) {
  return (
    <View style={[styles.message, mine ? styles.mine : styles.theirs]}>
      <Text style={styles.alias}>{mine ? 'You' : message.alias}</Text>
      <Text style={styles.messageText}>
        {message.muted ? 'Muted message' : message.text ?? (message.status === 'PENDING' ? 'Held for review' : 'Message unavailable')}
      </Text>
      {message.status === 'PENDING' && mine ? (
        <Pressable disabled={busy} onPress={onRetryReview} style={styles.inlineAction}>
          <Text style={styles.inlineActionText}>Retry review</Text>
        </Pressable>
      ) : null}
      {!mine && !message.muted ? (
        <View style={styles.messageActions}>
          <Pressable disabled={busy} onPress={onReport} style={styles.inlineAction}>
            <Text style={styles.inlineActionText}>Report</Text>
          </Pressable>
          <Pressable disabled={busy} onPress={onMute} style={styles.inlineAction}>
            <Text style={styles.inlineActionText}>Mute member</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export default function ClanChatScreen() {
  const params = useLocalSearchParams<{ clanId?: string | string[] }>();
  const router = useRouter();
  const clanId = Array.isArray(params.clanId) ? params.clanId[0] ?? '' : params.clanId ?? '';
  const {
    clan,
    messages,
    nextToken,
    loading,
    loadingMore,
    sending,
    moderating,
    error,
    realtimeState,
    expired,
    remainingSeconds,
    sendMessage,
    reportMessage,
    retryMessageReview,
    muteMember,
    loadMore,
    retry,
  } = useClanChat(clanId);
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const realtimeLabel = useMemo(() => {
    if (realtimeState === 'connected') {
      return 'Live';
    }
    if (realtimeState === 'connecting') {
      return 'Connecting…';
    }
    return 'Reconnecting…';
  }, [realtimeState]);


  const chooseReportReason = (messageId: string) => {
    Alert.alert('Report message', 'Choose a reason', [
      { text: 'Threat', onPress: () => void reportMessage(messageId, 'THREAT') },
      { text: 'Harassment', onPress: () => void reportMessage(messageId, 'HARASSMENT') },
      { text: 'Spam', onPress: () => void reportMessage(messageId, 'SPAM') },
      { text: 'Other', onPress: () => void reportMessage(messageId, 'OTHER') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const confirmMute = (memberId: string, alias: string) => {
    Alert.alert('Mute member', `Hide messages from ${alias} for this clan?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Mute', style: 'destructive', onPress: () => void muteMember(memberId) },
    ]);
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || sending) {
      return;
    }
    try {
      await sendMessage(text);
      setDraft('');
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    } catch {
      // The hook keeps the same requestId for a retry of the unchanged draft.
    }
  };

  if (!clanId) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Missing clan ID.</Text>
        <Pressable style={styles.secondaryButton} onPress={() => router.back()}>
          <Text style={styles.secondaryButtonText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  if (loading && !clan) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
        <Text style={styles.muted}>Loading clan…</Text>
      </View>
    );
  }

  if (expired) {
    return (
      <View style={styles.centered}>
        <Text style={styles.expiredTitle}>Clan expired</Text>
        <Text style={styles.expiredText}>This clan has closed and its chat is no longer available.</Text>
        <Pressable style={styles.button} onPress={() => router.replace('/home')}>
          <Text style={styles.buttonText}>Back to nearby clans</Text>
        </Pressable>
      </View>
    );
  }

  if (!clan) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error ?? 'You cannot access this clan.'}</Text>
        <Pressable style={styles.button} onPress={() => void retry()}>
          <Text style={styles.buttonText}>Retry</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={() => router.back()}>
          <Text style={styles.secondaryButtonText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 12 : 0}
    >
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button">
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>{clan.title}</Text>
          <Text style={styles.meta}>{clan.category} · {realtimeLabel}</Text>
          <Text style={styles.countdown}>Expires in {formatClanCountdown(remainingSeconds ?? 0)}</Text>
        </View>
      </View>

      <View style={styles.idBox}>
        <Text style={styles.idLabel}>Clan ID — share this with another test client</Text>
        <Text selectable style={styles.idValue}>{clan.clanId}</Text>
        <Text style={styles.aliasLine}>Your alias: {clan.myAlias}</Text>
      </View>

      {error ? <Text style={styles.inlineError}>{error}</Text> : null}

      {nextToken ? (
        <Pressable style={styles.loadMore} onPress={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? <ActivityIndicator /> : <Text style={styles.loadMoreText}>Load older messages</Text>}
        </Pressable>
      ) : null}

      <FlatList
        ref={listRef}
        style={styles.list}
        contentContainerStyle={messages.length ? styles.listContent : styles.emptyContent}
        data={messages}
        keyExtractor={(item) => item.messageId}
        renderItem={({ item }) => {
          const mine = item.memberId === clan.myMemberId;
          return (
            <MessageBubble
              message={item}
              mine={mine}
              busy={moderating}
              onReport={() => chooseReportReason(item.messageId)}
              onMute={() => confirmMute(item.memberId, item.alias)}
              onRetryReview={() => void retryMessageReview(item.messageId)}
            />
          );
        }}
        ListEmptyComponent={<Text style={styles.muted}>No messages yet. Say hello.</Text>}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
      />

      <View style={styles.composer}>
        <TextInput
          accessibilityLabel="Message"
          style={styles.composerInput}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message clan"
          maxLength={500}
          multiline
          editable={!sending && !expired}
        />
        <Pressable
          accessibilityRole="button"
          style={[styles.sendButton, (!draft.trim() || sending || expired) ? styles.disabled : null]}
          onPress={() => void handleSend()}
          disabled={!draft.trim() || sending || expired}
        >
          {sending ? <ActivityIndicator color="#FFF" /> : <Text style={styles.sendText}>Send</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F5F5F5', paddingTop: 44 },
  centered: { flex: 1, backgroundColor: '#F5F5F5', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, gap: 12 },
  back: { fontSize: 16, fontWeight: '700', color: '#111' },
  headerText: { flex: 1 },
  title: { fontSize: 22, fontWeight: '800', color: '#111' },
  meta: { color: '#666', marginTop: 2 },
  countdown: { color: '#333', marginTop: 3, fontWeight: '700' },
  idBox: { backgroundColor: '#FFF', marginHorizontal: 16, borderRadius: 14, padding: 12 },
  idLabel: { color: '#666', fontSize: 12 },
  idValue: { color: '#111', marginTop: 5, fontFamily: 'monospace', fontSize: 12 },
  aliasLine: { marginTop: 8, color: '#333', fontWeight: '600' },
  inlineError: { color: '#9F1D1D', marginHorizontal: 16, marginTop: 10 },
  list: { flex: 1 },
  listContent: { padding: 16, gap: 10 },
  emptyContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  message: { maxWidth: '82%', borderRadius: 16, paddingHorizontal: 13, paddingVertical: 10 },
  mine: { alignSelf: 'flex-end', backgroundColor: '#DDEBFF' },
  theirs: { alignSelf: 'flex-start', backgroundColor: '#FFF' },
  alias: { fontSize: 11, fontWeight: '700', color: '#666', marginBottom: 3 },
  messageText: { color: '#111', fontSize: 16, lineHeight: 21 },
  messageActions: { flexDirection: 'row', gap: 10, marginTop: 8, flexWrap: 'wrap' },
  inlineAction: { paddingVertical: 4 },
  inlineActionText: { color: '#355C8A', fontSize: 12, fontWeight: '700' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, padding: 12, backgroundColor: '#FFF', borderTopWidth: 1, borderTopColor: '#E4E4E4' },
  composerInput: { flex: 1, maxHeight: 120, minHeight: 44, borderWidth: 1, borderColor: '#D4D4D4', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, color: '#111', backgroundColor: '#FFF' },
  sendButton: { height: 44, minWidth: 72, backgroundColor: '#111', borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  sendText: { color: '#FFF', fontWeight: '700' },
  disabled: { opacity: 0.45 },
  muted: { color: '#666', marginTop: 10 },
  errorText: { color: '#9F1D1D', textAlign: 'center' },
  expiredTitle: { color: '#111', fontSize: 26, fontWeight: '800' },
  expiredText: { color: '#666', textAlign: 'center', maxWidth: 320, lineHeight: 21 },
  button: { backgroundColor: '#111', minWidth: 120, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 18, alignItems: 'center' },
  buttonText: { color: '#FFF', fontWeight: '700' },
  secondaryButton: { borderWidth: 1, borderColor: '#111', minWidth: 120, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 18, alignItems: 'center' },
  secondaryButtonText: { color: '#111', fontWeight: '700' },
  loadMore: { alignSelf: 'center', paddingHorizontal: 16, paddingVertical: 8, marginTop: 8 },
  loadMoreText: { color: '#333', fontWeight: '600' },
});
