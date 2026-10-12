import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { PATTERNS, type Pattern, type Transaction } from "../domain/transaction.js";
import { emailParts } from "../features/derive.js";
import { FEATURE_NAMES, type FeatureName, type Features } from "../features/types.js";

export const DEFAULT_RULES_PATH = fileURLToPath(new URL("../../config/rules.yaml", import.meta.url));

// Transaction fields a rule may reference (in addition to features).
const FIELDS = {
  "card.token": (t: Transaction) => t.card.token,
  "card.bin": (t: Transaction) => t.card.bin,
  "card.country": (t: Transaction) => t.card.country,
  "customer.email": (t: Transaction) => t.customer.email.toLowerCase(),
  email_domain: (t: Transaction) => emailParts(t.customer.email).domain,
  "device.id": (t: Transaction) => t.device.id,
  "device.ip": (t: Transaction) => t.device.ip,
  channel: (t: Transaction) => t.channel,
  promo_code: (t: Transaction) => t.promo_code ?? null,
} as const;
type FieldName = keyof typeof FIELDS;

type Value = string | number | null;

const COMPARISONS = ["==", "!=", ">", ">=", "<", "<="] as const;
const scalar = z.union([z.string(), z.number()]);
const subject = {
  feature: z.enum(FEATURE_NAMES).optional(),
  field: z.enum(Object.keys(FIELDS) as [FieldName, ...FieldName[]]).optional(),
};
const Leaf = z
  .union([
    z.strictObject({ ...subject, op: z.enum(COMPARISONS), value: scalar }),
    z.strictObject({ ...subject, op: z.enum(["in", "not_in"]), value: z.array(scalar).min(1) }),
    z.strictObject({ ...subject, op: z.literal("in_list"), list: z.string() }),
    z.strictObject({ ...subject, op: z.enum(["is_null", "not_null"]) }),
  ])
  .refine((c) => (c.feature === undefined) !== (c.field === undefined), "set exactly one of feature or field");

type LeafCondition = z.infer<typeof Leaf>;
export type Condition = LeafCondition | { all: Condition[] } | { any: Condition[] } | { not: Condition };

const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(ConditionSchema).min(1) }),
    z.strictObject({ any: z.array(ConditionSchema).min(1) }),
    z.strictObject({ not: ConditionSchema }),
    Leaf,
  ]),
);

const RuleSchema = z
  .strictObject({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    message: z.string().min(1),
    when: ConditionSchema,
    /** Hard rules decide immediately (Tier 0). */
    action: z.enum(["block", "review"]).optional(),
    /** Soft rules contribute weight to the combined rule score. */
    weight: z.number().gt(0).lte(1).optional(),
    pattern: z.enum(PATTERNS).optional(),
  })
  .refine((r) => r.action !== undefined || r.weight !== undefined, "a rule needs an action, a weight, or both");

const RulesFileSchema = z.strictObject({
  version: z.literal(1),
  lists: z.record(z.string(), z.array(z.string())).default({}),
  rules: z.array(RuleSchema).min(1),
});

export type Rule = z.infer<typeof RuleSchema>;

export interface RuleHit {
  code: string;
  message: string;
  weight: number;
  action: "block" | "review" | null;
  pattern: Pattern | null;
}

const PLACEHOLDER = /\{([a-z0-9_.]+)\}/g;

function format(v: Value): string {
  if (v === null) return "n/a";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return v;
}

export class RulesEngine {
  private constructor(
    readonly rules: Rule[],
    private readonly lists: Map<string, Set<string>>,
  ) {}

  static fromYaml(source: string): RulesEngine {
    const file = RulesFileSchema.parse(parseYaml(source));
    const lists = new Map(Object.entries(file.lists).map(([name, values]) => [name, new Set(values.map((v) => v.toLowerCase()))]));

    const codes = new Set<string>();
    const known = new Set<string>([...FEATURE_NAMES, ...Object.keys(FIELDS)]);
    const checkLists = (c: Condition): void => {
      if ("all" in c) return c.all.forEach(checkLists);
      if ("any" in c) return c.any.forEach(checkLists);
      if ("not" in c) return checkLists(c.not);
      if (c.op === "in_list" && !lists.has(c.list)) throw new Error(`unknown list "${c.list}"`);
    };
    for (const rule of file.rules) {
      if (codes.has(rule.code)) throw new Error(`duplicate rule code ${rule.code}`);
      codes.add(rule.code);
      checkLists(rule.when);
      for (const [, name] of rule.message.matchAll(PLACEHOLDER)) {
        if (!known.has(name!)) throw new Error(`rule ${rule.code}: unknown placeholder {${name}}`);
      }
    }
    return new RulesEngine(file.rules, lists);
  }

  static load(path = DEFAULT_RULES_PATH): RulesEngine {
    return RulesEngine.fromYaml(readFileSync(path, "utf8"));
  }

  evaluate(txn: Transaction, features: Features): RuleHit[] {
    const resolve = (name: string): Value =>
      name in FIELDS ? FIELDS[name as FieldName](txn) : (features[name as FeatureName] ?? null);

    const test = (c: Condition): boolean => {
      if ("all" in c) return c.all.every(test);
      if ("any" in c) return c.any.some(test);
      if ("not" in c) return !test(c.not);
      const v = resolve((c.feature ?? c.field)!);
      switch (c.op) {
        case "is_null":
          return v === null;
        case "not_null":
          return v !== null;
        case "in_list":
          return v !== null && this.lists.get(c.list)!.has(String(v).toLowerCase());
        case "in":
        case "not_in": {
          if (v === null) return false; // unknown never matches, in either direction
          const found = c.value.includes(v);
          return c.op === "in" ? found : !found;
        }
        default: {
          if (v === null) return false;
          const x = c.value;
          switch (c.op) {
            case "==": return v === x;
            case "!=": return v !== x;
            case ">": return v > x;
            case ">=": return v >= x;
            case "<": return v < x;
            case "<=": return v <= x;
          }
        }
      }
    };

    return this.rules
      .filter((r) => test(r.when))
      .map((r) => ({
        code: r.code,
        message: r.message.replace(PLACEHOLDER, (_, name: string) => format(resolve(name))),
        weight: r.weight ?? 0,
        action: r.action ?? null,
        pattern: r.pattern ?? null,
      }));
  }
}
