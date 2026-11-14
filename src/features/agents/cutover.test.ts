import { afterEach, expect, it, vi } from "vitest";
import {
  CUTOVER_MODES,
  cutoverMatch,
  cutoverOf,
  cutoverOffer,
  DEFAULT_EXCLUDE_WORDS,
  excludedName,
  fillCopy,
  parseCutover,
  setCutoverOffer,
  switchedConfig,
  takeCutover,
  undoneConfig,
  withCutover,
} from "./cutover";
import { setRuntimeRecommendation } from "./recommended";
import type { Agent } from "./service";

// Synthetic copy, agents and models; real copy comes only from a packager's plugin.
const OFFER = {
  mode: "optInPrompt",
  copy: {
    title: "Keep Agent A up to date?",
    body: "{agent} will use {model} today.",
    acceptLabel: "Yes",
    optOutLabel: "No",
  },
  excludeWords: ["Model", "Harness"],
};
const CODEX = {
  harness: "codex",
  model: "model-a",
  effort: "high",
  label: "Model A",
};
afterEach(() => {
  setCutoverOffer(undefined);
  setRuntimeRecommendation(undefined);
});

it("checks an offer and names the field at fault without its value", () => {
  expect(parseCutover(OFFER)).toEqual(OFFER);
  expect(CUTOVER_MODES).toEqual([
    "centerModalDismissAccepts",
    "toastAutoApplied",
    "optInPrompt",
  ]);
  for (const mode of CUTOVER_MODES)
    expect(parseCutover({ ...OFFER, mode }).mode).toBe(mode);
  // Without words, none beyond Buzz's own list.
  expect(parseCutover({ mode: "optInPrompt", copy: OFFER.copy })).toEqual({
    ...OFFER,
    excludeWords: [],
  });
  // The optional labels are kept when given; the body needn't name {model},
  // since what it would run on is shown beside it.
  const labels = {
    usesLabel: "Starting with",
    notNowLabel: "Later",
    dismissLabel: "Close",
  };
  expect(
    parseCutover({
      ...OFFER,
      copy: { ...OFFER.copy, body: "Plain words.", ...labels },
    }).copy,
  ).toEqual({ ...OFFER.copy, body: "Plain words.", ...labels });
  for (const [value, problem] of [
    [{ copy: OFFER.copy }, "mode"],
    [{ ...OFFER, mode: "secret" }, "mode"],
    // Dropped from the plan; an old flag that names it shows nothing.
    [{ ...OFFER, mode: "centerModalAutoAccept" }, "mode"],
    [null, "must be an object"],
    [[OFFER], "must be an object"],
    [{ ...OFFER, secret: 1 }, "unknown field"],
    [{ mode: "optInPrompt", excludeWords: [] }, "needs copy"],
    [{ ...OFFER, copy: { ...OFFER.copy, extra: "x" } }, "unknown field"],
    [{ ...OFFER, copy: { ...OFFER.copy, title: " secret " } }, "title"],
    [{ ...OFFER, copy: { ...OFFER.copy, body: "" } }, "copy.body"],
    [
      { ...OFFER, copy: { ...OFFER.copy, usesLabel: "x".repeat(41) } },
      "usesLabel",
    ],
    [
      { ...OFFER, copy: { ...OFFER.copy, notNowLabel: " secret" } },
      "notNowLabel",
    ],
    [{ ...OFFER, copy: { ...OFFER.copy, dismissLabel: 3 } }, "dismissLabel"],
    [{ ...OFFER, copy: { ...OFFER.copy, acceptLabel: "" } }, "button labels"],
    [{ ...OFFER, excludeWords: ["ok", " secret "] }, "excludeWords"],
    [{ ...OFFER, excludeWords: "secret" }, "excludeWords"],
  ] as const) {
    expect(() => parseCutover(value)).toThrow(problem);
    try {
      parseCutover(value);
    } catch (error) {
      expect(String(error)).not.toMatch(/secret/);
    }
  }
});

