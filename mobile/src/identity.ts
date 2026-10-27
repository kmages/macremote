import * as SecureStore from 'expo-secure-store';

// One stable RevenueCat app user ID per phone, kept in the iOS Keychain, which survives deleting and reinstalling
// the app. A free (promotional) entitlement granted to this ID in RevenueCat, such as the owner's lifetime unlock,
// therefore keeps working after a reinstall. Apple-compliant: nothing here unlocks anything; RevenueCat decides.
const KEY = 'macremote.appUserId';

const fresh = () => `cyp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;

export async function stableUserId(): Promise<string> {
  const saved = await SecureStore.getItemAsync(KEY);
  if (saved) return saved;
  const id = fresh();
  await SecureStore.setItemAsync(KEY, id, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
  return id;
}
