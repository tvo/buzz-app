// A one-time offer to switch someone's only agent to Automatic (Recommended).
// Only a bundled plugin can make it, next to its recommended setup in
// `ctx.agents.recommend` (docs/plugin-architecture.md); builds without one never
// show it. The plugin decides who is offered it, how (`mode`) and with what
// copy; Buzz decides whether this person's agent qualifies (`cutoverMatch`, the
// one place for those rules) and records the answer on the agent
// (`withCutover`), so it is asked once, on any device.
import type { Agent } from "./service";
import {
  candidatesFor,
  offRecommended,
  onRecommended,
  parseRecommended,
  withRecommended,
} from "./recommended";

/** How the offer is shown; every mode recommends Automatic.
 * - `centerModalDismissAccepts`: a centered modal; dismissing it switches too,
 *   so only opting out avoids it.
 * - `toastAutoApplied`: the agent is switched first, then a notification says
 *   so and offers to opt out (undo); dismissing it keeps the switch.
 * - `optInPrompt`: a notification that changes nothing unless the person says
 *   yes; dismissing it is a no. */
export const CUTOVER_MODES = [
  "centerModalDismissAccepts",
  "toastAutoApplied",
  "optInPrompt",
] as const;
export type CutoverMode = (typeof CUTOVER_MODES)[number];

/** Every word the offer shows. Buzz ships none of it: the plugin gives it,
 * except the generic defaults for the optional labels. */
export type CutoverCopy = Readonly<{
  /** Plain text; `{agent}` and `{model}` are filled in with the agent's name
   * and the recommended model's label. */
  title: string;
  /** Plain text, filled in the same way. */
  body: string;
  /** The button for Automatic: switch, or in `toastAutoApplied` keep it. */
  acceptLabel: string;
  /** The button that leaves (or puts back) the agent's own settings. */
  optOutLabel: string;
  /** Beside what it would run on (harness, model, thinking level); "Uses". */
  usesLabel?: string;
  /** The button that closes it after a failed save, recording nothing;
   * "Not now". */
  notNowLabel?: string;
  /** The notification's Close button; "Dismiss". */
  dismissLabel?: string;
}>;
/** The optional labels' defaults: generic, so open-source builds hold no
 * organization's wording. */
export const COPY_DEFAULTS = Object.freeze({
  usesLabel: "Uses",
  notNowLabel: "Not now",
  dismissLabel: "Dismiss",
});
export type CutoverOffer = Readonly<{
  mode: CutoverMode;
  copy: CutoverCopy;
  /** Words such as model or harness names; an agent whose name has one, or
   * one of `DEFAULT_EXCLUDE_WORDS`, is someone's deliberate choice and is
   * never offered the switch. */
  excludeWords: readonly string[];
}>;

/** Names that suggest someone chose their agent's model or harness. Names
 * with a version number, such as 5.5 or 6.1, are always skipped too. */
export const DEFAULT_EXCLUDE_WORDS: readonly string[] = Object.freeze([
  "Codex",
  "Claude",
  "goose",
  "Pi",
  "GPT",
  "Sol",
  "Terra",
  "Astra",
  "Opus",
  "Sonnet",
  "Haiku",
  "Fable",
  "Gemini",
  "Llama",
  "Qwen",
  "DeepSeek",
  "Mistral",
  "Grok",
]);

/** `accepted`: said yes. `auto_accepted`: switched without saying yes (the
 * modal was dismissed, or the notification came after the switch).
 * `declined`: opted out, or said no. */
export type CutoverAnswer = "accepted" | "declined" | "auto_accepted";
const ANSWERS: readonly string[] = ["accepted", "declined", "auto_accepted"];
/** What an agent keeps of the offer: the answer, when (ISO 8601), how it was
 * asked and, when switched, the model settings it had, so the switch can be
 * undone. Synced beside `preset` in its `buzz.agent.settings`
 * (docs/configuration.md). */
export type CutoverRecord = Readonly<{
  answer: CutoverAnswer;
  at?: string;
  mode?: CutoverMode;
  previous?: Readonly<{ model?: string; provider?: string; effort?: string }>;
}>;

const MAX_TEXT = 600;
const MAX_WORDS = 200;
const text = (value: unknown, max = MAX_TEXT): value is string =>
  typeof value === "string" &&
  value.trim() === value &&
  value !== "" &&
  value.length <= max;
const isMode = (value: unknown): value is CutoverMode =>
  (CUTOVER_MODES as readonly unknown[]).includes(value);

