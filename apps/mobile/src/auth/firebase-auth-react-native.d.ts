import type { Persistence } from 'firebase/auth';

/**
 * `firebase/auth` resolves to @firebase/auth's React Native build at runtime
 * (Metro honours its "react-native" export condition), which exports
 * getReactNativePersistence. Its default public typings omit that function,
 * so declare exactly the documented signature here.
 */
declare module 'firebase/auth' {
  interface ReactNativeAsyncStorage {
    setItem(key: string, value: string): Promise<void>;
    getItem(key: string): Promise<string | null>;
    removeItem(key: string): Promise<void>;
  }
  export function getReactNativePersistence(storage: ReactNativeAsyncStorage): Persistence;
}
