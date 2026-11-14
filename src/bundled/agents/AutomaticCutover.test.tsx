// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type CutoverCopy,
  type CutoverMode,
  cutoverOffer,
  setCutoverOffer,
  takeCutover,
} from "../../features/agents/cutover";
import { setRuntimeRecommendation } from "../../features/agents/recommended";
import type {
  Agent,
  Agents,
  AgentsSnapshot,
  RegisteredAgentType,
} from "../../features/agents/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import {
  ANSWERED_KEY,
  AutomaticCutover,
  CUTOVER_WINDOW_MS,
  resetCutoverLaunch,
  SAVE_MS,
} from "./AutomaticCutover";

// Sonner's swipe handling needs it; jsdom lacks it.
HTMLElement.prototype.setPointerCapture ??= () => {};

// Synthetic agents, models and copy; real copy comes only from a packager's plugin.
const OFFER = {
  mode: "centerModalDismissAccepts" as CutoverMode,
  copy: {
    title: "Keep your agent up to date",
    body: "Buzz will manage {agent}'s AI. It'll use {model} today.\nYou can opt out.",
    acceptLabel: "Sounds good",
    optOutLabel: "Opt out",
  },
  excludeWords: ["GPT", "Codex"],
};
/** Any ISO 8601 time: when it was answered. */
const AT = expect.stringMatching(/^\d{4}-\d\d-\d\dT/);
const CANDIDATE = {
  harness: "codex",
  model: "model-a",
  effort: "high",
  label: "Model A",
};
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
    config: { model: "model-x", effort: "low", instructions: "Be brief." },
    configBase: { settings: "head-1" },
    ...change,
  }) as Agent;

function fixture({
  agents = [agent()],
  ready = true,
  save = vi.fn(async () => {}),
}: {
  agents?: readonly Agent[];
  /** Whether the harness can run the candidate now, or a check to hold. */
  ready?: boolean | (() => Promise<boolean>);
  save?: ReturnType<typeof vi.fn>;
} = {}) {
  let snapshot = {
    status: "ready",
    agents,
    running: agents,
    interrupted: [],
    teams: [],
  } as unknown as AgentsSnapshot;
  const listeners = new Set<() => void>();
  /** Another device's change arriving. */
  const update = (next: readonly Agent[]) => {
    snapshot = { ...snapshot, agents: next, running: next };
    for (const listener of listeners) listener();
  };
  const types = [
    {
      key: "buzz.codex/codex",
      id: "codex",
      title: "Codex",
      icon: () => <svg data-testid="harness-mark" />,
      recommends: vi.fn(async () =>
        typeof ready === "function" ? ready() : ready,
      ),
    },
  ] as unknown as readonly RegisteredAgentType[];
  const service = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    types: () => types,
    save,
  } as unknown as Agents;
  const view = render(<AutomaticCutover agents={service} />, {
    wrapper: ToastProvider,
  });
  return { save, view, service, update };
}

beforeEach(() => {
  localStorage.clear();
  resetCutoverLaunch();
  setRuntimeRecommendation({
    recommendedBy: "Example Org",
    candidates: [CANDIDATE],
  });
  setCutoverOffer(OFFER);
});
afterEach(() => {
  cleanup();
  setCutoverOffer(undefined);
  setRuntimeRecommendation(undefined);
});

it("shows the offer for a qualifying agent, naming today's model, with Accept focused", async () => {
  fixture();
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("Keep your agent up to date");
  expect(dialog).toHaveTextContent(
    "Buzz will manage Agent A's AI. It'll use Model A today.",
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Sounds good" })).toHaveFocus(),
  );
});

