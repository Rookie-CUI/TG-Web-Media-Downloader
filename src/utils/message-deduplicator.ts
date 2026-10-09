export class MessageDeduplicator {
  private readonly seen = new Set<string>();

  constructor(private readonly limit = 500) {}

  accept(messageId: unknown): boolean {
    if (typeof messageId !== 'string' || !messageId) return false;
    if (this.seen.has(messageId)) return false;
    this.seen.add(messageId);
    if (this.seen.size > this.limit) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }
}