/** A plugin's offer, checked; errors name the field, never its value. */
export function parseCutover(value: unknown): CutoverOffer {
  const invalid = (problem: string) =>
    new Error(`The cutover offer ${problem}`);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("must be an object");
  const {
    mode,
    copy,
    excludeWords = [],
    ...rest
  } = value as Record<string, unknown>;
  if (Object.keys(rest).length) throw invalid("has an unknown field");
  if (!isMode(mode)) throw invalid("needs a known mode");
  if (!copy || typeof copy !== "object" || Array.isArray(copy))
    throw invalid("needs copy");
  const {
    title,
    body,
    acceptLabel,
    optOutLabel,
    usesLabel,
    notNowLabel,
    dismissLabel,
    ...extra
  } = copy as Record<string, unknown>;
  if (Object.keys(extra).length) throw invalid("copy has an unknown field");
  if (!text(title, 120)) throw invalid("copy.title must be short text");
  if (!text(body)) throw invalid("copy.body must be text");
  if (!text(acceptLabel, 40) || !text(optOutLabel, 40))
    throw invalid("copy needs short button labels");
  const labels = { usesLabel, notNowLabel, dismissLabel };
  for (const [name, label] of Object.entries(labels))
    if (label !== undefined && !text(label, 40))
      throw invalid(`copy.${name} must be short text`);
  if (
    !Array.isArray(excludeWords) ||
    excludeWords.length > MAX_WORDS ||
    !excludeWords.every((word) => text(word, 40))
  )
    throw invalid("excludeWords must be a list of words");
  return Object.freeze({
    mode,
    copy: Object.freeze({
      title,
      body,
      acceptLabel,
      optOutLabel,
      ...Object.fromEntries(
        Object.entries(labels).filter(([, label]) => label !== undefined),
      ),
    }) as CutoverCopy,
    excludeWords: Object.freeze([...(excludeWords as string[])]),
  });
}

/** This launch's offer, from the plugin that gave the recommended setup. */
let runtimeOffer: CutoverOffer | undefined;
export const cutoverOffer = () => runtimeOffer;
/** Sets or clears this launch's offer; invalid input throws and keeps the
 * last one (`takeCutover` clears it instead). */
export function setCutoverOffer(offer: unknown) {
  runtimeOffer = offer === undefined ? undefined : parseCutover(offer);
}

/** Splits a plugin's `recommend` answer into its setup, which goes on to
 * `awaitRecommendation`, and its optional `cutover` offer, kept for this
 * launch. An invalid offer, or one beside an invalid setup, is dropped, and
 * logged without its values. An offer alone keeps the build's setup. */
export function takeCutover(answer: unknown): unknown {
  if (!answer || typeof answer !== "object" || !("cutover" in answer))
    return answer;
  const { cutover, ...setup } = answer as Record<string, unknown>;
  try {
    setCutoverOffer(cutover);
  } catch (error) {
    runtimeOffer = undefined;
    console.warn(
      "A plugin's cutover offer was not used",
      error instanceof Error ? error.message : "invalid",
    );
  }
  if (!Object.keys(setup).length) return undefined;
  // An offer never outlives the setup beside it: when Buzz would reject that
  // setup (and keep the build's), nobody is offered the switch.
  if (runtimeOffer) {
    try {
      parseRecommended(JSON.stringify(setup), true);
    } catch {
      runtimeOffer = undefined;
      console.warn(
        "A plugin's cutover offer was not used",
        "its recommended agent setup is invalid",
      );
    }
  }
  return setup;
}

const literal = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether `name` has one of `words`, ignoring case, as a word of its own or
 * the start of one followed by digits ("GPT helper", "gpt5"), or anything
 * like a version number ("Agent 6.1", "v2"). */
export function excludedName(name: string, words: readonly string[]) {
  if (/\d+(?:\.\d+)+|(?:^|[^\p{L}\p{N}])v\d+(?![\p{L}])/iu.test(name))
    return true;
  return words.some((word) =>
    new RegExp(`(?:^|[^\\p{L}\\p{N}])${literal(word)}(?![\\p{L}])`, "iu").test(
      name,
    ),
  );
}