it("never shows a kind it doesn't know, such as the dropped centerModalAutoAccept", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(() =>
      setCutoverOffer({ ...OFFER, mode: "centerModalAutoAccept" }),
    ).toThrow("mode");
    // A plugin's answer naming it, the way it really arrives: the setup is
    // kept and the offer dropped.
    const setup = { recommendedBy: "Example Org", candidates: [CANDIDATE] };
    expect(
      takeCutover({
        ...setup,
        cutover: { ...OFFER, mode: "centerModalAutoAccept" },
      }),
    ).toEqual(setup);
    expect(cutoverOffer()).toBeUndefined();
    const { save } = fixture();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

it("Accept switches the agent to Automatic through the usual save and keeps its previous settings", async () => {
  const user = userEvent.setup();
  const { save, view, service } = fixture();
  await user.click(await screen.findByRole("button", { name: "Sounds good" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith("a".repeat(64), {
    config: {
      instructions: "Be brief.",
      preset: "recommended",
      cutover: {
        answer: "accepted",
        at: AT,
        mode: "centerModalDismissAccepts",
        previous: { model: "model-x", effort: "low" },
      },
    },
    base: { settings: "head-1" },
  });
  expect(JSON.parse(localStorage.getItem(ANSWERED_KEY) ?? "{}")).toEqual({
    ["a".repeat(64)]: "accepted",
  });
  // After a reload, this device's record alone keeps it from showing again.
  view.unmount();
  resetCutoverLaunch();
  render(<AutomaticCutover agents={service} />, { wrapper: ToastProvider });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("Opt out leaves the agent's model settings and records the answer", async () => {
  const user = userEvent.setup();
  const { save } = fixture();
  await user.click(await screen.findByRole("button", { name: "Opt out" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(save).toHaveBeenCalledWith("a".repeat(64), {
    config: {
      model: "model-x",
      effort: "low",
      instructions: "Be brief.",
      cutover: {
        answer: "declined",
        at: AT,
        mode: "centerModalDismissAccepts",
      },
    },
    base: { settings: "head-1" },
  });
  expect(JSON.parse(localStorage.getItem(ANSWERED_KEY) ?? "{}")).toEqual({
    ["a".repeat(64)]: "declined",
  });
});

it("keeps the offer when Accept fails, and never traps the person: Opt out closes even offline", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {
    throw new Error("Connect to the community to save");
  });
  fixture({ save });
  await user.click(await screen.findByRole("button", { name: "Sounds good" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t switch Agent A: Connect to the community to save",
  );
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Opt out" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(JSON.parse(localStorage.getItem(ANSWERED_KEY) ?? "{}")).toEqual({
    ["a".repeat(64)]: "declined",
  });
});

it("after a failed or stuck Accept, Not now closes it without an answer, so a later launch asks again", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const save = vi.fn(() => new Promise<void>(() => {}));
    fixture({ save });
    await user.click(
      await screen.findByRole("button", { name: "Sounds good" }),
    );
    await vi.advanceTimersByTimeAsync(SAVE_MS);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t switch Agent A: saving took too long",
    );
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(localStorage.getItem(ANSWERED_KEY)).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("closes when another device answers or switches the agent, and decides once per launch", async () => {
  const { view, service, update } = fixture();
  await screen.findByRole("alertdialog");
  act(() =>
    update([
      agent({
        config: { model: "model-x", cutover: { answer: "declined" } },
      }),
    ]),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  // A remount in the same launch, such as signing in again, never asks.
  act(() => update([agent()]));
  view.unmount();
  render(<AutomaticCutover agents={service} />, { wrapper: ToastProvider });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("offers nothing without a plugin's offer, to excluded names, two agents, an unready harness or an answered agent", async () => {
  const cases: (() => ReturnType<typeof fixture>)[] = [
    () => {
      setCutoverOffer(undefined);
      return fixture();
    },
    () => fixture({ agents: [agent({ name: "GPT helper" })] }),
    () => fixture({ agents: [agent({ name: "Agent 6.1" })] }),
    () =>
      fixture({
        agents: [agent(), agent({ pubkey: "c".repeat(64), name: "Agent C" })],
      }),
    () => fixture({ ready: false }),
    () =>
      fixture({
        agents: [
          agent({
            config: { model: "model-x", cutover: { answer: "declined" } },
          }),
        ],
      }),
  ];
  for (const make of cases) {
    resetCutoverLaunch();
    const { save, view } = make();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(save).not.toHaveBeenCalled();
    view.unmount();
    setCutoverOffer(OFFER);
  }
});

/** Lets the offer's effects run when nothing should show. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const withMode = (mode: CutoverMode, copy: Partial<CutoverCopy> = {}) =>
  setCutoverOffer({ ...OFFER, mode, copy: { ...OFFER.copy, ...copy } });

it("centerModalDismissAccepts can be dismissed, and dismissing switches the agent", async () => {
  const user = userEvent.setup();
  withMode("centerModalDismissAccepts");
  const { save } = fixture();
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("It'll use Model A today.");
  expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Sounds good" })).toHaveFocus(),
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith("a".repeat(64), {
    config: {
      instructions: "Be brief.",
      preset: "recommended",
      cutover: {
        answer: "auto_accepted",
        at: AT,
        mode: "centerModalDismissAccepts",
        previous: { model: "model-x", effort: "low" },
      },
    },
    base: { settings: "head-1" },
  });
  expect(JSON.parse(localStorage.getItem(ANSWERED_KEY) ?? "{}")).toEqual({
    ["a".repeat(64)]: "auto_accepted",
  });
});

it("centerModalDismissAccepts: its buttons accept or opt out, and only Opt out avoids the switch", async () => {
  const user = userEvent.setup();
  for (const [button, answer] of [
    ["Sounds good", "accepted"],
    ["Opt out", "declined"],
  ] as const) {
    localStorage.clear();
    resetCutoverLaunch();
    withMode("centerModalDismissAccepts");
    const { save, view } = fixture();
    await user.click(await screen.findByRole("button", { name: button }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const [[, { config }]] = save.mock.calls as [[string, { config: object }]];
    expect(config).toMatchObject({
      cutover: { answer, mode: "centerModalDismissAccepts" },
    });
    expect("preset" in config).toBe(answer === "accepted");
    view.unmount();
  }
});

it("toastAutoApplied switches first, then says so; Opt out puts the agent back", async () => {
  withMode("toastAutoApplied", { acceptLabel: "Got it", optOutLabel: "Undo" });
  const { save, update } = fixture({
    save: vi.fn(async (_key: string, { config }: { config: object }) => {
      update([agent({ config: config as Agent["config"] })]);
    }),
  });
  const notice = await screen.findByRole("dialog");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(notice).toHaveTextContent("Keep your agent up to date");
  expect(notice).toHaveTextContent("It'll use Model A today.");
  expect(save).toHaveBeenNthCalledWith(1, "a".repeat(64), {
    config: {
      instructions: "Be brief.",
      preset: "recommended",
      cutover: {
        answer: "auto_accepted",
        at: AT,
        mode: "toastAutoApplied",
        previous: { model: "model-x", effort: "low" },
      },
    },
    base: { settings: "head-1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(save).toHaveBeenNthCalledWith(2, "a".repeat(64), {
    config: {
      model: "model-x",
      effort: "low",
      instructions: "Be brief.",
      cutover: { answer: "declined", at: AT, mode: "toastAutoApplied" },
    },
    base: { settings: "head-1" },
  });
  expect(JSON.parse(localStorage.getItem(ANSWERED_KEY) ?? "{}")).toEqual({
    ["a".repeat(64)]: "declined",
  });
});

it("toastAutoApplied: dismissing or Got it keeps the switch; a failed switch shows nothing and records nothing", async () => {
  for (const button of ["Got it", "Dismiss"]) {
    localStorage.clear();
    resetCutoverLaunch();
    withMode("toastAutoApplied", { acceptLabel: "Got it" });
    const { save, update, view } = fixture({
      save: vi.fn(async (_key: string, { config }: { config: object }) => {
        update([agent({ config: config as Agent["config"] })]);
      }),
    });
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).toHaveBeenCalledTimes(1);
    view.unmount();
  }
  localStorage.clear();
  resetCutoverLaunch();
  withMode("toastAutoApplied");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const save = vi.fn(async () => {
      throw new Error("Connect to the community to save");
    });
    fixture({ save });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(localStorage.getItem(ANSWERED_KEY)).toBeNull();
  } finally {
    warn.mockRestore();
  }
});

it("optInPrompt changes nothing until the person says yes", async () => {
  withMode("optInPrompt", {
    acceptLabel: "Yes, manage it for me",
    optOutLabel: "No thanks",
  });
  const { save } = fixture();
  const notice = await screen.findByRole("dialog");
  expect(notice).toHaveTextContent("It'll use Model A today.");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await settle();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Yes, manage it for me" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(save).toHaveBeenCalledWith("a".repeat(64), {
    config: {
      instructions: "Be brief.",
      preset: "recommended",
      cutover: {
        answer: "accepted",
        at: AT,
        mode: "optInPrompt",
        previous: { model: "model-x", effort: "low" },
      },
    },
    base: { settings: "head-1" },
  });
});

it("optInPrompt: No thanks, or dismissing it, is a no", async () => {
  for (const [button, index] of [
    ["No thanks", 0],
    ["Dismiss", 0],
  ] as const) {
    localStorage.clear();
    resetCutoverLaunch();
    withMode("optInPrompt", { optOutLabel: "No thanks" });
    const { save, view } = fixture();
    await screen.findByRole("dialog");
    const target = screen.getAllByRole("button", { name: button })[index];
    if (!target) throw new Error(`No ${button} button ${index}`);
    fireEvent.click(target);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith("a".repeat(64), {
      config: {
        model: "model-x",
        effort: "low",
        instructions: "Be brief.",
        cutover: { answer: "declined", at: AT, mode: "optInPrompt" },
      },
      base: { settings: "head-1" },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    view.unmount();
  }
});

it("every mode fills the agent's name and model into the title too", async () => {
  let update = (_next: readonly Agent[]) => {};
  for (const mode of [
    "centerModalDismissAccepts",
    "toastAutoApplied",
    "optInPrompt",
  ] as const) {
    localStorage.clear();
    resetCutoverLaunch();
    withMode(mode, { title: "{agent} on {model}" });
    // The usual save: the agent then has the saved config.
    const made = fixture({
      save: vi.fn(async (_key: string, { config }: { config: object }) => {
        update([agent({ config: config as Agent["config"] })]);
      }),
    });
    update = made.update;
    const { view } = made;
    expect(
      await screen.findByText("Agent A on Model A", undefined, {
        timeout: 2000,
      }),
    ).toBeInTheDocument();
    view.unmount();
  }
});

it("every mode shows what the agent would run on, as the Uses line does: harness, model and thinking level", async () => {
  for (const mode of [
    "centerModalDismissAccepts",
    "toastAutoApplied",
    "optInPrompt",
  ] as const) {
    localStorage.clear();
    resetCutoverLaunch();
    withMode(mode, { usesLabel: "Starting with" });
    let update = (_next: readonly Agent[]) => {};
    const made = fixture({
      save: vi.fn(async (_key: string, { config }: { config: object }) => {
        update([agent({ config: config as Agent["config"] })]);
      }),
    });
    update = made.update;
    const chip = await screen.findByTitle("Codex: Model A · High");
    expect(chip).toHaveTextContent("Model A · High");
    expect(screen.getByText("Starting with")).toBeInTheDocument();
    expect(screen.getByTestId("harness-mark")).toBeInTheDocument();
    made.view.unmount();
  }
  // Without a label, the generic one.
  localStorage.clear();
  resetCutoverLaunch();
  withMode("centerModalDismissAccepts");
  fixture();
  expect(await screen.findByText("Uses")).toBeInTheDocument();
});

it("uses the offer's own Not now and Dismiss labels", async () => {
  const user = userEvent.setup();
  withMode("centerModalDismissAccepts", { notNowLabel: "Ask me later" });
  const save = vi.fn(async () => {
    throw new Error("Connect to the community to save");
  });
  const { view } = fixture({ save });
  await user.click(await screen.findByRole("button", { name: "Sounds good" }));
  expect(
    await screen.findByRole("button", { name: "Ask me later" }),
  ).toBeInTheDocument();
  view.unmount();
  localStorage.clear();
  resetCutoverLaunch();
  withMode("optInPrompt", { dismissLabel: "Close this" });
  fixture();
  expect(
    await screen.findByRole("button", { name: "Close this" }),
  ).toBeInTheDocument();
});

it("saves once when Yes and the notice's Close come together", async () => {
  withMode("optInPrompt", {
    acceptLabel: "Yes, manage it for me",
    dismissLabel: "Close",
  });
  let finish = () => {};
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  fixture({ save });
  await screen.findByRole("dialog");
  fireEvent.click(
    screen.getByRole("button", { name: "Yes, manage it for me" }),
  );
  // Its Close is gone while saving; a stray one would do nothing either.
  const close = screen.queryByRole("button", { name: "Close" });
  if (close) fireEvent.click(close);
  await act(async () => finish());
  expect(save).toHaveBeenCalledTimes(1);
  const [[, { config }]] = save.mock.calls as unknown as [
    [string, { config: object }],
  ];
  expect(config).toMatchObject({ cutover: { answer: "accepted" } });
});

it("toastAutoApplied: a slow switch still ends with the notice, and a remount keeps it", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    withMode("toastAutoApplied", { acceptLabel: "Got it" });
    let finish = () => {};
    let update = (_next: readonly Agent[]) => {};
    const made = fixture({
      save: vi.fn(
        (_key: string, { config }: { config: object }) =>
          new Promise<void>((resolve) => {
            finish = () => {
              update([agent({ config: config as Agent["config"] })]);
              resolve();
            };
          }),
      ),
    });
    update = made.update;
    await waitFor(() => expect(made.save).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(SAVE_MS + 1000);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => finish());
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Keep your agent up to date",
    );
    // Remounted in the same launch: the notice is still there, and nothing
    // is switched again.
    made.view.unmount();
    render(<AutomaticCutover agents={made.service} />, {
      wrapper: ToastProvider,
    });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(made.save).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("toastAutoApplied: remounted while its switch is saving, it still shows the notice", async () => {
  withMode("toastAutoApplied", { acceptLabel: "Got it" });
  let finish = () => {};
  let update = (_next: readonly Agent[]) => {};
  const made = fixture({
    save: vi.fn(
      (_key: string, { config }: { config: object }) =>
        new Promise<void>((resolve) => {
          finish = () => {
            update([agent({ config: config as Agent["config"] })]);
            resolve();
          };
        }),
    ),
  });
  update = made.update;
  await waitFor(() => expect(made.save).toHaveBeenCalledTimes(1));
  made.view.unmount();
  render(<AutomaticCutover agents={made.service} />, {
    wrapper: ToastProvider,
  });
  await act(async () => finish());
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "Keep your agent up to date",
  );
  expect(made.save).toHaveBeenCalledTimes(1);
});

it("after a timed-out Accept, saves nothing else until that save settles", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let finish = () => {};
    let update = (_next: readonly Agent[]) => {};
    const made = fixture({
      save: vi.fn(
        (_key: string, { config }: { config: object }) =>
          new Promise<void>((resolve) => {
            finish = () => {
              update([agent({ config: config as Agent["config"] })]);
              resolve();
            };
          }),
      ),
    });
    update = made.update;
    await user.click(
      await screen.findByRole("button", { name: "Sounds good" }),
    );
    await vi.advanceTimersByTimeAsync(SAVE_MS);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "saving took too long",
    );
    // Opt out and Accept wait for the first save; Not now may leave.
    expect(screen.getByRole("button", { name: "Opt out" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sounds good" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled();
    // The late save lands: the agent is switched, as chosen, and it closes.
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(made.save).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("optInPrompt can't be closed while its answer is saving", async () => {
  withMode("optInPrompt", { acceptLabel: "Yes, manage it for me" });
  let finish = () => {};
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  fixture({ save });
  await screen.findByRole("dialog");
  expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Yes, manage it for me" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull(),
  );
  await act(async () => finish());
});

it("toastAutoApplied checks again before switching: a second agent that appeared meanwhile stops it", async () => {
  withMode("toastAutoApplied");
  let release = (_ready: boolean) => {};
  let held = false;
  const { save, update } = fixture({
    ready: () =>
      new Promise<boolean>((resolve) => {
        held = true;
        release = resolve;
      }),
  });
  // Matched with one agent; while its harness check runs, a second appears.
  await waitFor(() => expect(held).toBe(true));
  act(() =>
    update([agent(), agent({ pubkey: "c".repeat(64), name: "Agent C" })]),
  );
  await act(async () => release(true));
  await settle();
  expect(save).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("offers nothing once the start-up window has passed", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    // The setup became final, but the agents only loaded after the window.
    const made = fixture({ agents: [] });
    await vi.advanceTimersByTimeAsync(CUTOVER_WINDOW_MS + 1000);
    act(() => made.update([agent()]));
    await vi.advanceTimersByTimeAsync(50);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(made.save).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("toastAutoApplied: the notice closes when another device undoes the switch", async () => {
  withMode("toastAutoApplied");
  let update = (_next: readonly Agent[]) => {};
  const made = fixture({
    save: vi.fn(async (_key: string, { config }: { config: object }) => {
      update([agent({ config: config as Agent["config"] })]);
    }),
  });
  update = made.update;
  await screen.findByRole("dialog");
  act(() =>
    made.update([
      agent({ config: { model: "model-x", cutover: { answer: "declined" } } }),
    ]),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(made.save).toHaveBeenCalledTimes(1);
});
