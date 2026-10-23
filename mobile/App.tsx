import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView } from 'react-native-webview';
import { isSameOrigin, normalizeServerUrl } from './src/url';
import { Paywall } from './src/Paywall';
import { Demo } from './src/Demo';
import { checkPro, onProChange, purchasesConfigured, setupPurchases } from './src/purchases';

const STORE_KEY = 'macremote.serverUrl';
const LOAD_TIMEOUT_MS = 20000;
// Right after the app opens, Tailscale on the phone may still be reconnecting. Retry quietly first.
const AUTO_RETRIES = 3;
const AUTO_RETRY_DELAY_MS = 2000;

export default function App() {
  const [server, setServer] = useState<string | null | undefined>(undefined); // undefined = still loading
  const [pro, setPro] = useState<boolean | undefined>(undefined);               // undefined = still checking
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORE_KEY).then((v) => setServer(v ?? null), () => setServer(null));
  }, []);

  useEffect(() => {
    setupPurchases();
    // Without store keys (local development) the app is unlocked so it can still be worked on.
    if (!purchasesConfigured) { setPro(__DEV__); return; }
    checkPro().then(setPro, () => setPro(false));
    return onProChange(setPro);
  }, []);

  const save = useCallback(async (url: string) => {
    await AsyncStorage.setItem(STORE_KEY, url);
    setServer(url);
  }, []);
  const forget = useCallback(async () => {
    await AsyncStorage.removeItem(STORE_KEY);
    setServer(null);
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.root} edges={['top']}>
        {server === undefined || pro === undefined ? <ActivityIndicator color={ACCENT} style={styles.center} />
          : demo ? <Demo onClose={() => setDemo(false)} />
          : !pro ? <Paywall onUnlocked={() => setPro(true)} onDemo={() => setDemo(true)} />
          : server === null ? <ServerForm onSave={save} />
          : <Remote server={server} onChangeServer={forget} />}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function ServerForm({ onSave }: { onSave: (url: string) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const submit = () => {
    const url = normalizeServerUrl(text);
    if (!url) { setError('Use the name ending in .ts.net (e.g. my-mac.your-tailnet.ts.net), not the 100.x.x.x number.'); return; }
    onSave(url);
  };
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Control Your PC</Text>
      <Text style={styles.label}>Your Mac&apos;s address (the Tailscale HTTPS name)</Text>
      <TextInput
        style={styles.input} value={text} onChangeText={setText} onSubmitEditing={submit}
        placeholder="my-mac.your-tailnet.ts.net" placeholderTextColor="#64748b"
        autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go"
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={styles.primary} onPress={submit}><Text style={styles.primaryText}>Continue</Text></Pressable>
    </View>
  );
}

function Remote({ server, onChangeServer }: { server: string; onChangeServer: () => void }) {
  useKeepAwake(); // the screen stays on while the remote session is showing
  const [failure, setFailure] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const autoRetries = useRef(0);

  const reload = useCallback(() => {
    setFailure(null);
    setLoaded(false);
    setAttempt((n) => n + 1);
  }, []);

  // Network errors in the first seconds are usually Tailscale still waking up, not a real outage.
  const fail = useCallback((message: string) => {
    if (autoRetries.current < AUTO_RETRIES) {
      autoRetries.current += 1;
      setTimeout(reload, AUTO_RETRY_DELAY_MS);
    } else {
      setFailure(message);
    }
  }, [reload]);

  // Coming back to the app after a failure: try again instead of waiting for a tap.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && failure) {
        autoRetries.current = 0;
        reload();
      }
    });
    return () => sub.remove();
  }, [failure, reload]);

  // A connection that hangs never raises an error, so give up after a while and say so.
  useEffect(() => {
    if (loaded || failure) return;
    const t = setTimeout(() => fail('No response after 20 seconds.'), LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [loaded, failure, attempt, fail]);

  if (failure) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Can&apos;t reach your Mac</Text>
        <Text style={styles.label}>{server}{'\n'}{failure}{'\n\n'}Check that Tailscale is connected on this phone, that macremote is running on the Mac, and that this address opens in Safari.</Text>
        <Pressable style={styles.primary} onPress={() => { autoRetries.current = 0; reload(); }}>
          <Text style={styles.primaryText}>Try again</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={onChangeServer}><Text style={styles.secondaryText}>Change address</Text></Pressable>
      </View>
    );
  }
  return (
    <WebView
      key={attempt}
      source={{ uri: server }}
      style={styles.web}
      originWhitelist={['https://*']}
      onShouldStartLoadWithRequest={(req) => isSameOrigin(req.url, server)}
      onLoadEnd={() => setLoaded(true)}
      onLoad={() => { autoRetries.current = 0; }}
      onError={(e) => fail(e.nativeEvent.description || 'The page failed to load.')}
      onHttpError={(e) => { if (e.nativeEvent.statusCode >= 500) fail(`The server answered with error ${e.nativeEvent.statusCode}.`); }}
      // iOS and Android can kill the web view's process while the app is in the background, which
      // leaves a blank screen. Load it again instead.
      onContentProcessDidTerminate={reload}
      onRenderProcessGone={reload}
      sharedCookiesEnabled
      keyboardDisplayRequiresUserAction={false}
      bounces={false}
      scrollEnabled={false}
      allowsBackForwardNavigationGestures={false}
      contentInsetAdjustmentBehavior="never"
      startInLoadingState
      renderLoading={() => <ActivityIndicator color={ACCENT} style={styles.center} />}
    />
  );
}

const ACCENT = '#38bdf8';
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0f172a' },
  center: { flex: 1, alignSelf: 'center' },
  web: { flex: 1, backgroundColor: '#0f172a' },
  card: { padding: 20, marginTop: 60 },
  title: { color: '#e2e8f0', fontSize: 24, fontWeight: '600', marginBottom: 16 },
  label: { color: '#94a3b8', fontSize: 15, marginBottom: 8 },
  input: { color: '#e2e8f0', backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 16 },
  error: { color: '#fca5a5', marginTop: 10 },
  primary: { backgroundColor: ACCENT, borderRadius: 8, padding: 14, marginTop: 18, alignItems: 'center' },
  primaryText: { color: '#082f49', fontWeight: '600', fontSize: 16 },
  secondary: { borderColor: '#334155', borderWidth: 1, borderRadius: 8, padding: 14, marginTop: 12, alignItems: 'center' },
  secondaryText: { color: '#e2e8f0', fontSize: 16 },
});
