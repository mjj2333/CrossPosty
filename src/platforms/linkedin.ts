import type {
  AccountCredentials,
  PlatformAdapter,
  PostContent,
  PostResult,
} from './types';

type LinkedInSessionData = {
  liAt: string;
  jsessionId: string;
};

const NORMSHARES_URL = 'https://www.linkedin.com/voyager/api/contentcreation/normShares';

function csrfFromJsessionId(jsessionId: string): string {
  return jsessionId.replace(/^"|"$/g, '');
}

function buildNormShareBody(text: string): unknown {
  return {
    visibleToConnectionsOnly: false,
    externalAudienceProviders: [],
    commentaryV2: { text, attributes: [] },
    origin: 'FEED_DETAIL',
    allowedCommentersScope: 'ALL',
    postState: 'PUBLISHED',
    media: [],
  };
}

export const linkedinAdapter: PlatformAdapter = {
  id: 'linkedin',
  displayName: 'LinkedIn',
  characterLimit: 3000,
  mediaSupport: {
    maxImages: 9,
    maxVideoSeconds: 600,
    supportedMimeTypes: ['image/jpeg', 'image/png'],
  },

  async authenticate(): Promise<AccountCredentials> {
    const liAtCookie = await chrome.cookies.get({
      url: 'https://www.linkedin.com',
      name: 'li_at',
    });
    const jsessionCookie = await chrome.cookies.get({
      url: 'https://www.linkedin.com',
      name: 'JSESSIONID',
    });
    if (!liAtCookie?.value || !jsessionCookie?.value) {
      throw new Error('LinkedIn session cookies not found. Log in to linkedin.com first.');
    }
    const data: LinkedInSessionData = {
      liAt: liAtCookie.value,
      jsessionId: jsessionCookie.value,
    };
    return {
      platformId: 'linkedin',
      accountId: crypto.randomUUID(),
      displayName: 'LinkedIn session',
      data: data as unknown as Record<string, unknown>,
    };
  },

  async post(content: PostContent, credentials: AccountCredentials): Promise<PostResult> {
    const data = credentials.data as unknown as LinkedInSessionData;
    try {
      const res = await fetch(NORMSHARES_URL, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'csrf-token': csrfFromJsessionId(data.jsessionId),
          'x-restli-protocol-version': '2.0.0',
        },
        body: JSON.stringify(buildNormShareBody(content.text)),
      });
      if (!res.ok) {
        return {
          success: false,
          error: `HTTP ${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      }
      const json = (await res.json()) as { updateUrn?: string };
      const urn = json.updateUrn ?? '';
      return {
        success: true,
        url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : 'https://www.linkedin.com/feed/',
        remoteId: urn,
      };
    } catch (err) {
      return { success: false, error: String(err), retryable: true };
    }
  },

  async validateCredentials(credentials): Promise<boolean> {
    const data = credentials.data as unknown as LinkedInSessionData;
    return Boolean(data.liAt && data.jsessionId);
  },
};