it("splits a plugin's answer into its setup and its offer", () => {
  const setup = { recommendedBy: "Example Org", candidates: [CODEX] };
  expect(takeCutover(setup)).toBe(setup);
  expect(cutoverOffer()).toBeUndefined();
  expect(takeCutover({ ...setup, cutover: OFFER })).toEqual(setup);
  expect(cutoverOffer()).toEqual(OFFER);
  // An offer alone keeps the build's setup.
  expect(takeCutover({ cutover: OFFER })).toBeUndefined();
  expect(cutoverOffer()).toEqual(OFFER);
  expect(takeCutover(undefined)).toBeUndefined();
  // An invalid offer is dropped and logged without its values.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(takeCutover({ ...setup, cutover: { copy: "secret" } })).toEqual(
      setup,
    );
    expect(cutoverOffer()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/secret/);
    // A setup Buzz would reject (a candidate without its label) takes its
    // offer with it, so nobody is switched onto the build's setup instead.
    warn.mockClear();
    const { label: _label, ...unlabelled } = CODEX;
    const bad = { recommendedBy: "Example Org", candidates: [unlabelled] };
    expect(takeCutover({ ...bad, cutover: OFFER })).toEqual(bad);
    expect(cutoverOffer()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    // A setup that keeps the build's ("candidates": []) keeps the offer.
    expect(takeCutover({ candidates: [], cutover: OFFER })).toEqual({
      candidates: [],
    });
    expect(cutoverOffer()).toEqual(OFFER);
  } finally {
    warn.mockRestore();
  }
});

it("excludes names with a listed word or a version number, ignoring case", () => {
  const words = ["GPT", "Sol", "Claude", "goose"];
  for (const name of [
    "GPT helper",
    "my gpt",
    "gpt5 bot",
    "Sol",
    "Agent (sol)",
    "claude-helper",
    "GOOSE",
    "Agent 6.1",
    "Helper 5.5.1",
    "Bot v2",
  ])
    expect(excludedName(name, words), name).toBe(true);
  for (const name of [
    "Agent A",
    "Solace",
    "Claudette",
    "Mongoose",
    "Agent 6",
    "Helper",
    "Navigator",
  ])
    expect(excludedName(name, words), name).toBe(false);
  // Words are text, never patterns.
  expect(excludedName("Agent A", [".*"])).toBe(false);
  expect(excludedName("C++ helper", ["C++"])).toBe(true);
});

const NOW = new Date("2026-11-14T10:00:00.000Z");
it("records the answer, when and how it was asked, keeping a switched agent's previous model settings", () => {
  const before = { model: "model-x", effort: "low", instructions: "Hi" };
  const accepted = withCutover(
    { instructions: "Hi", preset: "recommended" },
    "accepted",
    { mode: "centerModalDismissAccepts", before, now: NOW },
  );
  const record = {
    answer: "accepted",
    at: "2026-11-14T10:00:00.000Z",
    mode: "centerModalDismissAccepts",
    previous: { model: "model-x", effort: "low" },
  };
  expect(accepted).toEqual({
    instructions: "Hi",
    preset: "recommended",
    cutover: record,
  });
  expect(cutoverOf(accepted)).toEqual(record);
  expect(
    withCutover(before, "declined", { mode: "optInPrompt", now: NOW }),
  ).toEqual({
    ...before,
    cutover: {
      answer: "declined",
      at: "2026-11-14T10:00:00.000Z",
      mode: "optInPrompt",
    },
  });
  expect(cutoverOf({ cutover: { answer: "maybe" } })).toBeUndefined();
  expect(cutoverOf({ cutover: "accepted" })).toBeUndefined();
  expect(cutoverOf(undefined)).toBeUndefined();
  // Only model settings are kept, only when switched; a bad date or mode is
  // dropped, and the answer stays.
  expect(
    cutoverOf({
      cutover: {
        answer: "auto_accepted",
        at: "yesterday-ish",
        mode: "popup",
        previous: { model: "m", workspace: "~/x", effort: 3 },
      },
    }),
  ).toEqual({ answer: "auto_accepted", previous: { model: "m" } });
  expect(
    cutoverOf({ cutover: { answer: "declined", previous: { model: "m" } } }),
  ).toEqual({ answer: "declined" });
});

it("switches an agent and puts it back", () => {
  vi.useFakeTimers({ now: NOW });
  try {
    const before = {
      model: "model-x",
      provider: "provider-x",
      effort: "low",
      instructions: "Hi",
    };
    const switched = switchedConfig(
      before,
      "auto_accepted",
      "toastAutoApplied",
    );
    expect(switched).toEqual({
      instructions: "Hi",
      preset: "recommended",
      cutover: {
        answer: "auto_accepted",
        at: "2026-11-14T10:00:00.000Z",
        mode: "toastAutoApplied",
        previous: { model: "model-x", provider: "provider-x", effort: "low" },
      },
    });
    expect(undoneConfig(switched, "toastAutoApplied")).toEqual({
      ...before,
      cutover: {
        answer: "declined",
        at: "2026-11-14T10:00:00.000Z",
        mode: "toastAutoApplied",
      },
    });
  } finally {
    vi.useRealTimers();
  }
});

