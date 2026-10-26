// A dependency-free projection shared by the server and the isolated checker.
// Each key names a complete unit that must actually be read in the final pack.
export function qualityTextKeys(pkg) {
  const keys = ["title", "summary", "body", ...(pkg.orderedBlocks ?? []).map((_, index) => `block:${index}`)];
  const manifest = pkg.nativeManifest ?? {};
  for (const [index] of (manifest.segments ?? []).entries()) keys.push(`segment:${index}`);
  for (const [index] of (manifest.chapters ?? []).entries()) keys.push(`chapter:${index}`);
  for (const [index] of (manifest.outputs ?? []).entries()) keys.push(`output:${index}`);
  for (const [index] of (manifest.pages ?? []).entries()) keys.push(`page:${index}`);
  for (const [index] of (manifest.images ?? []).entries()) keys.push(`image:${index}`);
  for (const [index] of (manifest.files ?? []).entries()) keys.push(`file:${index}`);
  if (manifest.settings) keys.push("native:settings");
  if (manifest.disclosures) keys.push("native:disclosures");
  return keys;
}
