import type { InterceptedPost } from '../interceptors/types';
import type { AccountCredentials, PlatformId, PostContent, PostResult } from '../platforms/types';

export type CrossPostResultEntry = {
  accountId: string;
  platformId: PlatformId;
  result: PostResult;
};

export type Message =
  | { type: 'CROSSPOST_REQUEST'; payload: { content: PostContent; accountIds: string[] } }
  | { type: 'CROSSPOST_RESULT'; payload: CrossPostResultEntry }
  | { type: 'LIST_CREDENTIALS'; payload: null }
  | { type: 'LIST_CREDENTIALS_RESPONSE'; payload: AccountCredentials[] }
  | { type: 'INTERCEPTED_POST'; payload: InterceptedPost };

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
