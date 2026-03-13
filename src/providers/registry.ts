import type { ProviderAdapter } from './adapter.js';
import { AnyModelError } from '../types.js';

export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();

  register(slug: string, adapter: ProviderAdapter): void {
    if (this.adapters.has(slug)) {
      throw new AnyModelError(500, `Provider '${slug}' is already registered`);
    }
    this.adapters.set(slug, adapter);
  }

  get(slug: string): ProviderAdapter {
    const adapter = this.adapters.get(slug);
    if (!adapter) {
      throw new AnyModelError(400, `Provider '${slug}' not configured`);
    }
    return adapter;
  }

  has(slug: string): boolean {
    return this.adapters.has(slug);
  }

  list(): string[] {
    return Array.from(this.adapters.keys());
  }

  all(): ProviderAdapter[] {
    return Array.from(this.adapters.values());
  }
}
