import { DurableObject } from 'cloudflare:workers';
import { makeCloudflareApi } from './cloudflare-api.mjs';

export class ShoppingList extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.api = makeCloudflareApi(ctx.storage, env);
  }

  fetch(request) {
    return this.api.fetch(request);
  }

  alarm() {
    return this.api.alarm();
  }
}

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/api/') && pathname !== '/health') return new Response(null, { status: 404 });
    return env.SHOPPING_LIST.getByName('family-shopping').fetch(request);
  }
};
