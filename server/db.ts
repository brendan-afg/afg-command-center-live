export async function cacheInsight(_type: string, _content: unknown, _ttlMinutes: number) {
  return undefined;
}

export async function getLatestInsight(_type: string): Promise<{ content: unknown } | null> {
  return null;
}
