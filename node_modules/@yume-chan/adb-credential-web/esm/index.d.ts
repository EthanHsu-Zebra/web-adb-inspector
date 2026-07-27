import type { AdbCredentialStore, AdbPrivateKey } from "@yume-chan/adb";
/**
 * An `AdbCredentialStore` implementation that creates RSA private keys using Web Crypto API
 * and stores them in IndexedDB.
 */
export default class AdbWebCredentialStore implements AdbCredentialStore {
    #private;
    constructor(appName?: string);
    /**
     * Generates a RSA private key and store it into LocalStorage.
     *
     * Calling this method multiple times will overwrite the previous key.
     *
     * @returns The private key in PKCS #8 format.
     */
    generateKey(): Promise<AdbPrivateKey>;
    /**
     * Yields the stored RSA private key.
     *
     * This method returns a generator, so `for await...of...` loop should be used to read the key.
     */
    iterateKeys(): AsyncGenerator<AdbPrivateKey, void, void>;
}
//# sourceMappingURL=index.d.ts.map