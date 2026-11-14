import {
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  COPY_DEFAULTS,
  type CutoverAnswer,
  cutoverMatch,
  cutoverOf,
  cutoverOffer,
  type CutoverOffer,
  fillCopy,
  switchedConfig,
  undoneConfig,
  withCutover,
} from "../../features/agents/cutover";
import { usesValue } from "../../features/agents/AISettings";
import {
  onRecommended,
  pickRecommended,
  type RecommendedCandidate,
  recommendationReady,
} from "../../features/agents/recommended";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { ValueChip } from "../../shared/design-system/ui/ValueChip";

/** How long after the setup is final a launch may still offer the switch, so
 * it comes at start-up and never in the middle of later work. */
export const CUTOVER_WINDOW_MS = 30_000;
/** This device's answers, by agent pubkey, so a save that failed (such as
 * opting out offline) never asks here again. */
export const ANSWERED_KEY = "buzz.agents.automatic-cutover";

function answeredHere(): Record<string, CutoverAnswer> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(ANSWERED_KEY) ?? "{}",
    );
    return value && typeof value === "object"
      ? (value as Record<string, CutoverAnswer>)
      : {};
  } catch {
    return {};
  }
}
function answerHere(pubkey: string, answer: CutoverAnswer) {
  try {
    localStorage.setItem(
      ANSWERED_KEY,
      JSON.stringify({ ...answeredHere(), [pubkey]: answer }),
    );
  } catch {
    /* The synced answer, if saved, still covers it. */
  }
}

type Target = Readonly<{
  agent: Agent;
  type: RegisteredAgentType;
  offer: CutoverOffer;
}>;
/** With what it would run on today: none ready, no offer. */
type Shown = Target & Readonly<{ candidate: RecommendedCandidate }>;

/** How long a save the person waits on may take before it counts as failed,
 * so a stuck save never keeps anyone here. */
export const SAVE_MS = 15_000;
const TOO_LONG = "saving took too long";
const within = <T,>(work: Promise<T>) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(TOO_LONG)), SAVE_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/** This launch's, so a remount never asks again, reopens the window, or
 * loses a notice already shown: when the setup became final, whether the
 * offer was decided, what is shown, whether `toastAutoApplied` is switching
 * or switched, and whether it was closed. */
let launch: {
  readyAt?: number;
  decided?: boolean;
  shown?: Shown;
  switching?: boolean;
  applied?: boolean;
  closed?: boolean;
} = {};
/** Every mounted instance, told when `launch` changes, so one mounted after
 * another started the toast's switch still shows its notice. */
const launchListeners = new Set<() => void>();
const launchChanged = () => {
  for (const listener of launchListeners) listener();
};
/** For tests: a new launch. */
export const resetCutoverLaunch = () => {
  launch = {};
};

const message = (failure: unknown) =>
  failure instanceof Error ? failure.message : "try again";

/** What the agent would run on (or, after `toastAutoApplied`, now runs on),
 * the way Create agent's Uses line shows it: the harness's mark, the model
 * and its thinking level. */
function Uses({ label, shown }: { label: string; shown: Shown }) {
  const Icon = shown.type.icon;
  const value = usesValue(shown.candidate);
  return (
    <span className="flex items-center gap-2 text-body-sm">
      <span className="text-subtle">{label}</span>
      <ValueChip
        icon={Icon ? <Icon size={14} /> : undefined}
        label={shown.type.title}
        title={`${shown.type.title}: ${value}`}
      >
        {value}
      </ValueChip>
    </span>
  );
}

/** A bundled plugin's one-time offer to switch the person's only agent to
 * Automatic (cutover.ts), shown at start-up when that agent qualifies, the way
 * the offer's `mode` says, with the plugin's words and what it would run on.
 * Every answer is recorded on the agent, with when and how it was asked, and
 * on this device, so it never shows again. A switch goes through the usual
 * save and keeps the agent's previous model settings; one the person waits
 * on that fails offers Not now, which records nothing, so a later launch asks
 * again. Builds without such a plugin never show it. */
