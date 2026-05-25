import type { InterceptedPost } from '../interceptors/types';
import type {
  AccountCredentials,
  AccountStatus,
  PlatformId,
  PostResult,
} from '../platforms/types';
import type { SerializedMedia } from './media-transport';

// The wire-format version of PostContent. Blob survives chrome.runtime
// .sendMessage's structured cloning intermittently — the bytes arrive but
// the receiver loses Blob methods. We serialize media to base64 explicitly.
export type SerializedPostContent = {
  text: string;
  media?: SerializedMedia[];
};

export type CrossPostResultEntry = {
  accountId: string;
  platformId: PlatformId;
  result: PostResult;
};

export type AuthenticateResponse =
  | { success: true; credentials: AccountCredentials }
  | { success: false; error: string };

export type AccountStatusEntry = {
  accountId: string;
  status: AccountStatus;
};

export type Message =
  | {
      type: 'CROSSPOST_REQUEST';
      payload: { content: SerializedPostContent; accountIds: string[] };
    }
  | { type: 'CROSSPOST_RESULT'; payload: CrossPostResultEntry }
  | { type: 'LIST_CREDENTIALS'; payload: null }
  | { type: 'LIST_CREDENTIALS_RESPONSE'; payload: AccountCredentials[] }
  | { type: 'INTERCEPTED_POST'; payload: InterceptedPost }
  | {
      type: 'AUTHENTICATE';
      payload: { platformId: PlatformId; params: Record<string, string> };
    }
  | { type: 'AUTHENTICATE_RESPONSE'; payload: AuthenticateResponse }
  | { type: 'GET_ACCOUNT_STATUSES'; payload: null }
  | { type: 'GET_ACCOUNT_STATUSES_RESPONSE'; payload: AccountStatusEntry[] }
  | { type: 'RECONNECT_ACCOUNT'; payload: { accountId: string } }
  | {
      type: 'RECONNECT_ACCOUNT_RESPONSE';
      payload: { success: true } | { success: false; error: string };
    }
  | { type: 'CLEAR_PLATFORM_PAUSE'; payload: { accountId: string } }
  | { type: 'CLEAR_PLATFORM_PAUSE_RESPONSE'; payload: { success: true } };

export type MessageOf<T extends Message['type']> = Extract<Message, { type: T }>;

export function sendMessage(msg: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

export function onMessage(
  handler: (msg: Message, sender: chrome.runtime.MessageSender) => unknown,
): void {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const result = handler(msg as Message, sender);
    if (result instanceof Promise) {
      result.then(sendResponse);
      return true;
    }
    sendResponse(result);
    return false;
  });
}
