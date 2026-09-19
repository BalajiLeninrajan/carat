import type { GetDataType, GetReturnType } from '@webext-core/messaging';
import type { Protocol } from '../messaging';
import { safeSendMessage } from '../messaging';

/**
 * A content script has no use for a failed message: the extension was
 * reloaded, the worker is restarting, or the page is closing. Every send
 * resolves to `undefined` instead of rejecting.
 */
export async function send<K extends keyof Protocol>(
  type: K,
  data: GetDataType<Protocol[K]>,
): Promise<GetReturnType<Protocol[K]> | undefined> {
  try {
    return await safeSendMessage(type, data);
  } catch {
    return undefined;
  }
}
