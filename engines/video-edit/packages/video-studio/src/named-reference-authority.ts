import { RequirementContractError, requirementRecord, type RequirementRecord } from "./requirement-contract.js";
import type { PrdAuthority } from "./prd-authority.js";

export interface NamedReferenceAuthority {
  films: string[];
  ads: string[];
  visual: string[];
}

const record = (value: unknown): RequirementRecord => value && typeof value === "object" && !Array.isArray(value)
  ? value as RequirementRecord : {};
const values = (value: unknown): unknown[] => Array.isArray(value) ? value : [value];
const unique = (values: string[]): string[] => [...new Set(values)];
const names = (value: unknown, key?: string): string[] => values(value).flatMap(item => {
  const name = typeof item === "string" ? item : key ? record(item)[key] : undefined;
  return typeof name === "string" && name.trim() ? [name.trim()] : [];
});

/** Only the immutable customer source can authorize a named reference. */
export function namedReferenceAuthority(authority: PrdAuthority): NamedReferenceAuthority {
  const source = record(JSON.parse(authority.marketing.g1Artifact.content));
  const metadata = record(source.requestedMetadata ?? authority.metadata);
  const brief = record(metadata.brief);
  const intent = typeof source.requestedIntent === "string" ? source.requestedIntent : "";
  const cases = [record(metadata.referenceCases), record(brief.referenceCases)];
  const visual = [metadata.references, metadata.visualReferences, brief.references, brief.visualReferences].flatMap(value => names(value));
  const films = cases.flatMap(item => names(item.filmReferences, "title"));
  const ads = cases.flatMap(item => names(item.adReferences, "brand"));
  // A title used to name the current deliverable is not an external reference.
  // Require an affirmative reference marker next to the quoted work or brand.
  for (const match of intent.matchAll(/(?:^|[，。；;\n])\s*(?:请\s*)?(?:参考(?:影片|电影|片名)?|借鉴(?:影片|电影)?)\s*[：:]?\s*(《[^》\n]+》)/gu)) films.push(match[1]!);
  for (const match of intent.matchAll(/(?:^|[，。；;\n])\s*(?:请\s*)?(?:参考品牌|借鉴品牌)\s*[：:]?\s*([^，。；;\n]+)/gu)) ads.push(match[1]!.trim());
  films.push(...visual.filter(value => /^《[^》\n]+》$/u.test(value)));
  return { films: unique(films), ads: unique(ads), visual: unique([...visual, ...films, ...ads]) };
}

export function referenceCuratorSchema(value: unknown, authority: NamedReferenceAuthority): RequirementRecord {
  const schema = structuredClone(requirementRecord(value, "ReferenceCurator schema"));
  const properties = requirementRecord(schema.properties, "ReferenceCurator properties");
  for (const [field, name, authorized] of [
    ["filmReferences", "title", authority.films], ["adReferences", "brand", authority.ads],
  ] as const) {
    const collection = requirementRecord(properties[field], field);
    collection.minItems = 0;
    if (authorized.length === 0) collection.maxItems = 0;
    const item = requirementRecord(collection.items, field + " item");
    if (authorized.length) requirementRecord(requirementRecord(item.properties, field + " properties")[name], name).enum = authorized;
    item.additionalProperties = false;
  }
  return schema;
}

export function validateReferenceCases(value: unknown, authority: NamedReferenceAuthority) {
  const cases = requirementRecord(value, "ReferenceCurator result");
  const films = names(cases.filmReferences, "title"), ads = names(cases.adReferences, "brand");
  const style = names(cases.styleReferences);
  const fail = () => { throw new RequirementContractError("REQUIREMENT_REFERENCE_UNVERIFIED",
    "参考案例必须使用客户明确提供的名称和不含作品、导演或品牌名的视听手法"); };
  if (!Array.isArray(cases.filmReferences) || !Array.isArray(cases.adReferences) || !Array.isArray(cases.styleReferences)
    || films.length !== cases.filmReferences.length || ads.length !== cases.adReferences.length || style.length !== cases.styleReferences.length
    || films.length > 4 || ads.length > 3 || style.length < 2 || style.length > 4
    || films.some(name => !authority.films.includes(name)) || ads.some(name => !authority.ads.includes(name))
    || style.some(technique => /《[^》\n]+》|(?:参考|仿照|借鉴)(?:影片|导演|品牌)[：:\s]/u.test(technique))) fail();
  return { films, ads, style };
}

/** Agent3 may select exact current G3 techniques or exact customer references. */
export function applyPrdVisualReferenceSchema(schema: RequirementRecord, allowed: string[]): void {
  const visual = requirementRecord(requirementRecord(schema.properties, "PRD properties").visualSpecification, "视觉规格");
  const field = requirementRecord(requirementRecord(visual.properties, "视觉规格属性").visualReferences, "visualReferences");
  requirementRecord(field.items, "visualReferences item").enum = allowed;
}
