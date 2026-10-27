import { Platform } from 'react-native';
import Purchases, { type CustomerInfo, type PurchasesPackage } from 'react-native-purchases';
import { stableUserId } from './identity';

// The entitlement that unlocks the app. Create it in the RevenueCat dashboard and attach the yearly product.
export const ENTITLEMENT = 'pro';
// Public SDK keys (safe to ship), set as EXPO_PUBLIC_* in eas.json / the build environment.
const KEY = Platform.select({
  ios: process.env.EXPO_PUBLIC_RC_IOS_KEY,
  android: process.env.EXPO_PUBLIC_RC_ANDROID_KEY,
});
export const purchasesConfigured = !!KEY;

let ready: Promise<void> | null = null;
let userId: string | null = null;
/** The RevenueCat app user ID this phone uses (shown on the paywall, for support and for granting a free unlock). */
export const appUserId = () => userId;

/**
 * Configure RevenueCat, then log in with this phone's stable ID (src/identity). Logging in from the anonymous user
 * moves any purchase already made on this install onto the stable ID, so an existing subscriber loses nothing.
 * If the Keychain or the login fails, the app carries on as the anonymous user, as before.
 */
export function setupPurchases(): Promise<void> {
  if (!KEY) return Promise.resolve();
  if (!ready) ready = (async () => {
    Purchases.configure({ apiKey: KEY });
    try {
      const id = await stableUserId();
      await Purchases.logIn(id);
      userId = id;
    } catch { /* anonymous, as before */ }
  })();
  return ready;
}

export const hasPro = (info: CustomerInfo): boolean => !!info.entitlements.active[ENTITLEMENT];

export async function checkPro(): Promise<boolean> {
  return hasPro(await Purchases.getCustomerInfo());
}

export function onProChange(cb: (pro: boolean) => void): () => void {
  const listener = (info: CustomerInfo) => cb(hasPro(info));
  Purchases.addCustomerInfoUpdateListener(listener);
  return () => { Purchases.removeCustomerInfoUpdateListener(listener); };
}

// The yearly package from the current offering (falls back to whatever the offering holds first).
export async function loadPackage(): Promise<PurchasesPackage | null> {
  const offerings = await Purchases.getOfferings();
  return offerings.current?.annual ?? offerings.current?.availablePackages[0] ?? null;
}

// Free-trial wording from the store's own data, e.g. "3-day free trial". Null when there is no free intro offer.
export function trialLabel(pkg: PurchasesPackage): string | null {
  const intro = pkg.product.introPrice;
  if (!intro || intro.price !== 0) return null;
  const unit = intro.periodUnit.toLowerCase();
  const n = intro.periodNumberOfUnits * intro.cycles;
  return `${n}-${unit} free trial`;
}

export async function buy(pkg: PurchasesPackage): Promise<boolean> {
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return hasPro(customerInfo);
  } catch (e) {
    if ((e as { userCancelled?: boolean }).userCancelled) return false;
    throw e;
  }
}

export async function restore(): Promise<boolean> {
  return hasPro(await Purchases.restorePurchases());
}