export function AutomaticCutover({ agents }: { agents: Agents }) {
  const snapshot = useSyncExternalStore(agents.subscribe, agents.snapshot);
  const types = useSyncExternalStore(agents.subscribe, agents.types);
  const [readyAt, setReadyAt] = useState(launch.readyAt);
  const [target, setTarget] = useState<Target>();
  const [shown, setShown] = useState(launch.shown);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    launchListeners.add(rerender);
    return () => {
      launchListeners.delete(rerender);
    };
  }, []);
  /** `toastAutoApplied` only: the switch was saved, so the notice shows. */
  const applied = !!launch.applied;
  const closed = !!launch.closed;
  /** A save the person waits on is running, so nothing can close it. */
  const [saving, setSaving] = useState(false);
  /** That save took too long and the person may leave (Not now), but it is
   * still running, so no other answer can be saved until it settles. */
  const [stuck, setStuck] = useState(false);
  const [error, setError] = useState("");
  const accept = useRef<HTMLButtonElement>(null);
  /** One save at a time, until it really settles: a second click or a
   * dismiss while saving does nothing. */
  const busy = useRef(false);
  const setApplied = () => {
    launch.applied = true;
    launchChanged();
  };
  const setClosed = () => {
    launch.closed = true;
    launchChanged();
  };

  useEffect(() => {
    if (launch.readyAt !== undefined) return;
    let live = true;
    void recommendationReady().then(() => {
      launch.readyAt ??= Date.now();
      if (live) setReadyAt(launch.readyAt);
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (readyAt === undefined || launch.decided || target) return;
    const offer = cutoverOffer();
    if (!offer || Date.now() - readyAt > CUTOVER_WINDOW_MS) {
      launch.decided = true;
      return;
    }
    if (snapshot.status !== "ready") return;
    const answered = answeredHere();
    const match = cutoverMatch(
      [...snapshot.agents, ...snapshot.running],
      types,
      offer,
      (pubkey) => pubkey in answered,
    );
    if (!match.offer) return;
    launch.decided = true;
    setTarget({ agent: match.agent, type: match.type, offer });
  }, [readyAt, target, snapshot, types]);
  useEffect(() => {
    if (!target) return;
    let live = true;
    void pickRecommended([target.type]).then((pick) => {
      if (!live || !pick) return;
      launch.shown = { ...target, candidate: pick.candidate };
      setShown(launch.shown);
    });
    return () => {
      live = false;
    };
  }, [target]);

  // The agent as it is now.
  const current =
    shown &&
    [...snapshot.agents, ...snapshot.running].find(
      (item) => item.key === shown.agent.key,
    );
  const mode = shown?.offer.mode;
  const send = (config: object) =>
    current
      ? agents.save(current.key, {
          config,
          ...(current.configBase ? { base: current.configBase } : {}),
        })
      : Promise.resolve();

  // toastAutoApplied: switch first, then say so. Nobody waits on it, so it
  // has no time limit: a slow save still ends with the notice. One that
  // fails shows nothing and records nothing, so a later launch tries again.
  useEffect(() => {
    if (mode !== "toastAutoApplied" || !current) return;
    if (launch.switching || launch.applied || launch.closed) return;
    if (cutoverOf(current.config) || onRecommended(current.config)) return;
    // It changes things without asking, so the rules are checked again on
    // the latest list (a second agent may have appeared since): no longer
    // qualifying, it does nothing this launch.
    const answered = answeredHere();
    const again = shown
      ? cutoverMatch(
          [...snapshot.agents, ...snapshot.running],
          types,
          shown.offer,
          (pubkey) => pubkey in answered,
        )
      : undefined;
    if (!again?.offer || again.agent.key !== current.key) {
      setClosed();
      return;
    }
    launch.switching = true;
    void send(
      switchedConfig(current.config as object, "auto_accepted", mode),
    ).then(
      () => {
        answerHere(current.pubkey, "auto_accepted");
        setApplied();
      },
      () => {
        // A fixed line: the error may name the agent.
        console.warn("Couldn't switch the agent to Automatic");
        setClosed();
      },
    );
  });

  // Answered or switched elsewhere closes it for this launch; after its own
  // switch, the notice stays until it is undone (here or elsewhere).
  const record = current && cutoverOf(current.config);
  const settled =
    !!current &&
    (mode === "toastAutoApplied"
      ? applied &&
        (record?.answer !== "auto_accepted" || !onRecommended(current.config))
      : !!record || onRecommended(current.config));
  useEffect(() => {
    if (settled) launch.closed = true;
  }, [settled]);

  if (!shown || !current || closed || settled) return null;
  // toastAutoApplied: nothing to show until its switch is saved.
  if (mode === "toastAutoApplied" && !applied) return null;

  const { offer } = shown;
  const copy = { ...COPY_DEFAULTS, ...offer.copy };
  const fill = (text: string) =>
    fillCopy(text, current.name, shown.candidate.label);
  const answer = async (choice: CutoverAnswer) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError("");
    const config = current.config as object;
    const work = send(
      mode === "toastAutoApplied"
        ? undoneConfig(config, offer.mode)
        : choice === "declined"
          ? withCutover(config, choice, { mode: offer.mode })
          : switchedConfig(config, choice, offer.mode),
    );
    // However long it takes, nothing else is saved until it settles, so a
    // late save can't race a second answer.
    void work
      .catch(() => {})
      .finally(() => {
        busy.current = false;
        setStuck(false);
      });
    try {
      await within(work);
    } catch (failure) {
      setSaving(false);
      if (failure instanceof Error && failure.message === TOO_LONG)
        setStuck(true);
      // Opting out of a switch that never happened changes nothing, so it
      // never keeps the person here.
      if (choice !== "declined" || mode === "toastAutoApplied") {
        setError(
          choice === "declined"
            ? `Couldn’t put ${current.name} back: ${message(failure)}`
            : `Couldn’t switch ${current.name}: ${message(failure)}`,
        );
        return;
      }
    }
    answerHere(current.pubkey, choice);
    setClosed();
  };
  // Records nothing; a save still running lands, as the person chose.
  const notNow = () => setClosed();
  const problem = error && (
    <p role="alert" className="m-0 text-body-sm text-danger">
      {error}
    </p>
  );
  const uses = <Uses label={fill(copy.usesLabel)} shown={shown} />;
  const toast = mode === "toastAutoApplied" || mode === "optInPrompt";
  const optOut = (
    <Button
      {...(toast ? { size: "compact" as const } : {})}
      disabled={saving || stuck}
      onClick={() => void answer("declined")}
    >
      {fill(copy.optOutLabel)}
    </Button>
  );

  if (toast)
    return (
      <ToastNotice
        tone="info"
        title={fill(copy.title)}
        description={fill(copy.body)}
        details={
          <div className="grid gap-2">
            {uses}
            {problem}
          </div>
        }
        closeLabel={fill(copy.dismissLabel)}
        // Dismissing it: a no for the prompt; the switch stays for the
        // notice. After a failure it is Not now, and records nothing. Not
        // while saving, so a failure can still be shown.
        {...(saving
          ? {}
          : {
              onDismiss: () =>
                error || mode === "toastAutoApplied"
                  ? notNow()
                  : void answer("declined"),
            })}
      >
        {optOut}
        <Button
          size="compact"
          variant="prominent"
          loading={saving && mode === "optInPrompt"}
          disabled={saving || (stuck && mode === "optInPrompt")}
          onClick={() =>
            mode === "optInPrompt" ? void answer("accepted") : notNow()
          }
        >
          {fill(copy.acceptLabel)}
        </Button>
      </ToastNotice>
    );

  const actions = (
    <>
      {optOut}
      {error && (
        <Button disabled={saving} onClick={notNow}>
          {fill(copy.notNowLabel)}
        </Button>
      )}
      <Button
        ref={accept}
        variant="prominent"
        loading={saving}
        disabled={stuck}
        onClick={() => void answer("accepted")}
      >
        {fill(copy.acceptLabel)}
      </Button>
    </>
  );
  const description = (
    <span className="grid gap-3">
      <span style={{ whiteSpace: "pre-line" }}>{fill(copy.body)}</span>
      {uses}
    </span>
  );
  // centerModalDismissAccepts: the only centered one.
  return (
    <AlertDialog
      title={fill(copy.title)}
      description={description}
      pending={saving}
      initialFocus={accept}
      // Dismissing it switches too; after a failure it is Not now.
      onClose={() => (error ? notNow() : void answer("auto_accepted"))}
      actions={actions}
    >
      {problem}
    </AlertDialog>
  );
}
