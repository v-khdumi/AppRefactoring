export async function mapConcurrent<Input, Result>(items: Input[], limit: number, work: (item: Input) => Promise<Result>) {
  const results = new Array<Result>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({length:Math.min(limit,items.length)}, async () => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await work(items[index]); }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
  }));
  if (failed) throw failure;
  return results;
}