const MODEL_FIELDS = ["model", "provider", "effort"] as const;
/** The cutover record a config or settings body holds, if valid. */
export function cutoverOf(value: unknown): CutoverRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = (value as { cutover?: unknown }).cutover;
  if (!record || typeof record !== "object") return undefined;
  const { answer, at, mode, previous } = record as Record<string, unknown>;
  if (typeof answer !== "string" || !ANSWERS.includes(answer)) return undefined;
  const kept =
    previous && typeof previous === "object"
      ? Object.fromEntries(
          MODEL_FIELDS.flatMap((name) => {
            const field = (previous as Record<string, unknown>)[name];
            return typeof field === "string" && field ? [[name, field]] : [];
          }),
        )
      : {};
  return {
    answer: answer as CutoverAnswer,
    ...(typeof at === "string" && !Number.isNaN(Date.parse(at)) ? { at } : {}),
    ...(isMode(mode) ? { mode } : {}),
    ...(answer !== "declined" && Object.keys(kept).length
      ? { previous: kept }
      : {}),
  };
}

/** `config` with the answer recorded, when and how it was asked; a switch
 * also keeps the model settings `before` had. Pass the config already
 * switched for `accepted` and `auto_accepted`. */
export function withCutover<C extends object>(
  config: C,
  answer: CutoverAnswer,
  {
    mode,
    before = config,
    now = new Date(),
  }: {
    mode: CutoverMode;
    before?: object;
    now?: Date;
  },
): C {
  const record = cutoverOf({
    cutover: { answer, at: now.toISOString(), mode, previous: before },
  });
  return { ...config, cutover: record } as C;
}

/** `config` switched to Automatic with the answer recorded. */
export const switchedConfig = <C extends object>(
  config: C,
  answer: "accepted" | "auto_accepted",
  mode: CutoverMode,
): C => withCutover(withRecommended(config), answer, { mode, before: config });

/** `config` put back the way it was before a switch, with `declined`
 * recorded: off Automatic, with its previous model settings. */
export function undoneConfig<C extends object>(config: C, mode: CutoverMode) {
  const previous = cutoverOf(config)?.previous ?? {};
  return withCutover({ ...offRecommended(config), ...previous }, "declined", {
    mode,
  });
}

/** `text` with the agent's name and the model's label, as plain text. */
export const fillCopy = (text: string, agent: string, model: string) =>
  text.replaceAll("{agent}", agent).replaceAll("{model}", model);

type CutoverType = Readonly<{ key: string; id: string; remote?: unknown }>;
/** Why an agent isn't offered the switch, so a later change can treat some
 * reasons differently (such as a different prompt for `named` agents). */
export type CutoverSkip =
  | "agents" // the person has no agent, or more than one
  | "notHere" // it runs elsewhere, is being set up or deleted, or is broken
  | "notSynced" // its settings don't sync, or this device hasn't read them
  | "harness" // its harness is remote or has no recommended candidate
  | "automatic" // it is on Automatic already
  | "answered" // it was asked before, on any device
  | "named"; // its name has an excluded word or a version number
export type CutoverMatch<T> =
  | Readonly<{ offer: true; agent: Agent; type: T }>
  | Readonly<{ offer: false; reason: CutoverSkip }>;

/** Whether the person's agents qualify for the offer: every rule, in one
 * place. They qualify when they have exactly one agent and it runs here on a
 * local harness Automatic covers, isn't on Automatic, its settings sync and
 * this device has read them, it was never answered (`answered`, this
 * device's record, or its own), and its name has none of
 * `DEFAULT_EXCLUDE_WORDS` or the offer's `excludeWords`.
 * `agents` may list one agent more than once, in several communities. */
export function cutoverMatch<T extends CutoverType>(
  agents: readonly Agent[],
  types: readonly T[],
  offer: Pick<CutoverOffer, "excludeWords">,
  answered: (pubkey: string) => boolean,
): CutoverMatch<T> {
  const skip = (reason: CutoverSkip) => ({ offer: false, reason }) as const;
  const mine = new Map(agents.map((agent) => [agent.pubkey, agent]));
  const [agent, ...more] = mine.values();
  if (!agent || more.length) return skip("agents");
  if (
    agent.place !== "here" ||
    agent.unfinished ||
    agent.deleting ||
    agent.configProblem
  )
    return skip("notHere");
  // Only once this device has read its synced settings, which hold any
  // answer from another device. Not synced (yet) here: not offered.
  if (typeof agent.configBase?.settings !== "string") return skip("notSynced");
  const type = types.find((item) => item.key === agent.type);
  if (!type || type.remote || !candidatesFor(type.id).length)
    return skip("harness");
  if (onRecommended(agent.config)) return skip("automatic");
  if (cutoverOf(agent.config) || answered(agent.pubkey))
    return skip("answered");
  if (
    excludedName(agent.name, [...DEFAULT_EXCLUDE_WORDS, ...offer.excludeWords])
  )
    return skip("named");
  return { offer: true, agent, type };
}
