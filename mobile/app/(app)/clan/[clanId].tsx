import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { formatClanCountdown } from '@/clan/expiry';
import { useClanChat } from '@/hooks/useClanChat';
import type { ChatMessage } from '@/chat/types';

function messagePlaceholder(message: ChatMessage, mine: boolean): string {
  if (message.muted) return 'Message hidden because you muted this member.';
  if (message.status === 'PENDING') return mine ? 'Your message is being reviewed.' : 'Message under review.';
  if (message.status === 'BLOCKED') return mine ? 'Your message was blocked.' : 'Message unavailable.';
  if (message.status === 'HIDDEN') return 'Message removed after review.';
  return 'Message unavailable.';
}

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
      <Text style={[styles.messageText, !message.text ? styles.placeholderText : null]}>
        {message.text ?? messagePlaceholder(message, mine)}
      </Text>
      {message.status === 'PENDING' && mine ? (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onRetryReview}
          style={styles.inlineAction}
        >
          <Text style={styles.inlineActionText}>Retry review</Text>
        </Pressable>
      ) : null}
      {!mine && !message.muted && message.status === 'APPROVED' ? (
        <View style={styles.messageActions}>
          <Pressable accessibilityRole="button" disabled={busy} onPress={onReport} style={styles.inlineAction}>
            <Text style={styles.inlineActionText}>Report</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={onMute} style={styles.inlineAction}>
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
    leaving,
    error,
    realtimeState,
    expired,
    remainingSeconds,
    sendMessage,
    reportMessage,
    retryMessageReview,
    muteMember,
    leaveClan,
    loadMore,
    retry,
  } = useClanChat(clanId);
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const realtimeLabel = useMemo(() => {
    if (realtimeState === 'connected') return 'Live';
    if (realtimeState === 'connecting') return 'Connecting…';
    return 'Offline — reconnecting';
  }, [realtimeState]);

  const chooseReportReason = (messageId: string) => {
    Alert.alert('Report message', 'Why are you reporting this message?', [
      { text: 'Threat', onPress: () => void reportMessage(messageId, 'THREAT') },
      { text: 'Harassment', onPress: () => void reportMessage(messageId, 'HARASSMENT') },
      { text: 'Spam', onPress: () => void reportMessage(messageId, 'SPAM') },
      { text: 'Other', onPress: () => void reportMessage(messageId, 'OTHER') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const confirmMute = (memberId: string, alias: string) => {
    Alert.alert('Mute member', `Hide messages from ${alias} for the rest of this clan?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Mute', style: 'destructive', onPress: () => void muteMember(memberId) },
    ]);
  };

  const confirmLeave = () => {
    Alert.alert('Leave clan?', 'You will lose access to this clan immediately. You can only rejoin while nearby and while the clan is active.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await leaveClan();
              router.replace('/home');
            } catch {
              // The hook exposes a user-facing error and keeps the screen usable.
            }
          })();
        },
      },
    ]);
  };

  const shareClan = async () => {
    if (!clan) return;
    await Share.share({
      message: `Join my temporary ChugLi clan “${clan.title}”. Clan ID: ${clan.clanId}`,
    });
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    try {
      await sendMessage(text);
      setDraft('');
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    } catch {
      // The hook retains the requestId when the unchanged draft is retried.
    }
  };

  if (!clanId) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>This clan link is missing an ID.</Text>
        <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={() => router.back()}>
          <Text style={styles.secondaryButtonText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  if (loading && !clan) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
        <Text style={styles.muted}>Opening clan…</Text>
      </View>
    );
  }

  if (expired) {
    return (
      <View style={styles.centered}>
        <Text style={styles.expiredTitle}>Clan expired</Text>
        <Text style={styles.expiredText}>This one-hour clan has closed. Its chat is no longer available.</Text>
        <Pressable accessibilityRole="button" style={styles.button} onPress={() => router.replace('/home')}>
          <Text style={styles.buttonText}>Find another clan</Text>
        </Pressable>
      </View>
    );
  }

  if (!clan) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error ?? 'This clan is unavailable or you are no longer a member.'}</Text>
        <Pressable accessibilityRole="button" style={styles.button} onPress={() => void retry()}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={() => router.replace('/home')}>
          <Text style={styles.secondaryButtonText}>Back to nearby clans</Text>
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
        <Pressable accessibilityRole="button" style={styles.headerAction} onPress={() => router.back()}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>{clan.title}</Text>
          <Text style={styles.meta}>{clan.category} · {realtimeLabel}</Text>
          <Text style={styles.countdown}>Expires in {formatClanCountdown(remainingSeconds ?? 0)}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          style={styles.leaveHeaderButton}
          disabled={leaving}
          onPress={confirmLeave}
        >
          {leaving ? <ActivityIndicator size="small" /> : <Text style={styles.leaveHeaderText}>Leave</Text>}
        </Pressable>
      </View>

      {realtimeState !== 'connected' ? (
        <View style={styles.connectionBanner}>
          <Text style={styles.connectionText}>Live updates are temporarily unavailable. ChugLi will reconcile when the connection returns.</Text>
          <Pressable accessibilityRole="button" onPress={() => void retry()} style={styles.bannerRetry}>
            <Text style={styles.bannerRetryText}>Retry now</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.idBox}>
        <View style={styles.idRow}>
          <View style={styles.idTextBlock}>
            <Text style={styles.idLabel}>Clan ID</Text>
            <Text selectable numberOfLines={1} style={styles.idValue}>{clan.clanId}</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={() => void shareClan()} style={styles.shareButton}>
            <Text style={styles.shareButtonText}>Share</Text>
          </Pressable>
        </View>
        <Text style={styles.aliasLine}>You are {clan.myAlias}</Text>
      </View>

      {error ? (
        <View style={styles.inlineErrorBox}>
          <Text style={styles.inlineError}>{error}</Text>
        </View>
      ) : null}

      {nextToken ? (
        <Pressable accessibilityRole="button" style={styles.loadMore} onPress={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? <ActivityIndicator /> : <Text style={styles.loadMoreText}>Load older messages</Text>}
        </Pressable>
      ) : null}

      <FlatList
        ref={listRef}
        style={styles.list}
        contentContainerStyle={messages.length ? styles.listContent : styles.emptyContent}
        data={messages}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.messageId}
        renderItem={({ item }) => {
          const mine = item.memberId === clan.myMemberId;
          return (
            <MessageBubble
              message={item}
              mine={mine}
              busy={moderating || leaving}
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
          placeholder={realtimeState === 'offline' ? 'You can still send when the network returns' : 'Message clan'}
          maxLength={500}
          multiline
          editable={!sending && !leaving && !expired}
          returnKeyType="default"
        />
        <Pressable
          accessibilityRole="button"
          style={[styles.sendButton, (!draft.trim() || sending || leaving || expired) ? styles.disabled : null]}
          onPress={() => void handleSend()}
          disabled={!draft.trim() || sending || leaving || expired}
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
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  headerAction: { minHeight: 44, minWidth: 58, justifyContent: 'center' },
  back: { fontSize: 16, fontWeight: '700', color: '#111' },
  headerText: { flex: 1, minWidth: 0 },
  title: { fontSize: 22, fontWeight: '800', color: '#111' },
  meta: { color: '#666', marginTop: 2 },
  countdown: { color: '#333', marginTop: 3, fontWeight: '700' },
  leaveHeaderButton: { minHeight: 44, minWidth: 58, alignItems: 'center', justifyContent: 'center' },
  leaveHeaderText: { color: '#9F1D1D', fontWeight: '700' },
  connectionBanner: { marginHorizontal: 16, marginBottom: 10, borderRadius: 12, padding: 12, backgroundColor: '#FFF7DE', gap: 8 },
  connectionText: { color: '#6D5515', lineHeight: 18, fontSize: 13 },
  bannerRetry: { minHeight: 36, alignSelf: 'flex-start', justifyContent: 'center' },
  bannerRetryText: { color: '#4E3D0F', fontWeight: '700' },
  idBox: { backgroundColor: '#FFF', marginHorizontal: 16, borderRadius: 14, padding: 12 },
  idRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  idTextBlock: { flex: 1, minWidth: 0 },
  idLabel: { color: '#666', fontSize: 12 },
  idValue: { color: '#111', marginTop: 5, fontFamily: 'monospace', fontSize: 12 },
  shareButton: { minHeight: 44, minWidth: 68, borderRadius: 10, borderWidth: 1, borderColor: '#CCC', alignItems: 'center', justifyContent: 'center' },
  shareButtonText: { color: '#111', fontWeight: '700' },
  aliasLine: { marginTop: 8, color: '#333', fontWeight: '600' },
  inlineErrorBox: { marginHorizontal: 16, marginTop: 10, backgroundColor: '#FDECEC', borderRadius: 10, padding: 10 },
  inlineError: { color: '#9F1D1D', lineHeight: 18 },
  list: { flex: 1 },
  listContent: { padding: 16, gap: 10 },
  emptyContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  message: { maxWidth: '84%', borderRadius: 16, paddingHorizontal: 13, paddingVertical: 10 },
  mine: { alignSelf: 'flex-end', backgroundColor: '#DDEBFF' },
  theirs: { alignSelf: 'flex-start', backgroundColor: '#FFF' },
  alias: { fontSize: 11, fontWeight: '700', color: '#666', marginBottom: 3 },
  messageText: { color: '#111', fontSize: 16, lineHeight: 21 },
  placeholderText: { color: '#666', fontStyle: 'italic' },
  messageActions: { flexDirection: 'row', gap: 10, marginTop: 8, flexWrap: 'wrap' },
  inlineAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 2 },
  inlineActionText: { color: '#355C8A', fontSize: 12, fontWeight: '700' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, padding: 12, backgroundColor: '#FFF', borderTopWidth: 1, borderTopColor: '#E4E4E4' },
  composerInput: { flex: 1, maxHeight: 120, minHeight: 44, borderWidth: 1, borderColor: '#D4D4D4', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, color: '#111', backgroundColor: '#FFF' },
  sendButton: { minHeight: 44, minWidth: 72, backgroundColor: '#111', borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  sendText: { color: '#FFF', fontWeight: '700' },
  disabled: { opacity: 0.45 },
  muted: { color: '#666', marginTop: 10, textAlign: 'center' },
  errorText: { color: '#9F1D1D', textAlign: 'center', lineHeight: 21 },
  expiredTitle: { color: '#111', fontSize: 26, fontWeight: '800' },
  expiredText: { color: '#666', textAlign: 'center', maxWidth: 320, lineHeight: 21 },
  button: { backgroundColor: '#111', minHeight: 48, minWidth: 160, borderRadius: 12, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#FFF', fontWeight: '700' },
  secondaryButton: { borderWidth: 1, borderColor: '#111', minHeight: 48, minWidth: 160, borderRadius: 12, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { color: '#111', fontWeight: '700' },
  loadMore: { alignSelf: 'center', minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', marginTop: 4 },
  loadMoreText: { color: '#333', fontWeight: '600' },
});
