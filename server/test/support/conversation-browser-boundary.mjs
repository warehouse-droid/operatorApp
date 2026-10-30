/** HTTP fixture for the shared conversation API; the real browser module runs. */
export function conversationBrowserBoundary({ audience, messages = [], onSend = () => {} }) {
  const state = { messages, posts: [], fail: false };
  state.handle = async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/stock-request-conversation-alerts')) {
      await route.fulfill({ json: { count: 0, requests: [] } });
    } else if (path.endsWith('/conversation/read')) {
      await route.fulfill({ json: { ok: true } });
    } else if (path.endsWith('/conversation')) {
      if (request.method() === 'POST') {
        const body = request.postDataJSON(); state.posts.push({ path, body });
        if (state.fail) {
          await route.fulfill({ status: 503, json: { error: 'Message delivery unavailable. Try again.' } });
          return true;
        }
        if (!state.messages.some(message => message.operationId === body.operationId)) {
          const eventId = 20 + state.messages.length;
          state.messages.push({ ...body, id: 'stock:' + eventId, eventId, audience,
            actorName: 'Viewer', createdAt: '2026-10-16T13:00:00Z' });
          await onSend(body);
        }
      }
      await route.fulfill({ json: { messages: state.messages, canSend: true,
        latestEventId: state.messages.at(-1)?.eventId || 0 } });
    } else {return false;}
    return true;
  };
  return state;
}

export const legacyConversationMessage = (message, itemName) => ({ id: 'stock:1', eventId: 1,
  audience: 'scm', actorName: 'SCM', message, itemName, createdAt: '2026-10-06T00:00:00Z' });