it("fills the copy as plain text", () => {
  expect(fillCopy(OFFER.copy.body, "Agent A", "Model A")).toBe(
    "Agent A will use Model A today.",
  );
  expect(fillCopy("{model} {model}", "<b>", "Model A")).toBe("Model A Model A");
});

const agent = (change: Partial<Agent> = {}) =>
  ({
    key: "a".repeat(64),
    pubkey: "a".repeat(64),
    name: "Agent A",
    type: "buzz.codex/codex",
    owner: "b".repeat(64),
    relay: "wss://relay.example",
    place: "here",
    attention: {},
    skipped: {},
    timers: {},
    attentionEnabled: false,
    config: { model: "model-x", effort: "low" },
    configBase: { settings: "head" },
    ...change,
  }) as Agent;
const TYPES = [
  { key: "buzz.codex/codex", id: "codex" },
  { key: "buzz.goose/goose", id: "goose" },
  { key: "hosted/builderlab", id: "builderlab", remote: true },
];

it("offers only the person's single local agent that qualifies", () => {
  const offer = parseCutover(OFFER);
  const never = (_pubkey: string) => false;
  const match = (agents: readonly Agent[], answered = never) =>
    cutoverMatch(agents, TYPES, offer, answered);
  const target = (agents: readonly Agent[], answered = never) => {
    const found = match(agents, answered);
    return found.offer ? found.agent.name : undefined;
  };
  // No recommendation for its harness: nothing to switch to.
  expect(target([agent()])).toBeUndefined();
  setRuntimeRecommendation({ candidates: [CODEX] });
  expect(target([agent()])).toBe("Agent A");
  // The same agent in two communities is still one agent.
  expect(target([agent(), agent({ relay: "wss://other.example" })])).toBe(
    "Agent A",
  );
  const reason = (agents: readonly Agent[], answered = never) => {
    const found = match(agents, answered);
    return found.offer ? "offer" : found.reason;
  };
  expect(reason([])).toBe("agents");
  expect(
    reason([agent(), agent({ pubkey: "c".repeat(64), name: "Agent C" })]),
  ).toBe("agents");
  for (const [change, why] of [
    [{ place: "elsewhere" }, "notHere"],
    [{ place: "hosted", type: "hosted/builderlab" }, "notHere"],
    [{ unfinished: true }, "notHere"],
    [{ deleting: true }, "notHere"],
    [{ configProblem: "Settings can't be used" }, "notHere"],
    // Synced, but this device hasn't read its settings yet, or they don't
    // sync (yet), so another device's answer can't be seen.
    [{ configBase: { settings: null } }, "notSynced"],
    [{ configBase: undefined }, "notSynced"],
    [{ configBase: { instructions: "head" } }, "notSynced"],
    [{ type: "buzz.goose/goose" }, "harness"],
    [{ type: "other/unknown" }, "harness"],
    [{ config: { preset: "recommended" } }, "automatic"],
    [{ config: { model: "m", cutover: { answer: "declined" } } }, "answered"],
    [
      { config: { model: "m", cutover: { answer: "auto_accepted" } } },
      "answered",
    ],
    [{ name: "Harness bot" }, "named"],
    [{ name: "Model fan" }, "named"],
    [{ name: "Agent 6.1" }, "named"],
  ] as [Partial<Agent>, string][])
    expect(reason([agent(change)]), JSON.stringify(change)).toBe(why);
  expect(target([agent({ configBase: { settings: "head" } })])).toBe("Agent A");
  expect(reason([agent()], (pubkey) => pubkey === "a".repeat(64))).toBe(
    "answered",
  );
});

it("the offer's words add to Buzz's own, never replace them", () => {
  setRuntimeRecommendation({ candidates: [CODEX] });
  const offer = parseCutover({ ...OFFER, excludeWords: ["Helper"] });
  const reason = (name: string) => {
    const found = cutoverMatch([agent({ name })], TYPES, offer, () => false);
    return found.offer ? "offer" : found.reason;
  };
  expect(reason("Helper bot")).toBe("named");
  expect(reason("Claude bot")).toBe("named");
  expect(reason("Agent A")).toBe("offer");
});

it("Buzz's own words cover model and harness names", () => {
  for (const name of [
    "Codex helper",
    "Claude",
    "my goose",
    "Pi",
    "GPT5 bot",
    "Sol",
    "Terra buddy",
    "Opus",
    "Sonnet",
    "Gemini pal",
    "Agent 5.5",
  ])
    expect(excludedName(name, DEFAULT_EXCLUDE_WORDS), name).toBe(true);
  for (const name of ["Agent A", "Pip", "Solace", "Terrace", "Helper"])
    expect(excludedName(name, DEFAULT_EXCLUDE_WORDS), name).toBe(false);
});
