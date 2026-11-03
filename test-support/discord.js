const completions = new Map();

export function completionFor(token) {
  return completions.get(token);
}

export function withInteractionWebhooks(handler) {
  return async (url, options) => {
    const path = new URL(typeof url === 'string' ? url : url.url).pathname;
    const match = path.match(/^\/api\/v10\/webhooks\/[^/]+\/(local-interaction-[^/]+)(\/messages\/@original)?$/);
    if (match) {
      const body = JSON.parse(options.body);
      completions.set(match[1], body);
      return Response.json({ id: '999123', ...body });
    }
    return handler(url, options);
  };
}

export function mockDiscord(t, handler) {
  return t.mock.method(globalThis, 'fetch', withInteractionWebhooks(handler));
}

export function installInteractionWebhooks() {
  globalThis.fetch = withInteractionWebhooks(async () => {
    throw new Error('Unexpected external request in local test');
  });
}
