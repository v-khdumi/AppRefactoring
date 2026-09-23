export async function processAndSettle(
  process: () => Promise<void>,
  settle: () => Promise<void>,
  processingFailed: (error: unknown) => Promise<void>,
  settlementFailed: (error: unknown) => void,
) {
  try { await process(); }
  catch (error) { await processingFailed(error); return; }
  try { await settle(); }
  catch (error) { settlementFailed(error); }
}