import { h as e } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { User } from "../types/auth";
import { readState, changes, type State, type Revision } from "../storage";
import {
  createVault,
  openVault,
  closeVault,
  saveNote,
  readNote,
  vaultName,
  heads,
  synchronize,
  transferVault,
  readStash,
  moveStash,
  discardStash,
  discardPurgedObjects,
  registerDraftFlush,
  edit,
  hasUnsaved,
  closeAllVault,
  resolveConflict,
  renameDevice,
  acknowledgeReminder,
  readTags,
  createTag,
  renameTag,
  deleteTag,
  copyNote,
  readVaultPushMode,
  setVaultPushMode,
  archiveNote,
  restoreArchivedNote,
  trashNote,
  restoreTrashedNote,
  permanentlyDeleteNote,
  noteHistory,
  restoreNoteVersion,
  noteLifecycle,
  outboxReviewItems,
  decideOutboxReview,
  OutboxReviewRequired,
  enableSystemUnlock,
  unlockVaultSystem,
  lockVault,
  forgetSystemUnlock,
  setSystemAutoLock,
  lockAfterBackground,
  deleteVault,
  vaultEntryMode,
  enableVaultSharing,
  entityKind,
  uploadAttachment,
  attachmentBlob,
  attachmentPlainStream,
  attachmentPreviewBlob,
  deleteAttachmentFile,
  moveAttachmentFile,
  type Note,
  type NoteAttachment,
  type TagDefinition,
  type VaultPushMode,
  type NoteLifecycleState,
  type OutboxReviewItem,
} from "../planner";
import { AUTO_LOCK_VALUES, type AutoLockMs } from "../crypto/system-unlock";
import { localTime } from "../../shared/reminders.mjs";
import type {
  ReminderPlan,
  ReminderRepeat,
  ReminderEnd,
} from "../../shared/reminders.mjs";
import {
  reminderRequest,
  type ReminderSettings,
  type ReminderStatus,
  type ReminderTarget,
} from "../reminders";
import {
  Attachments,
  plainToHtml,
  RichTextEditor,
  sanitizeNoteHtml,
} from "./RichTextEditor";
import { PageHeader, StatusDot, UiIcon } from "./ui.ts";
import { noteSearchScore } from "../search";
import { AuthError } from "../auth";
import {
  createNoteZipBlob,
  noteZipFileName,
  type PortableAttachmentStream,
} from "../portable";
import {
  changeMemberRole,
  collaborationIsUnlocked,
  contactState,
  createComment,
  deleteComment,
  inviteToVault,
  leaveSharedVault,
  loadComments,
  loadOwnerKeyring,
  removeVaultMember,
  regrantMember,
  sharedVaultMembers,
  trustFingerprint,
  unlockMemberVault,
  updateComment,
  ContactKeyChanged,
  type ContactInfo,
  type DecryptedComment,
  type VaultMemberInfo,
} from "../collaboration.ts";
import type { ShellVaultContext } from "./AppShell.ts";
import { appConfirm, appPrompt } from "./AppDialog.ts";
import { TagPicker } from "./TagPicker.ts";

interface Draft extends Note {
  vault: string;
  object: string;
  revision: string | null;
  dirty: boolean;
  key: CryptoKey;
  editorMode?: "create" | "edit";
}
interface OpenedNote extends Note {
  vault: string;
  object: string;
  revision: string;
  key: CryptoKey;
}
interface HistoryState {
  vault: string;
  objectId: string;
  back: "list" | "archive" | "trash";
  selected: string;
  entries: { revision: Revision; note: Note }[];
}
function BlobImage({
  load,
  alt,
  className,
  cacheKey,
}: {
  load: () => Promise<Blob | null>;
  alt: string;
  className: string;
  cacheKey: string;
}) {
  const [url, setUrl] = useState(""),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true,
      current = "";
    setUrl("");
    setFailed(false);
    void load()
      .then((blob) => {
        if (!active || !blob) return;
        current = URL.createObjectURL(blob);
        setUrl(current);
      })
      .catch(() => {});
    return () => {
      active = false;
      if (current) URL.revokeObjectURL(current);
    };
  }, [cacheKey]);
  return url && !failed
    ? e("img", {
        src: url,
        alt,
        class: className,
        loading: "lazy",
        onError: () => setFailed(true),
      })
    : null;
}
export function Planner({
  user,
  section = "notes",
  initialScreen = "list",
  reminderTarget,
  onReminderHandled,
  onSyncState,
  onOpenProjects,
  onVaultContextChange,
  onNavigationGuardChange,
}: {
  user: User;
  section?: "notes" | "today";
  initialScreen?: "list" | "archive" | "trash";
  reminderTarget?: ReminderTarget;
  onReminderHandled: () => void;
  onOpenProjects?: () => void;
  onVaultContextChange?: (context: ShellVaultContext | null) => void;
  onNavigationGuardChange?: (
    guard: (() => Promise<boolean>) | null,
  ) => void;
  onSyncState: (
    state: "syncing" | "online" | "offline" | "auth" | "error" | "idle",
  ) => void;
}) {
  const [state, setState] = useState<State>();
  const stateRef = useRef<State>();
  stateRef.current = state;
  const hiddenAt = useRef<number | null>(null);
  const backgroundLockTimer = useRef<ReturnType<typeof setTimeout>>();
  const [names, setNames] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [tags, setTags] = useState<Record<string, TagDefinition[]>>({});
  const [pushDefaults, setPushDefaults] = useState<
    Record<string, VaultPushMode>
  >({});
  const [stash, setStash] = useState<Record<string, Note>>({});
  const [reviewItems, setReviewItems] = useState<OutboxReviewItem[]>([]);
  const [selected, setSelected] = useState("");
  const selectedRef = useRef("");
  selectedRef.current = selected;
  const selectionInitialized = useRef(false);
  const automaticCreateScreen = useRef(false);
  const vaultFlowReturn = useRef<"list" | "choose-vault">("list");
  const unlockReturn = useRef<{
    screen: "list" | "schedule" | "choose-vault";
    vaultId: string;
  }>({ screen: "choose-vault", vaultId: "" });
  const vaultActivationDestination = useRef<"list" | "schedule">("list");
  const startupUnlockHandled = useRef(false);
  const unlockAttempt = useRef(0);
  function select(vid: string) {
    selectionInitialized.current = true;
    setSelected(vid);
    setSelectedTags([]);
    setQuickFilter("all");
    if (vid)
      void edit(user, async (s) => {
        if (s.vaults.some((v) => v.header.id === vid && !v.deleted))
          s.lastVaultId = vid;
      }).catch(() => setError("Не удалось запомнить выбранное хранилище"));
  }
  const [screen, setScreen] = useState<
    | "list"
    | "choose-vault"
    | "create"
    | "open"
    | "transfer"
    | "stash"
    | "close-all"
    | "system-unlock"
    | "conflict"
    | "device"
    | "reminder"
    | "schedule"
    | "tags"
    | "archive"
    | "trash"
    | "history"
    | "outbox-review"
    | "sharing"
  >(section === "today" ? "schedule" : initialScreen);
  const [password, setPassword] = useState("");
  const [autoLockMs, setAutoLockMs] = useState<AutoLockMs>(900_000);
  const [comparison, setComparison] = useState<{
    objectId: string;
    versions: string[];
    chosen: string;
  }>();
  const [name, setName] = useState("");
  const [phrase, setPhrase] = useState("");
  const [repeat, setRepeat] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [target, setTarget] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  useEffect(() => {
    const guard = () => confirmDiscardEditing();
    onNavigationGuardChange?.(guard);
    return () => onNavigationGuardChange?.(null);
  }, [onNavigationGuardChange]);
  const tagEditorDraft = useRef<Draft | null>(null);
  const tagEditorReturn = useRef<"list" | "archive" | "trash" | "schedule">(
    "list",
  );
  const [viewing, setViewing] = useState<OpenedNote | null>(null);
  const viewingRef = useRef<OpenedNote | null>(null);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const localDateAfter = (days: number) =>
    new Date(
      Date.parse(localTime(Date.now(), zone).slice(0, 10) + "T00:00:00Z") +
        days * 86400000,
    )
      .toISOString()
      .slice(0, 10);
  const [reminderDate, setReminderDate] = useState(""),
    [reminderClock, setReminderClock] = useState("");
  const [reminderMode, setReminderMode] = useState<
      "neutral" | "custom" | "title"
    >("neutral"),
    [reminderText, setReminderText] = useState("");
  const [reminderConsent, setReminderConsent] = useState(false);
  const [serverReminders, setServerReminders] = useState<ReminderStatus[]>([]);
  const [reminderSettings, setReminderSettings] = useState<ReminderSettings>({
    zone,
    nudge_hours: 1,
    all_day_time: "09:00",
  });
  const [reminderAllDay, setReminderAllDay] = useState(false),
    [reminderImportant, setReminderImportant] = useState(false);
  const [reminderRepeat, setReminderRepeat] = useState<ReminderRepeat>({
      type: "once",
    }),
    [reminderEnd, setReminderEnd] = useState<ReminderEnd>({ type: "never" });
  const [selectedOccurrence, setSelectedOccurrence] = useState(""),
    [snoozeOpen, setSnoozeOpen] = useState(false),
    [snoozeLocal, setSnoozeLocal] = useState("");
  const [todayMenuOpen, setTodayMenuOpen] = useState(false),
    [todayPickOpen, setTodayPickOpen] = useState(false),
    [showReminderHistory, setShowReminderHistory] = useState(false);
  const [query, setQuery] = useState(""),
    [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [quickFilter, setQuickFilter] = useState<
      "all" | "pinned" | "untagged" | "reminder"
    >("all"),
    [sort, setSort] = useState<"newest" | "oldest" | "title">("newest");
  const [desktopMenu, setDesktopMenu] = useState<"filters" | "vault" | null>(
    null,
  );
  const [searchSort, setSearchSort] = useState<
    "relevance" | "newest" | "oldest"
  >("relevance");
  const [hideCompleted, setHideCompleted] = useState(false),
    [menuOpen, setMenuOpen] = useState(false);
  const [history, setHistory] = useState<HistoryState | null>(null);
  const [members, setMembers] = useState<VaultMemberInfo[]>([]),
    [sharingContacts, setSharingContacts] = useState<ContactInfo[]>([]);
  const [inviteUserId, setInviteUserId] = useState(""),
    [inviteRole, setInviteRole] = useState<"editor" | "viewer">("editor");
  const [comments, setComments] = useState<DecryptedComment[]>([]),
    [commentsOpen, setCommentsOpen] = useState(false);
  const [commentText, setCommentText] = useState(""),
    [commentHtml, setCommentHtml] = useState(""),
    [commentEditorVersion, setCommentEditorVersion] = useState(0);
  const [commentEdit, setCommentEdit] = useState<{
    id: string;
    text: string;
    html: string;
  } | null>(null);
  const [fileUpload, setFileUpload] = useState<{
    name: string;
    percent: number;
  } | null>(null);
  const uploadAbort = useRef<AbortController>();
  const [tagName, setTagName] = useState(""),
    [tagColor, setTagColor] = useState("#356AE6"),
    [editingTag, setEditingTag] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState<
    "local" | "syncing" | "synced" | "offline" | "error"
  >("local");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const saving = useRef<Promise<void> | null>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout>>(),
    syncAgain = useRef(false);
  const draggedChecklistItem = useRef<number | null>(null);
  const checklistTouchX = useRef<number | null>(null);
  const [checklistSwipe, setChecklistSwipe] = useState<{
    id: string;
    offset: number;
  } | null>(null);
  const reminderTouchX = useRef<number | null>(null);
  const [reminderSwipeOffset, setReminderSwipeOffset] = useState(0);
  const lifecycleTouchX = useRef<number | null>(null);
  const lifecycleSwipeWidth = useRef(0),
    lifecycleSwipeOffset = useRef(0),
    lifecycleSwipeStartOffset = useRef(0);
  const lifecycleSwipeMoved = useRef(false);
  const [lifecycleSwipe, setLifecycleSwipe] = useState<{
    id: string;
    offset: number;
    dragging: boolean;
  } | null>(null);
  const noteSwipeTouchX = useRef<number | null>(null),
    noteSwipeWidth = useRef(0),
    noteSwipeOffset = useRef(0),
    noteSwipeStartOffset = useRef(0),
    noteSwipeMoved = useRef(false);
  const [noteSwipe, setNoteSwipe] = useState<{
    id: string;
    offset: number;
    dragging: boolean;
  } | null>(null);
  const syncRunning = useRef(false),
    alive = useRef(true),
    generation = useRef(0);
  const acknowledgedTarget = useRef("");
  useEffect(() => {
    setScreen(section === "today" ? "schedule" : initialScreen);
    setSelectedOccurrence("");
    setTodayMenuOpen(false);
    setTodayPickOpen(false);
    showDraft(null);
    showViewing(null);
  }, [section, initialScreen]);
  useEffect(() => {
    if (section !== "today") return;
    let active = true;
    void reminderRequest(user, "")
      .then((value) => {
        if (active) {
          setServerReminders(value.items);
          setReminderSettings(value.settings);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [section, user.id]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest("details.app-popover")) return;
      setDesktopMenu(null);
      document
        .querySelectorAll<HTMLDetailsElement>("details.app-popover[open]")
        .forEach((item) => {
          item.open = false;
        });
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  useEffect(() => {
    const closeSwipe = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const mainId = (target?.closest(".main-note-swipe") as HTMLElement | null)
        ?.dataset.swipeId;
      const lifecycleId = (
        target?.closest(".trash-swipe-item") as HTMLElement | null
      )?.dataset.swipeId;
      const checklistId = (
        target?.closest(".checklist-swipe-shell") as HTMLElement | null
      )?.dataset.swipeId;
      if (noteSwipe && !noteSwipe.dragging && mainId !== noteSwipe.id)
        setNoteSwipe(null);
      if (
        lifecycleSwipe &&
        !lifecycleSwipe.dragging &&
        lifecycleId !== lifecycleSwipe.id
      )
        setLifecycleSwipe(null);
      if (checklistSwipe && checklistId !== checklistSwipe.id)
        setChecklistSwipe(null);
      if (reminderSwipeOffset && !target?.closest(".reminder-swipe-shell"))
        setReminderSwipeOffset(0);
    };
    document.addEventListener("pointerdown", closeSwipe);
    return () => document.removeEventListener("pointerdown", closeSwipe);
  }, [
    noteSwipe?.id,
    noteSwipe?.dragging,
    lifecycleSwipe?.id,
    lifecycleSwipe?.dragging,
    checklistSwipe?.id,
    reminderSwipeOffset,
  ]);
  function keepOnlyPopover(event: Event) {
    const current = event.currentTarget as HTMLDetailsElement;
    if (!current.open) return;
    document
      .querySelectorAll<HTMLDetailsElement>("details.app-popover[open]")
      .forEach((item) => {
        if (item !== current) item.open = false;
      });
  }
  function showDraft(d: Draft | null) {
    draftRef.current = d;
    setDraft(d);
  }
  function showViewing(note: OpenedNote | null) {
    viewingRef.current = note;
    setViewing(note);
  }
  async function load() {
    const g = ++generation.current,
      s = await readState(user.id);
    if (!s) {
      if (alive.current && g === generation.current) {
        setState(undefined);
        setNames({});
        setNotes({});
        setTags({});
        setStash({});
        setReviewItems([]);
        showDraft(null);
      }
      return;
    }
    const ns: Record<string, string> = {},
      texts: Record<string, Note> = {},
      catalogs: Record<string, TagDefinition[]> = {},
      defaults: Record<string, VaultPushMode> = {},
      st: Record<string, Note> = {};
    for (const v of s.vaults) {
      ns[v.header.id] = await vaultName(user.id, v);
      if (v.key) {
        catalogs[v.header.id] = await readTags(user.id, v);
        defaults[v.header.id] = await readVaultPushMode(user.id, v);
        for (const r of heads(v)) texts[r.id] = await readNote(user.id, v, r);
      }
    }
    for (const item of s.stash) st[item.id] = await readStash(s, item.id);
    const reviews = s.sessionReviewRequired
      ? await outboxReviewItems(user)
      : [];
    if (!alive.current || g !== generation.current) return;
    if (!selectionInitialized.current) {
      selectionInitialized.current = true;
      const available = s.vaults.filter((v) => !v.deleted && !v.transfer),
        initial = available.find((v) => v.header.id === s.lastVaultId);
      if (initial) {
        setSelected(initial.header.id);
        queueMicrotask(() => void activateVault(initial.header.id));
      } else if (
        available.length &&
        section === "notes" &&
        initialScreen === "list"
      )
        setScreen("choose-vault");
      else if (section === "notes" && initialScreen === "list") {
        automaticCreateScreen.current = true;
        vaultFlowReturn.current = "list";
        setScreen("create");
      }
    }
    if (
      automaticCreateScreen.current &&
      s.vaults.some((v) => !v.deleted && !v.transfer)
    ) {
      automaticCreateScreen.current = false;
      setSelected("");
      setScreen("choose-vault");
    }
    setState(s);
    setNames(ns);
    setNotes(texts);
    setTags(catalogs);
    setPushDefaults(defaults);
    setStash(st);
    setReviewItems(reviews);
    const d = draftRef.current;
    if (
      d &&
      !s.vaults.some((v) => v.header.id === d.vault && v.key && !v.deleted)
    ) {
      if (d.dirty) await flush();
      showDraft(null);
      setStatus(
        "Хранилище закрыто или удалено. Черновик сохранён в зашифрованном виде; отложенные заметки используются только при удалении источника.",
      );
    }
    const opened = viewingRef.current;
    if (opened) {
      const current = s.vaults.find(
        (v) => v.header.id === opened.vault && v.key && !v.deleted,
      );
      if (!current) showViewing(null);
      else if (!draftRef.current) {
        const versions = heads(current).filter(
          (r) => r.objectId === opened.object,
        );
        if (
          versions.length === 1 &&
          versions[0].id !== opened.revision &&
          texts[versions[0].id]
        )
          showViewing({
            ...texts[versions[0].id],
            vault: opened.vault,
            object: opened.object,
            revision: versions[0].id,
            key: current.key!,
          });
        else if (versions.length > 1)
          setStatus(
            "Заметка изменена на нескольких устройствах. Откройте конфликт версий из списка.",
          );
        else if (!versions.length) showViewing(null);
      }
    }
  }
  async function flush(forceEditorSave = false) {
    if (timer.current) clearTimeout(timer.current);
    if (
      draftRef.current?.dirty &&
      draftRef.current.editorMode &&
      !forceEditorSave
    )
      return;
    const task = (saving.current ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        while (draftRef.current?.dirty) {
          const snapshot = { ...draftRef.current };
          const result = await saveNote(
            user,
            snapshot.vault,
            snapshot.object,
            snapshot.revision,
            {
              title: snapshot.title,
              text: snapshot.text,
              ...(snapshot.html !== undefined ? { html: snapshot.html } : {}),
              ...(snapshot.attachments?.length
                ? { attachments: snapshot.attachments }
                : {}),
              ...(snapshot.cover ? { cover: snapshot.cover } : {}),
              ...(snapshot.checklist?.length
                ? { checklist: snapshot.checklist }
                : {}),
              ...(snapshot.tagIds?.length ? { tagIds: snapshot.tagIds } : {}),
              ...(snapshot.pinned ? { pinned: true } : {}),
              ...(snapshot.reminder ? { reminder: snapshot.reminder } : {}),
              ...(snapshot.projectId ? { projectId: snapshot.projectId } : {}),
              ...(snapshot.lifecycle ? { lifecycle: snapshot.lifecycle } : {}),
            },
            snapshot.key,
          );
          const latest = draftRef.current;
          if (latest && latest.object === snapshot.object) {
            const comparable = (value: Note) =>
              JSON.stringify({
                title: value.title,
                text: value.text,
                html: value.html,
                attachments: value.attachments ?? [],
                cover: value.cover,
                checklist: value.checklist ?? [],
                tagIds: value.tagIds ?? [],
                pinned: Boolean(value.pinned),
                reminder: value.reminder,
                projectId: value.projectId,
                lifecycle: value.lifecycle,
              });
            const unchanged = comparable(latest) === comparable(snapshot);
            showDraft({ ...latest, revision: result.id, dirty: !unchanged });
          }
          setStatus(
            result.stashed
              ? "Хранилище недоступно. Заметка сохранена в отложенных."
              : "Сохранено на устройстве · ожидает синхронизации",
          );
          setSyncStatus("local");
          if (syncTimer.current) clearTimeout(syncTimer.current);
          syncTimer.current = setTimeout(() => {
            if (syncRunning.current) syncAgain.current = true;
            else void sync();
          }, 1500);
        }
      });
    saving.current = task;
    try {
      await task;
    } finally {
      if (saving.current === task) saving.current = null;
    }
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Не удалось выполнить действие",
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function unlockError(caught: unknown) {
    return caught instanceof DOMException && caught.name === "NotAllowedError"
      ? "Системная разблокировка отменена. Можно повторить её, ввести фразу или отложить открытие хранилища."
      : caught instanceof Error
        ? caught.message
        : "Не удалось разблокировать хранилище";
  }
  async function activateVault(
    vid: string,
    destination: "list" | "schedule" = screen === "open"
      ? vaultActivationDestination.current
      : section === "today"
        ? "schedule"
        : "list",
  ) {
    const previousId = selectedRef.current,
      origin: typeof unlockReturn.current.screen =
        screen === "choose-vault"
          ? "choose-vault"
          : screen === "schedule"
            ? "schedule"
            : "list";
    vaultActivationDestination.current = destination;
    selectionInitialized.current = true;
    setSelected(vid);
    setSelectedTags([]);
    setQuickFilter("all");
    showDraft(null);
    showViewing(null);
    setCommentsOpen(false);
    setComments([]);
    if (!vid) {
      setScreen("choose-vault");
      return;
    }
    const local = await readState(user.id),
      current = local?.vaults.find(
        (item) => item.header.id === vid && !item.deleted,
      );
    if (!current) {
      setSelected("");
      setScreen("choose-vault");
      setError("Хранилище больше не доступно.");
      return;
    }
    const previous = local?.vaults.find(
      (item) => item.header.id === previousId && !item.deleted && item.key,
    );
    if (!(screen === "open" && previousId === vid))
      unlockReturn.current = {
        screen: origin,
        vaultId:
          origin !== "choose-vault" && previousId !== vid && previous
            ? previousId
            : "",
      };
    if (current.shared && current.role && current.role !== "owner") {
      if (current.membershipRevoked) {
        setScreen(destination);
        setError(
          "Доступ к совместному хранилищу отозван. Доступна только ранее загруженная локальная копия.",
        );
        return;
      }
      if (current.key) {
        select(vid);
        setScreen(destination);
        setError("");
        return;
      }
      if (!collaborationIsUnlocked(user.id)) {
        setScreen(destination);
        setError(
          "Сначала откройте ключ шифрования совместной работы в разделе «Контакты и совместная работа».",
        );
        return;
      }
      const attempt = ++unlockAttempt.current;
      setBusy(true);
      setError("");
      try {
        await unlockMemberVault(user, vid);
        if (attempt !== unlockAttempt.current || !alive.current) return;
        select(vid);
        setStatus(
          "Совместное хранилище разблокировано ключом шифрования аккаунта.",
        );
        setScreen(destination);
        await load();
        void sync();
      } catch (caught) {
        if (attempt === unlockAttempt.current && alive.current)
          setError(unlockError(caught));
      } finally {
        if (attempt === unlockAttempt.current && alive.current) setBusy(false);
      }
      return;
    }
    const mode = vaultEntryMode(current);
    if (mode === "open") {
      if (current.shared && current.role === "owner" && current.keyring)
        await loadOwnerKeyring(user, vid);
      select(vid);
      setScreen(destination);
      setError("");
      return;
    }
    setPhrase("");
    setRepeat("");
    setPassword("");
    setConfirmed(false);
    setError("");
    setScreen("open");
    if (mode === "phrase") return;
    const attempt = ++unlockAttempt.current;
    setBusy(true);
    try {
      await unlockVaultSystem(user, vid);
      const updated = await readState(user.id),
        opened = updated?.vaults.find((item) => item.header.id === vid);
      if (opened?.shared && opened.role === "owner" && opened.keyring)
        await loadOwnerKeyring(user, vid);
      if (attempt !== unlockAttempt.current || !alive.current) return;
      select(vid);
      setStatus("Хранилище разблокировано системной проверкой.");
      setScreen(destination);
      await load();
      void sync();
    } catch (caught) {
      if (attempt === unlockAttempt.current && alive.current)
        setError(unlockError(caught));
    } finally {
      if (attempt === unlockAttempt.current && alive.current) setBusy(false);
    }
  }
  function postponeUnlock() {
    unlockAttempt.current++;
    setPhrase("");
    setError("");
    const back = unlockReturn.current,
      local = stateRef.current,
      previous =
        back.vaultId &&
        local?.vaults.find(
          (item) =>
            item.header.id === back.vaultId && !item.deleted && item.key,
        );
    if (back.screen !== "choose-vault" && previous) {
      select(previous.header.id);
      setScreen(back.screen);
      return;
    }
    setSelected("");
    setSelectedTags([]);
    setQuickFilter("all");
    setScreen("choose-vault");
  }
  async function sync() {
    if (syncRunning.current) {
      syncAgain.current = true;
      return;
    }
    syncRunning.current = true;
    setSyncStatus("syncing");
    onSyncState("syncing");
    try {
      await flush();
      await synchronize(user);
      void reminderRequest(user, "")
        .then((remote) => {
          setServerReminders(remote.items);
          setReminderSettings(remote.settings);
        })
        .catch(() => {});
      const s = await readState(user.id);
      if (alive.current) {
        const pending = Boolean(
          draftRef.current?.dirty || saving.current || (s && hasUnsaved(s)),
        );
        setSyncStatus(pending ? "local" : "synced");
        onSyncState("online");
        setStatus(
          pending
            ? "Сохранено на устройстве. Есть отложенные или неотправленные заметки."
            : "Синхронизировано",
        );
        await load();
      }
    } catch (caught) {
      if (alive.current) {
        if (caught instanceof OutboxReviewRequired) {
          setSyncStatus("local");
          onSyncState("online");
          setStatus(
            "Перед синхронизацией проверьте локальные изменения после завершения предыдущей сессии.",
          );
          await load();
          return;
        }
        const network =
          caught instanceof TypeError ||
          (caught instanceof AuthError && caught.code === "network") ||
          (caught instanceof Error && caught.name === "TimeoutError") ||
          Boolean(
            caught &&
            typeof caught === "object" &&
            "code" in caught &&
            caught.code === "network",
          );
        const auth =
          (caught instanceof AuthError && caught.code === "unauthorized") ||
          (caught instanceof Error &&
            caught.message.startsWith("Для синхронизации войдите"));
        setSyncStatus(network ? "offline" : "error");
        onSyncState(network ? "offline" : auth ? "auth" : "error");
        setStatus(
          network
            ? "Нет синхронизации. Локальные изменения сохранены; повторим при подключении."
            : caught instanceof Error
              ? caught.message
              : "Ошибка синхронизации. Локальные данные сохранены.",
        );
      }
    } finally {
      syncRunning.current = false;
      if (syncAgain.current && alive.current) {
        syncAgain.current = false;
        syncTimer.current = setTimeout(() => void sync(), 1000);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    const changed = () => {
      void load().catch(() => {
        if (alive.current)
          setError("Не удалось прочитать данные. Возможно, запись повреждена.");
      });
    };
    const wake = () => {
      if (document.visibilityState !== "visible") {
        hiddenAt.current = Date.now();
        void flush().catch(() => setError("Не удалось сохранить черновик"));
        if (backgroundLockTimer.current)
          clearTimeout(backgroundLockTimer.current);
        const limits = (stateRef.current?.vaults ?? [])
          .filter(
            (v) => v.key && v.systemUnlock && v.systemUnlock.autoLockMs > 0,
          )
          .map((v) => v.systemUnlock!.autoLockMs);
        if (limits.length) {
          const delay = Math.min(...limits);
          backgroundLockTimer.current = setTimeout(() => {
            const started = hiddenAt.current;
            if (started === null) return;
            const away = Math.max(0, Date.now() - started);
            void lockAfterBackground(user, away)
              .then((locked) => {
                if (locked) {
                  showDraft(null);
                  showViewing(null);
                  setNotes({});
                  setTags({});
                  setPushDefaults({});
                  return load();
                }
              })
              .catch((error) =>
                setError(
                  error instanceof Error
                    ? error.message
                    : "Не удалось заблокировать хранилище",
                ),
              );
          }, delay);
        }
        return;
      }
      if (backgroundLockTimer.current) {
        clearTimeout(backgroundLockTimer.current);
        backgroundLockTimer.current = undefined;
      }
      const started = hiddenAt.current;
      hiddenAt.current = null;
      if (started !== null) {
        const away = Math.max(0, Date.now() - started);
        void (async () => {
          const locked = await lockAfterBackground(user, away);
          if (locked) {
            showDraft(null);
            showViewing(null);
            setNotes({});
            setTags({});
            setPushDefaults({});
          }
          await load();
          const local = await readState(user.id),
            vid = selectedRef.current,
            current = local?.vaults.find(
              (item) => item.header.id === vid && !item.deleted,
            );
          if (
            current?.systemUnlock &&
            !current.key &&
            current.systemUnlock.autoLockMs > 0 &&
            away >= current.systemUnlock.autoLockMs
          ) {
            await activateVault(vid);
            return;
          }
          await sync();
        })().catch((error) =>
          setError(
            error instanceof Error
              ? error.message
              : "Не удалось восстановить приложение после блокировки",
          ),
        );
        return;
      }
      void sync();
    };
    const leave = (event: BeforeUnloadEvent) => {
      if (draftRef.current?.dirty || saving.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    changed();
    void edit(user, async (s) => {
      s.lastOpenedAt = Date.now();
    })
      .then(() => sync())
      .catch((error) =>
        setError(
          error instanceof Error
            ? error.message
            : "Не удалось открыть локальные данные",
        ),
      );
    registerDraftFlush(flush);
    changes?.addEventListener("message", changed);
    window.addEventListener("tasks-data", changed);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("beforeunload", leave);
    const interval = setInterval(() => {
      void sync();
    }, 30000);
    return () => {
      alive.current = false;
      generation.current++;
      registerDraftFlush();
      if (timer.current) clearTimeout(timer.current);
      if (syncTimer.current) clearTimeout(syncTimer.current);
      if (backgroundLockTimer.current)
        clearTimeout(backgroundLockTimer.current);
      onSyncState("idle");
      clearInterval(interval);
      changes?.removeEventListener("message", changed);
      window.removeEventListener("tasks-data", changed);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("beforeunload", leave);
    };
  }, [user.id]);
  useEffect(() => {
    if (!state || startupUnlockHandled.current) return;
    startupUnlockHandled.current = true;
    const last = state.vaults.find(
      (item) => item.header.id === state.lastVaultId && !item.deleted,
    );
    if (last)
      void activateVault(
        last.header.id,
        section === "today" ? "schedule" : "list",
      );
  }, [state?.lastVaultId, section]);
  useEffect(() => {
    if (!reminderTarget || reminderTarget.accountId !== user.id || !state)
      return;
    const targetKey =
      reminderTarget.configId + "." + (reminderTarget.occurrenceId ?? "");
    if (acknowledgedTarget.current !== targetKey) {
      acknowledgedTarget.current = targetKey;
      void acknowledgeReminder(user, reminderTarget);
    }
    const targetVault = state.vaults.find(
      (v) => v.header.id === reminderTarget.vaultId,
    );
    if (!targetVault) {
      setStatus(
        "Заметка из уведомления ещё не загружена. Выполняется синхронизация.",
      );
      void sync();
      return;
    }
    if (targetVault.deleted) {
      setError("Хранилище из уведомления удалено.");
      onReminderHandled();
      return;
    }
    if (selected !== reminderTarget.vaultId) {
      void activateVault(reminderTarget.vaultId);
      return;
    }
    if (!targetVault.key) {
      if (screen !== "open" && !busy)
        void activateVault(reminderTarget.vaultId);
      return;
    }
    const versions = heads(targetVault).filter(
      (r) => r.objectId === reminderTarget.objectId,
    );
    if (versions.length > 1) {
      setComparison({
        objectId: reminderTarget.objectId,
        versions: versions.map((r) => r.id),
        chosen: versions[0].id,
      });
      setScreen("conflict");
      onReminderHandled();
      return;
    }
    const revision = versions[0],
      value = revision && notes[revision.id];
    if (value) {
      showDraft(null);
      showViewing({
        ...value,
        vault: targetVault.header.id,
        object: revision.objectId,
        revision: revision.id,
        key: targetVault.key,
      });
      setScreen("list");
      onReminderHandled();
    } else {
      setStatus("Заметка из уведомления загружается.");
      void sync();
    }
  }, [
    reminderTarget?.configId,
    reminderTarget?.occurrenceId,
    state,
    notes,
    selected,
    screen,
  ]);
  const v = state?.vaults.find((v) => v.header.id === selected);
  const active = state?.vaults.filter((v) => !v.deleted) ?? [];
  const shellVaultOptions = active.map((item) => ({
    value: item.header.id,
    label: names[item.header.id] || "Хранилище",
  }));
  const shellVaultSignature = shellVaultOptions
    .map((item) => item.value + "\u0000" + item.label)
    .join("\u0001");
  useEffect(() => {
    if (!onVaultContextChange) return;
    onVaultContextChange({
      value: selected,
      options: shellVaultOptions,
      onChange: (value) =>
        void activateVault(value, section === "today" ? "schedule" : "list"),
    });
    return () => onVaultContextChange(null);
  }, [onVaultContextChange, section, selected, shellVaultSignature]);
  const autoLockLabel = (value: number) =>
    value === 0
      ? "Никогда"
      : value === 60_000
        ? "Через 1 минуту"
        : value === 300_000
          ? "Через 5 минут"
          : value === 900_000
            ? "Через 15 минут"
            : value === 1_800_000
              ? "Через 30 минут"
              : "Через 1 час";
  const opened = active.filter((v) => v.key && !v.transfer);
  function form(next: typeof screen, vid = "") {
    automaticCreateScreen.current = false;
    showViewing(null);
    if (next === "create")
      vaultFlowReturn.current =
        screen === "choose-vault" ? "choose-vault" : "list";
    else select(vid);
    setName("");
    setPhrase("");
    setRepeat("");
    setPassword("");
    setConfirmed(false);
    setError("");
    setScreen(next);
  }
  async function submit(event: Event) {
    event.preventDefault();
    await run(async () => {
      if (screen === "open") {
        await openVault(user, selected, phrase);
        const local = await readState(user.id),
          opened = local?.vaults.find((item) => item.header.id === selected);
        if (opened?.shared && opened.role === "owner" && opened.keyring)
          await loadOwnerKeyring(user, selected);
        select(selected);
      } else {
        if (phrase !== repeat) throw Error("Фраза и повтор не совпадают");
        if (screen === "transfer" && !confirmed)
          throw Error("Подтвердите последствия переноса");
        select(
          screen === "transfer"
            ? await transferVault(user, selected, name, phrase)
            : await createVault(user, name, phrase),
        );
      }
      setPhrase("");
      setRepeat("");
      setScreen(
        screen === "open" ? vaultActivationDestination.current : "list",
      );
      void sync();
    });
  }
  function change(field: "title" | "text", value: string) {
    const d = draftRef.current;
    if (!d) return;
    const reminder =
      field === "title" && d.reminder?.mode === "title"
        ? { ...d.reminder, text: Array.from(value).slice(0, 200).join("") }
        : d.reminder;
    showDraft({
      ...d,
      [field]: value,
      ...(reminder ? { reminder } : {}),
      dirty: true,
    });
    setStatus("Есть несохранённые изменения");
  }
  function changeContent(
    patch: Partial<
      Pick<
        Note,
        | "text"
        | "html"
        | "attachments"
        | "cover"
        | "checklist"
        | "tagIds"
        | "pinned"
      >
    >,
  ) {
    const d = draftRef.current;
    if (!d) return;
    const next = { ...d, ...patch, dirty: true };
    if (
      new TextEncoder().encode(
        JSON.stringify({
          title: next.title,
          text: next.text,
          html: next.html,
          attachments: next.attachments,
          cover: next.cover,
          checklist: next.checklist,
          tagIds: next.tagIds,
          pinned: next.pinned,
          reminder: next.reminder,
        }),
      ).length >
      900 * 1024
    ) {
      setError(
        "Заметка достигла локального лимита 900 КБ. Удалите часть текста или вложений.",
      );
      return;
    }
    showDraft(next);
    setError("");
    setStatus("Есть несохранённые изменения");
  }
  function changeReminder(plan: ReminderPlan | undefined) {
    const d = draftRef.current;
    if (!d) return;
    showDraft({
      ...d,
      ...(plan ? { reminder: plan } : { reminder: undefined }),
      dirty: true,
    });
    setStatus("Есть несохранённые изменения");
  }
  function prepareReminderForm(d: Draft) {
    const local = d.reminder?.local ?? localTime(Date.now() + 3600000, zone),
      mode = d.reminder?.mode ?? pushDefaults[d.vault] ?? "neutral";
    setReminderDate(local.slice(0, 10));
    setReminderClock(local.slice(11, 16));
    setReminderMode(mode);
    setReminderText(d.reminder?.text ?? "");
    setReminderAllDay(Boolean(d.reminder?.allDay));
    setReminderImportant(Boolean(d.reminder?.important));
    setReminderRepeat(d.reminder?.repeat ?? { type: "once" });
    setReminderEnd(d.reminder?.end ?? { type: "never" });
    setReminderConsent(
      mode === "title" &&
        (d.reminder?.mode === "title" || pushDefaults[d.vault] === "title"),
    );
    setError("");
    setScreen("reminder");
  }
  function openReminderForm() {
    const d = draftRef.current;
    if (d) prepareReminderForm(d);
  }
  function editReminderFor(
    current: NonNullable<State["vaults"][number]>,
    revision: ReturnType<typeof heads>[number],
  ) {
    const value = notes[revision.id];
    if (!value || !current.key) return;
    const d = {
      ...value,
      vault: current.header.id,
      object: revision.objectId,
      revision: revision.id,
      dirty: false,
      key: current.key,
    };
    showViewing(null);
    showDraft(d);
    prepareReminderForm(d);
  }
  function openRevision(
    current: NonNullable<State["vaults"][number]>,
    revision: ReturnType<typeof heads>[number],
  ) {
    const value = notes[revision.id];
    if (!value || !current.key) return;
    showDraft(null);
    setCommentsOpen(false);
    setComments([]);
    setCommentText("");
    setCommentHtml("");
    setCommentEdit(null);
    showViewing({
      ...value,
      vault: current.header.id,
      object: revision.objectId,
      revision: revision.id,
      key: current.key,
    });
    if (value.reminder)
      void acknowledgeReminder(user, {
        vaultId: current.header.id,
        objectId: revision.objectId,
        configId: value.reminder.id,
      });
  }
  function editRevision(
    current: NonNullable<State["vaults"][number]>,
    revision: ReturnType<typeof heads>[number],
  ) {
    openRevision(current, revision);
    const value = notes[revision.id];
    if (!value || !current.key) return;
    showDraft({
      ...value,
      vault: current.header.id,
      object: revision.objectId,
      revision: revision.id,
      dirty: false,
      key: current.key,
      editorMode: "edit",
    });
  }
  function activeTags(vid: string) {
    return (tags[vid] ?? []).filter((tag) => !tag.deleted);
  }
  function tagChips(vid: string, ids: string[] | undefined) {
    const byId = new Map(activeTags(vid).map((tag) => [tag.id, tag]));
    return (ids ?? [])
      .map((tagId) => byId.get(tagId))
      .filter((tag): tag is TagDefinition => Boolean(tag));
  }
  function openTagManager(
    back: "list" | "archive" | "trash" | "schedule" = "list",
    pending?: Draft | null,
  ) {
    tagEditorReturn.current = back;
    tagEditorDraft.current = pending ?? null;
    if (pending) {
      showDraft(null);
      showViewing(null);
    }
    setScreen("tags");
  }
  async function duplicate(
    current: NonNullable<State["vaults"][number]>,
    revision: string,
  ) {
    await flush();
    await copyNote(user, current.header.id, revision);
    showViewing(null);
    setMenuOpen(false);
    setStatus("Копия создана и сохранена на устройстве.");
    void sync();
  }
  async function withTofu(fn: () => Promise<unknown>) {
    for (let attempt = 0; attempt < 10; attempt++)
      try {
        return await fn();
      } catch (caught) {
        if (!(caught instanceof ContactKeyChanged)) throw caught;
        const accepted = await appConfirm(
          "Предыдущий отпечаток: " +
            caught.previous +
            "\nНовый отпечаток: " +
            caught.current,
          {
            title: "Ключ шифрования пользователя изменился",
            confirmLabel: "Подтвердить ключ",
          },
        );
        if (!accepted)
          throw Error(
            "Операция отменена: новый отпечаток ключа не подтверждён.",
          );
        await trustFingerprint(user, caught.userId, caught.current, true);
      }
    throw Error(
      "Слишком много изменений ключей шифрования. Обновите список участников.",
    );
  }
  async function refreshSharing(current: NonNullable<State["vaults"][number]>) {
    const contacts = await contactState(user);
    setSharingContacts(contacts.contacts);
    setMembers(
      current.shared ? await sharedVaultMembers(user, current.header.id) : [],
    );
  }
  async function openSharing(current: NonNullable<State["vaults"][number]>) {
    setInviteUserId("");
    setInviteRole("editor");
    setPhrase("");
    setError("");
    setScreen("sharing");
    try {
      await refreshSharing(current);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Не удалось загрузить настройки совместного доступа",
      );
    }
  }
  async function refreshComments() {
    const current = viewingRef.current;
    if (!current) return;
    setComments(await loadComments(user, current.vault, current.object));
  }
  async function toggleComments() {
    if (commentsOpen) {
      setCommentsOpen(false);
      return;
    }
    setCommentsOpen(true);
    setCommentText("");
    setCommentHtml("");
    setCommentEdit(null);
    setCommentEditorVersion((value) => value + 1);
    setError("");
    try {
      await refreshComments();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Не удалось загрузить комментарии",
      );
    }
  }
  async function exportViewingZip() {
    if (!viewing) return;
    const { vault: _, object: __, revision: ___, key: ____, ...note } = viewing;
    const source = note.importSource ?? {
      kind: "tasks-note-v1" as const,
      vaultId: viewing.vault,
      objectId: viewing.object,
    };
    const used = new Set(note.tagIds ?? []),
      exportTags = (tags[viewing.vault] ?? [])
        .filter((tag) => used.has(tag.id))
        .map((tag) => ({ ...tag })),
      streams = new Map<string, PortableAttachmentStream>();
    for (const item of note.attachments ?? [])
      if (item.storage === "stream")
        streams.set(
          item.id,
          await attachmentPlainStream(user, viewing.vault, item),
        );
    const result = await createNoteZipBlob(
      { note, tags: exportTags, source },
      streams,
      (done, total) =>
        setStatus(
          "Экспорт ZIP: " +
            Math.round(done / 1024 / 1024) +
            " / " +
            Math.round(total / 1024 / 1024) +
            " МиБ",
        ),
    );
    downloadBlob(
      result.blob,
      noteZipFileName(note.title || "note"),
      result.cleanup,
    );
    setMenuOpen(false);
    setStatus(
      "ZIP заметки создан без ограничения 64 МиБ. Внутри находятся note.md, manifest.json и вложения.",
    );
  }
  function statusOf(
    current: NonNullable<State["vaults"][number]>,
    revision: Revision,
    value: Note,
  ): NoteLifecycleState {
    return noteLifecycle(current, revision, value);
  }
  async function openHistory(
    current: NonNullable<State["vaults"][number]>,
    objectId: string,
    back: "list" | "archive" | "trash",
  ) {
    const entries = (await noteHistory(user.id, current, objectId)).sort(
      (a, b) => (b.note.author?.time ?? 0) - (a.note.author?.time ?? 0),
    );
    const currentRevision =
      heads(current).find((item) => item.objectId === objectId)?.id ??
      entries[0]?.revision.id ??
      "";
    showViewing(null);
    setMenuOpen(false);
    setHistory({
      vault: current.header.id,
      objectId,
      back,
      selected: currentRevision,
      entries,
    });
    setScreen("history");
  }
  async function archiveCurrent(
    current: NonNullable<State["vaults"][number]>,
    objectId: string,
  ) {
    await archiveNote(user, current.header.id, objectId);
    showViewing(null);
    setMenuOpen(false);
    setStatus("Заметка перемещена в архив. Напоминание приостановлено.");
    void sync();
  }
  async function restoreArchive(
    current: NonNullable<State["vaults"][number]>,
    revision: Revision,
    value: Note,
  ) {
    const resume =
      Boolean(value.reminder) &&
      (await appConfirm(
        "Если выбрать «Не возобновлять», заметка вернётся с приостановленным напоминанием.",
        { title: "Возобновить напоминание?", confirmLabel: "Возобновить" },
      ));
    await restoreArchivedNote(
      user,
      current.header.id,
      revision.objectId,
      resume,
    );
    showViewing(null);
    setMenuOpen(false);
    setStatus(
      resume
        ? "Заметка восстановлена, напоминание возобновлено."
        : value.reminder
          ? "Заметка восстановлена. Напоминание осталось приостановленным."
          : "Заметка восстановлена.",
    );
    void sync();
  }
  async function trashCurrent(
    current: NonNullable<State["vaults"][number]>,
    objectId: string,
  ) {
    await trashNote(user, current.header.id, objectId);
    showViewing(null);
    setMenuOpen(false);
    setStatus("Заметка перемещена в корзину на 30 дней.");
    void sync();
  }
  async function confirmMainNoteTrash(
    current: NonNullable<State["vaults"][number]>,
    objectId: string,
    title: string,
  ) {
    const confirmed = await appConfirm(
      "Заметка будет храниться в корзине 30 дней, после чего удалится автоматически.",
      {
        title: "Переместить «" + (title || "Без заголовка") + "» в корзину?",
        confirmLabel: "В корзину",
        cancelLabel: "Отмена",
        danger: true,
      },
    );
    if (!confirmed) {
      setNoteSwipe(null);
      return;
    }
    await run(() => trashCurrent(current, objectId));
    setNoteSwipe(null);
  }
  async function restoreTrash(
    current: NonNullable<State["vaults"][number]>,
    objectId: string,
  ) {
    await restoreTrashedNote(user, current.header.id, objectId);
    showViewing(null);
    setMenuOpen(false);
    setStatus("Заметка восстановлена. Напоминание осталось приостановленным.");
    void sync();
  }
  async function purgeCurrent(
    current: NonNullable<State["vaults"][number]>,
    objectId: string,
  ) {
    await permanentlyDeleteNote(user, current.header.id, objectId);
    showViewing(null);
    setMenuOpen(false);
    setStatus("Окончательное удаление поставлено в очередь синхронизации.");
    void sync();
  }
  async function updateViewing(patch: Partial<Note>) {
    const current = viewingRef.current;
    if (!current) return;
    showDraft({ ...current, ...patch, dirty: true });
    await flush();
    const saved = draftRef.current;
    if (saved?.revision) showViewing({ ...saved, revision: saved.revision });
    showDraft(null);
    void sync();
  }
  function downloadBlob(
    blob: Blob,
    name: string,
    release?: () => Promise<void>,
  ) {
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = name || "file";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(
      () => {
        URL.revokeObjectURL(url);
        if (release) void release();
      },
      release ? 10 * 60 * 1000 : 30_000,
    );
  }
  async function downloadAttachment(item: NoteAttachment, vid: string) {
    setStatus("Расшифровываем файл…");
    const blob = await attachmentBlob(user, vid, item);
    downloadBlob(blob, item.name);
    setStatus("Файл подготовлен к скачиванию.");
  }
  async function uploadFiles(files: File[], options?: { asCover?: boolean }) {
    const d = draftRef.current;
    if (!d) throw Error("Редактор закрыт.");
    if (!navigator.onLine)
      throw Error("Для загрузки файла требуется подключение к серверу.");
    for (const file of files) {
      setFileUpload({ name: file.name || "Файл", percent: 0 });
      let uploaded: NoteAttachment | undefined;
      const controller = new AbortController();
      uploadAbort.current = controller;
      try {
        const result = await uploadAttachment(
          user,
          d.vault,
          d.object,
          file,
          (progress) =>
            setFileUpload({
              name: file.name || "Файл",
              percent: progress.percent,
            }),
          controller.signal,
        );
        uploaded = result.attachment;
        const current = draftRef.current;
        if (!current || current.object !== d.object)
          throw Error("Редактор был закрыт во время загрузки.");
        showDraft({
          ...current,
          attachments: [...(current.attachments ?? []), uploaded],
          ...(options?.asCover ? { cover: { attachmentId: uploaded.id } } : {}),
          dirty: true,
        });
        await flush();
        if (result.warning)
          setStatus(
            "Файл загружен. На диске сервера осталось менее 15% свободного места.",
          );
        else setStatus("Файл загружен и привязан к заметке.");
      } catch (caught) {
        if (uploaded)
          await deleteAttachmentFile(user, d.vault, uploaded.id).catch(
            () => {},
          );
        if (caught instanceof DOMException && caught.name === "AbortError")
          throw Error(
            "Загрузка отменена. Недогруженные части будут удалены сервером автоматически.",
          );
        throw caught;
      } finally {
        if (uploadAbort.current === controller) uploadAbort.current = undefined;
        setFileUpload(null);
      }
    }
  }
  async function removeAttachmentFromDraft(item: NoteAttachment) {
    const current = draftRef.current;
    if (!current) return;
    if (
      !(await appConfirm("Старые версии сохранят ссылку на файл.", {
        title: "Удалить вложение из текущей версии?",
        confirmLabel: "Удалить",
        danger: true,
      }))
    )
      return;
    const next = (current.attachments ?? []).filter((x) => x.id !== item.id),
      cover =
        current.cover?.attachmentId === item.id ? undefined : current.cover;
    showDraft({ ...current, attachments: next, cover, dirty: true });
    await flush();
    setStatus("Вложение удалено из текущей версии. История заметки сохранена.");
  }
  async function renameDraftAttachment(item: NoteAttachment) {
    const current = draftRef.current;
    if (!current) return;
    const name = (await appPrompt("Новое имя файла", item.name))?.trim();
    if (!name || name === item.name) return;
    if (Array.from(name).length > 200) {
      setError("Имя файла должно быть не длиннее 200 символов.");
      return;
    }
    showDraft({
      ...current,
      attachments: (current.attachments ?? []).map((x) =>
        x.id === item.id ? { ...x, name } : x,
      ),
      dirty: true,
    });
    void flush();
  }
  async function moveViewingAttachment(
    item: NoteAttachment,
    targetObject: string,
  ) {
    const source = viewingRef.current;
    if (!source || source.object === targetObject) return;
    const current = stateRef.current?.vaults.find(
      (v) => v.header.id === source.vault && v.key && !v.deleted,
    );
    if (!current) throw Error("Хранилище закрыто.");
    const targets = heads(current).filter((r) => r.objectId === targetObject);
    if (targets.length !== 1)
      throw Error("Целевая заметка имеет конфликт версий.");
    const targetValue = notes[targets[0].id];
    if (!targetValue || entityKind(targetValue) !== "note")
      throw Error("Целевая заметка недоступна.");
    if ((targetValue.attachments ?? []).some((x) => x.id === item.id))
      throw Error("Файл уже находится в этой заметке.");
    await saveNote(
      user,
      source.vault,
      targetObject,
      targets[0].id,
      {
        ...targetValue,
        attachments: [...(targetValue.attachments ?? []), item],
      },
      current.key,
    );
    await updateViewing({
      attachments: (source.attachments ?? []).filter((x) => x.id !== item.id),
      ...(source.cover?.attachmentId === item.id ? { cover: undefined } : {}),
    });
    if (item.storage === "stream")
      await moveAttachmentFile(user, source.vault, item.id, targetObject);
    setStatus("Вложение перемещено без повторной загрузки.");
    await load();
    void sync();
  }
  function viewingMoveTargets() {
    if (!viewing) return [];
    const current = state?.vaults.find(
      (v) => v.header.id === viewing.vault && v.key && !v.deleted,
    );
    if (!current) return [];
    return heads(current)
      .filter(
        (r) =>
          r.objectId !== viewing.object &&
          entityKind(notes[r.id] ?? { title: "", text: "" }) === "note" &&
          noteLifecycle(current, r, notes[r.id] ?? { title: "", text: "" }) ===
            "active",
      )
      .map((r) => ({
        id: r.objectId,
        title: notes[r.id]?.title || "Без заголовка",
      }));
  }
  function checklistEditor() {
    if (!draft) return null;
    const items = draft.checklist ?? [];
    const replace = (next: NonNullable<Note["checklist"]>) =>
      changeContent({ checklist: next });
    const reorder = (index: number, target: number) => {
      if (
        index === target ||
        index < 0 ||
        target < 0 ||
        index >= items.length ||
        target >= items.length
      )
        return;
      const next = [...items],
        [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      replace(next);
    };
    const hasEmptyItem = items.some((item) => !item.text.trim());
    const add = e(
      "button",
      {
        class: "checklist-add-button",
        disabled: hasEmptyItem,
        "aria-label": hasEmptyItem
          ? "Сначала заполните пустой пункт"
          : "Добавить пункт",
        title: hasEmptyItem
          ? "Сначала заполните пустой пункт"
          : "Добавить пункт",
        onClick: () => {
          if (!hasEmptyItem)
            replace([
              ...items,
              { id: crypto.randomUUID(), text: "", done: false },
            ]);
        },
      },
      e(UiIcon, { name: "plus", size: 19 }),
    );
    return e(
      "section",
      { class: "checklist-editor" },
      e(
        "div",
        { class: "section-heading" },
        e("h2", null, "Чек-лист"),
        e(
          "div",
          { class: "checklist-heading-actions" },
          items.some((item) => item.done) &&
            e(
              "button",
              { onClick: () => setHideCompleted(!hideCompleted) },
              hideCompleted ? "Показать выполненные" : "Скрыть выполненные",
            ),
          !items.length && add,
        ),
      ),
      items.map((item, index) =>
        hideCompleted && item.done
          ? null
          : e(
              "div",
              {
                class: "checklist-swipe-shell",
                key: item.id,
                "data-swipe-id": item.id,
              },
              e(
                "button",
                {
                  class: "checklist-swipe-delete",
                  "aria-label": "Удалить пункт",
                  onClick: () => {
                    setChecklistSwipe(null);
                    replace(items.filter((current) => current.id !== item.id));
                  },
                },
                e(UiIcon, { name: "trash", size: 20 }),
              ),
              e(
                "div",
                {
                  class: "checklist-row",
                  style: {
                    transform: `translateX(-${checklistSwipe?.id === item.id ? checklistSwipe.offset : 0}px)`,
                  },
                  onTouchStart: (ev: TouchEvent) => {
                    checklistTouchX.current = ev.touches[0]?.clientX ?? null;
                    setChecklistSwipe({ id: item.id, offset: 0 });
                  },
                  onTouchMove: (ev: TouchEvent) => {
                    const start = checklistTouchX.current,
                      current = ev.touches[0]?.clientX;
                    if (start !== null && current !== undefined)
                      setChecklistSwipe({
                        id: item.id,
                        offset: Math.max(0, Math.min(76, start - current)),
                      });
                  },
                  onTouchEnd: () => {
                    setChecklistSwipe((current) =>
                      current?.id === item.id && current.offset > 42
                        ? { id: item.id, offset: 76 }
                        : null,
                    );
                    checklistTouchX.current = null;
                  },
                  onDragOver: (ev: DragEvent) => ev.preventDefault(),
                  onDrop: (ev: DragEvent) => {
                    ev.preventDefault();
                    if (draggedChecklistItem.current !== null)
                      reorder(draggedChecklistItem.current, index);
                    draggedChecklistItem.current = null;
                  },
                },
                e("input", {
                  type: "checkbox",
                  checked: item.done,
                  "aria-label": "Выполнено",
                  onChange: (ev: Event) =>
                    replace(
                      items.map((current) =>
                        current.id === item.id
                          ? {
                              ...current,
                              done: (ev.target as HTMLInputElement).checked,
                            }
                          : current,
                      ),
                    ),
                }),
                e(
                  "button",
                  {
                    class: "drag-handle",
                    draggable: true,
                    "aria-label": "Перетащить пункт",
                    onDragStart: (ev: DragEvent) => {
                      draggedChecklistItem.current = index;
                      if (ev.dataTransfer)
                        ev.dataTransfer.effectAllowed = "move";
                    },
                    onDragEnd: () => {
                      draggedChecklistItem.current = null;
                    },
                  },
                  "⋮⋮",
                ),
                e("input", {
                  value: item.text,
                  maxLength: 1000,
                  placeholder: "Пункт списка",
                  onInput: (ev: Event) =>
                    replace(
                      items.map((current) =>
                        current.id === item.id
                          ? {
                              ...current,
                              text: (ev.target as HTMLInputElement).value,
                            }
                          : current,
                      ),
                    ),
                }),
                e(
                  "button",
                  {
                    class: "icon-danger",
                    "aria-label": "Удалить пункт",
                    onClick: () =>
                      replace(
                        items.filter((current) => current.id !== item.id),
                      ),
                  },
                  e(UiIcon, { name: "trash", size: 18 }),
                ),
              ),
            ),
      ),
      items.length > 0 && e("div", { class: "checklist-add-row" }, add),
    );
  }
  async function finishEditing() {
    await flush(true);
    const saved = draftRef.current;
    if (saved?.revision)
      showViewing({
        ...saved,
        vault: saved.vault,
        object: saved.object,
        revision: saved.revision,
        key: saved.key,
      });
    else showViewing(null);
    showDraft(null);
    void sync();
  }
  async function confirmDiscardEditing() {
    const current = draftRef.current;
    return (
      !current?.dirty ||
      (await appConfirm(
        "При возвращении на предыдущую вкладку Ваш прогресс изменения заметки сбросится. Вы уверен, что хотите выйти с потерей прогресса?",
        {
          title: "Выйти без сохранения?",
          confirmLabel: "Да",
          cancelLabel: "Нет",
          danger: true,
        },
      ))
    );
  }
  async function cancelEditing() {
    const current = draftRef.current;
    if (!current || !(await confirmDiscardEditing())) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    showDraft(null);
    setError("");
    setStatus("");
  }
  const feedback = e(
    "div",
    { class: "planner-feedback", "aria-live": "polite" },
    error && e("p", { class: "error", role: "alert" }, error),
    status &&
      status !== "Синхронизировано" &&
      !/синхронизац|сохранено на устройстве|сохраняем/i.test(status) &&
      e("p", { class: "hint" }, status),
  );
  if (screen === "device")
    return e(
      "section",
      { class: "planner device-name-screen" },
      e(PageHeader, {
        eyebrow: "Устройство",
        title: "Название этого устройства",
        description:
          "Имя помогает отличать источник изменений в истории и активных сессиях.",
        back: () => setScreen("list"),
      }),
      e(
        "form",
        {
          class: "settings-panel form-panel device-name-form",
          onSubmit: (ev: Event) => {
            ev.preventDefault();
            void run(async () => {
              await renameDevice(user, name);
              setScreen("list");
            });
          },
        },
        e(
          "label",
          { class: "field-stack" },
          e("span", null, "Название"),
          e("input", {
            value: name,
            maxLength: 80,
            required: true,
            placeholder: "Например, iPhone",
            onInput: (ev: Event) =>
              setName((ev.target as HTMLInputElement).value),
          }),
        ),
        e(
          "p",
          { class: "field-hint" },
          "До 80 символов. Название и время изменения будут видны в новых версиях заметок после расшифровки.",
        ),
        feedback,
        e(
          "div",
          { class: "form-actions" },
          e(
            "button",
            {
              type: "button",
              class: "tertiary-button",
              disabled: busy,
              onClick: () => setScreen("list"),
            },
            "Отмена",
          ),
          e(
            "button",
            { class: "primary", disabled: busy },
            busy ? "Сохраняем…" : "Сохранить",
          ),
        ),
      ),
    );
  if (screen === "system-unlock") {
    const configured = Boolean(v?.systemUnlock);
    return e(
      "section",
      { class: "planner system-unlock-screen" },
      e(PageHeader, {
        eyebrow: "Безопасность хранилища",
        title: "Системная разблокировка",
        description: configured
          ? "Настройте автоблокировку для текущего хранилища."
          : "Защитите основной ключ системной проверкой устройства.",
        back: () => {
          setPhrase("");
          setScreen("list");
        },
      }),
      e(
        "div",
        { class: "system-unlock-layout" },
        e(
          "section",
          { class: "settings-panel" },
          e(
            "div",
            { class: "security-key-hero" },
            e(
              "span",
              { class: "security-key-icon" },
              e(UiIcon, { name: "key", size: 24 }),
            ),
            e(
              "div",
              null,
              e(
                "h2",
                null,
                configured
                  ? "Системная разблокировка включена"
                  : "Включить системную разблокировку",
              ),
              e(
                "p",
                null,
                "Tasks не получает Face ID, отпечаток или системный PIN — браузер возвращает только криптографический результат WebAuthn PRF.",
              ),
            ),
            e(
              "span",
              { class: "status-pill " + (configured ? "success" : "neutral") },
              e(StatusDot, { tone: configured ? "success" : "neutral" }),
              configured ? "Включена" : "Не настроена",
            ),
          ),
          e(
            "form",
            {
              class: "vault-form",
              onSubmit: (ev: Event) => {
                ev.preventDefault();
                const secret = phrase;
                setPhrase("");
                void run(async () => {
                  if (configured)
                    await setSystemAutoLock(user, selected, autoLockMs);
                  else
                    await enableSystemUnlock(
                      user,
                      selected,
                      secret,
                      autoLockMs,
                    );
                  setScreen("list");
                  setStatus(
                    configured
                      ? "Настройки автоблокировки сохранены."
                      : "Системная разблокировка включена. Готовый ключ хранилища больше не сохраняется в IndexedDB.",
                  );
                });
              },
            },
            !configured &&
              e(
                "label",
                { class: "field-stack" },
                e("span", null, "Фраза хранилища"),
                e("input", {
                  type: "password",
                  autoComplete: "off",
                  value: phrase,
                  required: true,
                  onInput: (ev: Event) =>
                    setPhrase((ev.target as HTMLInputElement).value),
                }),
              ),
            e(
              "label",
              { class: "field-stack" },
              e("span", null, "Автоблокировка после ухода из приложения"),
              e(
                "select",
                {
                  value: String(autoLockMs),
                  onChange: (ev: Event) =>
                    setAutoLockMs(
                      Number(
                        (ev.target as HTMLSelectElement).value,
                      ) as AutoLockMs,
                    ),
                },
                AUTO_LOCK_VALUES.map((value) =>
                  e(
                    "option",
                    { value: String(value), key: value },
                    autoLockLabel(value),
                  ),
                ),
              ),
            ),
            feedback,
            e(
              "div",
              { class: "form-actions" },
              e(
                "button",
                { class: "primary", disabled: busy },
                busy
                  ? "Сохраняем…"
                  : configured
                    ? "Сохранить настройку"
                    : "Включить системную разблокировку",
              ),
            ),
          ),
        ),
        e(
          "details",
          { class: "explanation-tip app-popover", onToggle: keepOnlyPopover },
          e(
            "summary",
            { class: "tertiary-button" },
            e(UiIcon, { name: "info", size: 18 }),
            "Что меняется?",
          ),
          e(
            "div",
            { class: "context-tip-panel" },
            e(
              "ul",
              null,
              e(
                "li",
                null,
                "Фраза остаётся независимым резервным способом доступа.",
              ),
              e(
                "li",
                null,
                "Готовый основной ключ не хранится в локальной базе браузера.",
              ),
              e(
                "li",
                null,
                "После закрытия или перезапуска потребуется системная проверка либо фраза.",
              ),
              e(
                "li",
                null,
                "Пока приложение открыто на экране, таймер не блокирует хранилище.",
              ),
            ),
            e(
              "p",
              { class: "settings-footnote" },
              "«Никогда» отключает только таймер после ухода приложения в фон.",
            ),
          ),
        ),
      ),
    );
  }
  if (screen === "sharing" && v) {
    const owner = v.role === "owner" || !v.role,
      available = sharingContacts.filter(
        (contact) => !members.some((member) => member.user.id === contact.id),
      );
    const roleLabel =
      v.role === "owner"
        ? "Владелец"
        : v.role === "editor"
          ? "Редактор"
          : "Просмотр";
    if (v.membershipRevoked)
      return e(
        "section",
        { class: "planner shared-vault-screen revoked-vault-screen" },
        e(PageHeader, {
          eyebrow: "Совместное хранилище",
          title: names[v.header.id] || "Хранилище",
          description: "Серверный доступ к этому хранилищу отозван.",
          back: () => setScreen("list"),
        }),
        e(
          "div",
          { class: "revoked-vault-card" },
          e(
            "span",
            { class: "revoked-vault-icon" },
            e(UiIcon, { name: "warning", size: 26 }),
          ),
          e(
            "div",
            null,
            e("h2", null, "Доступ отозван"),
            e(
              "p",
              null,
              "На устройстве осталась только ранее загруженная локальная копия. Она доступна для чтения, но новые изменения не отправляются на сервер.",
            ),
          ),
        ),
        e(
          "details",
          { class: "compact-info-tip app-popover", onToggle: keepOnlyPopover },
          e(
            "summary",
            {
              class: "icon-button",
              "aria-label": "Информация",
              title: "Информация",
            },
            e(UiIcon, { name: "info", size: 18 }),
          ),
          e(
            "div",
            { class: "context-tip-panel" },
            "Ни сервер, ни другой участник не могут удалить уже скопированные зашифрованные данные и старые ключи с этого устройства. Несинхронизированные данные можно перенести через «Отложенные заметки».",
          ),
        ),
        e(
          "div",
          { class: "button-row" },
          e(
            "button",
            { class: "secondary-button", onClick: () => setScreen("list") },
            "Открыть локальную копию",
          ),
          e(
            "button",
            { class: "tertiary-button", onClick: () => setScreen("stash") },
            "Открыть отложенные заметки",
          ),
        ),
        feedback,
      );

    return e(
      "section",
      { class: "planner shared-vault-screen" },
      e(PageHeader, {
        eyebrow: v.shared ? "Совместное хранилище" : "Совместный доступ",
        title: names[v.header.id] || "Хранилище",
        description: v.shared
          ? "Участники, роли и защищённый доступ к хранилищу."
          : "Сделайте личное хранилище совместным без смены его основного ключа.",
        back: () => setScreen("list"),
        actions: v.shared
          ? e(
              "button",
              {
                class: "tertiary-button",
                disabled: busy,
                onClick: () => void run(async () => refreshSharing(v)),
              },
              e(UiIcon, { name: "sync", size: 17 }),
              "Обновить",
            )
          : undefined,
      }),
      !collaborationIsUnlocked(user.id) &&
        e(
          "div",
          { class: "inline-alert warning" },
          e(UiIcon, { name: "warning", size: 18 }),
          e(
            "div",
            null,
            e("strong", null, "Ключ шифрования совместной работы заблокирован"),
            e(
              "p",
              null,
              "Откройте его в «Контакты и совместная работа», прежде чем приглашать участников или перевыдавать ключи.",
            ),
          ),
        ),

      !v.shared &&
        owner &&
        e(
          "div",
          { class: "shared-enable-layout" },
          e(
            "section",
            { class: "settings-panel" },
            e(
              "div",
              { class: "security-key-hero" },
              e(
                "span",
                { class: "security-key-icon" },
                e(UiIcon, { name: "contacts", size: 23 }),
              ),
              e(
                "div",
                null,
                e("h2", null, "Включить совместный доступ"),
                e(
                  "p",
                  null,
                  "Основной ключ хранилища не меняется. Напоминания остаются в личных зашифрованных настройках аккаунта.",
                ),
              ),
            ),
            e(
              "form",
              {
                class: "vault-form",
                onSubmit: (ev: Event) => {
                  ev.preventDefault();
                  const secret = phrase;
                  setPhrase("");
                  void run(async () => {
                    await enableVaultSharing(user, v.header.id, secret);
                    setStatus(
                      "Совместный доступ включён. Root key не менялся.",
                    );
                    void sync();
                    const current = (await readState(user.id))?.vaults.find(
                      (item) => item.header.id === v.header.id,
                    );
                    if (current) await refreshSharing(current);
                  });
                },
              },
              e(
                "label",
                { class: "field-stack" },
                e("span", null, "Фраза хранилища"),
                e("input", {
                  type: "password",
                  required: true,
                  autoComplete: "off",
                  value: phrase,
                  onInput: (ev: Event) =>
                    setPhrase((ev.target as HTMLInputElement).value),
                }),
              ),
              e(
                "div",
                { class: "form-actions" },
                e(
                  "button",
                  {
                    class: "primary",
                    disabled: busy || !collaborationIsUnlocked(user.id),
                  },
                  busy ? "Включаем…" : "Включить совместный доступ",
                ),
              ),
            ),
          ),
          e(
            "details",
            { class: "explanation-tip app-popover", onToggle: keepOnlyPopover },
            e(
              "summary",
              { class: "tertiary-button" },
              e(UiIcon, { name: "info", size: 18 }),
              "Что увидит сервер?",
            ),
            e(
              "div",
              { class: "context-tip-panel" },
              e(
                "ul",
                null,
                e("li", null, "Идентификаторы участников и их роли."),
                e("li", null, "Зашифрованные данные для доступа к ключу."),
                e(
                  "li",
                  null,
                  "Зашифрованное содержимое, но не открытый текст заметок.",
                ),
              ),
            ),
          ),
        ),

      v.shared &&
        e(
          "div",
          { class: "shared-members-layout" },
          e(
            "section",
            { class: "settings-panel shared-summary-panel" },
            e(
              "div",
              { class: "shared-summary" },
              e(
                "span",
                { class: "shared-summary-icon" },
                e(UiIcon, { name: "folder", size: 23 }),
              ),
              e(
                "div",
                null,
                e("strong", null, names[v.header.id] || "Хранилище"),
                e("small", null, "Совместное зашифрованное хранилище"),
              ),
              e("span", { class: "badge accent" }, roleLabel),
            ),
            e(
              "div",
              { class: "status-grid shared-stats" },
              e(
                "div",
                null,
                e("span", null, "Участники"),
                e("strong", null, String(members.length)),
              ),
              e(
                "div",
                null,
                e("span", null, "Ваша роль"),
                e("strong", null, roleLabel),
              ),
              e(
                "div",
                null,
                e("span", null, "Ключ шифрования"),
                e(
                  "strong",
                  null,
                  collaborationIsUnlocked(user.id) ? "Открыт" : "Заблокирован",
                ),
              ),
            ),
          ),

          owner &&
            e(
              "section",
              { class: "settings-panel invite-member-panel" },
              e(
                "div",
                { class: "settings-panel-heading" },
                e(
                  "div",
                  null,
                  e("h2", null, "Пригласить участника"),
                  e(
                    "p",
                    null,
                    "Доступ можно выдать только подтверждённому контакту с ключом шифрования.",
                  ),
                ),
              ),
              available.length
                ? e(
                    "form",
                    {
                      class: "invite-member-form",
                      onSubmit: (ev: Event) => {
                        ev.preventDefault();
                        const target = sharingContacts.find(
                          (contact) => contact.id === inviteUserId,
                        );
                        if (!target) return;
                        void run(async () => {
                          await withTofu(() =>
                            inviteToVault(
                              user,
                              v.header.id,
                              target,
                              inviteRole,
                            ),
                          );
                          setInviteUserId("");
                          setStatus("Приглашение отправлено.");
                          await refreshSharing(v);
                        });
                      },
                    },
                    e(
                      "label",
                      { class: "field-stack" },
                      e("span", null, "Контакт"),
                      e(
                        "select",
                        {
                          value: inviteUserId,
                          required: true,
                          onChange: (ev: Event) =>
                            setInviteUserId(
                              (ev.target as HTMLSelectElement).value,
                            ),
                        },
                        e("option", { value: "" }, "Выберите контакт"),
                        available.map((contact) =>
                          e(
                            "option",
                            {
                              key: contact.id,
                              value: contact.id,
                              disabled: !contact.identity,
                            },
                            contact.login +
                              (contact.identity
                                ? ""
                                : " · нет ключа шифрования"),
                          ),
                        ),
                      ),
                    ),
                    e(
                      "label",
                      { class: "field-stack" },
                      e("span", null, "Роль"),
                      e(
                        "select",
                        {
                          value: inviteRole,
                          onChange: (ev: Event) =>
                            setInviteRole(
                              (ev.target as HTMLSelectElement).value as
                                | "editor"
                                | "viewer",
                            ),
                        },
                        e("option", { value: "editor" }, "Редактор"),
                        e("option", { value: "viewer" }, "Просмотр"),
                      ),
                    ),
                    e(
                      "button",
                      {
                        class: "primary",
                        disabled:
                          busy ||
                          !inviteUserId ||
                          !collaborationIsUnlocked(user.id),
                      },
                      e(UiIcon, { name: "plus", size: 17 }),
                      "Пригласить",
                    ),
                  )
                : e(
                    "div",
                    { class: "empty-mini" },
                    "Нет доступных контактов. Добавьте пользователя через раздел контактов.",
                  ),
            ),

          e(
            "section",
            { class: "settings-panel shared-members-panel" },
            e(
              "div",
              { class: "settings-panel-heading" },
              e(
                "div",
                null,
                e("h2", null, "Участники"),
                e(
                  "p",
                  null,
                  "Роли влияют на доступ к редактированию, но не раскрывают серверу содержимое хранилища.",
                ),
              ),
            ),
            e(
              "div",
              { class: "member-list" },
              members.map((member) =>
                e(
                  "article",
                  { class: "member-row", key: member.user.id },
                  e(
                    "span",
                    { class: "avatar" },
                    member.user.login.slice(0, 1).toUpperCase(),
                  ),
                  e(
                    "div",
                    { class: "member-copy" },
                    e(
                      "div",
                      { class: "member-title" },
                      e(
                        "strong",
                        null,
                        member.user.login +
                          (member.user.id === user.id ? " · вы" : ""),
                      ),
                      e(
                        "span",
                        {
                          class:
                            "badge " +
                            (member.role === "owner" ? "accent" : ""),
                        },
                        member.role === "owner"
                          ? "Владелец"
                          : member.role === "editor"
                            ? "Редактор"
                            : "Просмотр",
                      ),
                    ),
                    member.identity
                      ? e(
                          "small",
                          { class: "mono" },
                          member.identity.fingerprint.slice(0, 10) +
                            "…" +
                            member.identity.fingerprint.slice(-8),
                        )
                      : e(
                          "small",
                          { class: "danger-text" },
                          "Ключ шифрования отсутствует",
                        ),
                  ),
                  owner &&
                    member.role !== "owner" &&
                    e(
                      "div",
                      { class: "member-actions" },
                      e(
                        "select",
                        {
                          value: member.role,
                          disabled: busy,
                          "aria-label": "Роль " + member.user.login,
                          onChange: (ev: Event) =>
                            void run(async () => {
                              await changeMemberRole(
                                user,
                                v.header.id,
                                member.user.id,
                                (ev.target as HTMLSelectElement).value as
                                  | "editor"
                                  | "viewer",
                              );
                              await refreshSharing(v);
                            }),
                        },
                        e("option", { value: "editor" }, "Редактор"),
                        e("option", { value: "viewer" }, "Просмотр"),
                      ),
                      e(
                        "button",
                        {
                          class: "tertiary-button",
                          disabled:
                            busy ||
                            !member.identity ||
                            !collaborationIsUnlocked(user.id),
                          onClick: () =>
                            void run(async () => {
                              await withTofu(() =>
                                regrantMember(user, v.header.id, member),
                              );
                              setStatus("Новый key envelope выдан участнику.");
                              await refreshSharing(v);
                            }),
                        },
                        "Перевыдать ключ",
                      ),
                      e(
                        "button",
                        {
                          class: "text-danger-button",
                          disabled: busy || !collaborationIsUnlocked(user.id),
                          onClick: async () => {
                            if (
                              await appConfirm(
                                "Для будущих изменений будет создан новый ключ. Уже скопированные старые данные отозвать невозможно.",
                                {
                                  title:
                                    "Удалить " +
                                    member.user.login +
                                    " из хранилища?",
                                  confirmLabel: "Удалить",
                                  danger: true,
                                },
                              )
                            )
                              void run(async () => {
                                await withTofu(() =>
                                  removeVaultMember(
                                    user,
                                    v.header.id,
                                    member.user.id,
                                  ),
                                );
                                setStatus(
                                  "Участник удалён. Для оставшихся участников создан новый ключ.",
                                );
                                await refreshSharing(v);
                              });
                          },
                        },
                        "Удалить",
                      ),
                    ),
                ),
              ),
            ),
          ),

          !owner &&
            e(
              "section",
              { class: "settings-panel shared-leave-panel" },
              e(
                "div",
                { class: "settings-panel-heading" },
                e(
                  "div",
                  null,
                  e("h2", null, "Покинуть хранилище"),
                  e(
                    "p",
                    null,
                    "Серверный доступ будет удалён. Уже загруженная локальная копия останется только для чтения.",
                  ),
                ),
              ),
              e(
                "button",
                {
                  class: "danger-button",
                  disabled: busy,
                  onClick: async () => {
                    if (
                      await appConfirm(
                        "Уже загруженная локальная копия останется только для чтения.",
                        {
                          title: "Выйти из совместного хранилища?",
                          confirmLabel: "Выйти",
                          danger: true,
                        },
                      )
                    )
                      void run(async () => {
                        await leaveSharedVault(user, v.header.id);
                        setScreen("list");
                        setStatus("Вы вышли из совместного хранилища.");
                      });
                  },
                },
                "Выйти из хранилища",
              ),
            ),
          feedback,
        ),
    );
  }
  if (screen === "outbox-review")
    return e(
      "section",
      { class: "planner outbox-review-screen" },
      e(PageHeader, {
        eyebrow: "Безопасная синхронизация",
        title: "Проверка локальных изменений",
        description:
          "Предыдущая серверная сессия была завершена. Ничего из локальной очереди не отправится без вашего решения.",
        back: () => setScreen("list"),
      }),
      e(
        "div",
        { class: "inline-alert warning" },
        e(UiIcon, { name: "warning", size: 18 }),
        e(
          "span",
          null,
          "Сравните локальную и серверную версии перед продолжением синхронизации.",
        ),
      ),
      reviewItems.length
        ? e(
            "div",
            { class: "conflict-grid" },
            reviewItems.map((item) => {
              const blocked =
                item.serverState === "locked" ||
                item.serverState === "conflict";
              const serverLabel =
                item.serverState === "present"
                  ? "Текущая версия на сервере"
                  : item.serverState === "missing"
                    ? "На сервере заметки нет"
                    : item.serverState === "deleted"
                      ? "Хранилище удалено на сервере"
                      : item.serverState === "conflict"
                        ? "На сервере несколько версий"
                        : "Хранилище нужно открыть для сравнения";
              return e(
                "article",
                { class: "note-row", key: item.key },
                e(
                  "h2",
                  null,
                  item.local?.title || item.server?.title || "Без заголовка",
                ),
                e("p", { class: "muted" }, names[item.vaultId] || "Хранилище"),
                e(
                  "div",
                  { class: "review-compare" },
                  e(
                    "div",
                    null,
                    e("strong", null, serverLabel),
                    item.server &&
                      e(
                        "p",
                        { class: "note-preview" },
                        item.server.text || "Без текста",
                      ),
                  ),
                  e(
                    "div",
                    null,
                    e(
                      "strong",
                      null,
                      item.kind === "purge"
                        ? "Планируется окончательное удаление"
                        : "Локальная версия после применения",
                    ),
                    item.local &&
                      e(
                        "p",
                        { class: "note-preview" },
                        item.local.text || "Без текста",
                      ),
                  ),
                ),
                blocked &&
                  e(
                    "p",
                    { class: "error" },
                    item.serverState === "locked"
                      ? "Сначала вернитесь к списку и откройте это хранилище прежней фразой."
                      : "Сначала разрешите конфликт серверных версий.",
                  ),
                item.serverState === "deleted" &&
                  e(
                    "p",
                    { class: "hint" },
                    "Если принять локальную версию, обычная логика восстановления сохранит её локально, а не перезапишет удалённое хранилище.",
                  ),
                e(
                  "div",
                  { class: "actions" },
                  e(
                    "button",
                    {
                      class: "primary",
                      disabled: busy || blocked,
                      onClick: () =>
                        void run(async () => {
                          const done = await decideOutboxReview(
                            user,
                            item.key,
                            true,
                          );
                          if (done) {
                            setScreen("list");
                            setStatus(
                              "Все локальные изменения проверены. Синхронизация продолжена.",
                            );
                            queueMicrotask(() => void sync());
                          }
                        }),
                    },
                    item.kind === "purge"
                      ? "Подтвердить удаление"
                      : "Применить изменение",
                  ),
                  e(
                    "button",
                    {
                      disabled: busy || blocked,
                      onClick: () =>
                        void run(async () => {
                          const done = await decideOutboxReview(
                            user,
                            item.key,
                            false,
                          );
                          if (done) {
                            setScreen("list");
                            setStatus(
                              "Все локальные изменения проверены. Синхронизация продолжена.",
                            );
                            queueMicrotask(() => void sync());
                          }
                        }),
                    },
                    "Отклонить локальное изменение",
                  ),
                ),
              );
            }),
          )
        : e("p", null, "Изменений для проверки нет."),
      feedback,
    );
  if (screen === "close-all")
    return e(
      "section",
      { class: "planner security-action-screen" },
      e(PageHeader, {
        eyebrow: "Безопасность хранилища",
        title: "Закрыть на всех устройствах",
        description:
          "Отозвать сохранённый доступ к выбранному хранилищу на всех сессиях.",
        back: () => {
          setPassword("");
          setScreen("list");
        },
      }),
      e(
        "div",
        { class: "inline-alert warning" },
        e(UiIcon, { name: "warning", size: 18 }),
        e(
          "span",
          null,
          "Сервер сразу остановит синхронизацию этого хранилища. Офлайн-устройства удалят сохранённый ключ после подключения. Заметки и очередь не удаляются.",
        ),
      ),
      e(
        "form",
        {
          onSubmit: (ev: Event) => {
            ev.preventDefault();
            const secret = password;
            setPassword("");
            void run(async () => {
              if (!confirmed) throw Error("Подтвердите закрытие");
              await closeAllVault(user, selected, secret);
              setScreen("list");
              setStatus("Хранилище закрыто на всех устройствах.");
            });
          },
        },
        e(
          "label",
          null,
          "Пароль аккаунта",
          e("input", {
            type: "password",
            autoComplete: "current-password",
            value: password,
            required: true,
            onInput: (ev: Event) =>
              setPassword((ev.target as HTMLInputElement).value),
          }),
        ),
        e(
          "label",
          { class: "check-row" },
          e("input", {
            type: "checkbox",
            checked: confirmed,
            required: true,
            onChange: (ev: Event) =>
              setConfirmed((ev.target as HTMLInputElement).checked),
          }),
          "Фраза хранилища мне известна. Если она забыта, после закрытия всех сохранённых ключей содержимое может стать недоступно.",
        ),
        feedback,
        e(
          "button",
          { class: "primary", disabled: busy },
          busy ? "Закрываем…" : "Закрыть на всех устройствах",
        ),
      ),
    );
  if (screen === "conflict" && comparison && v?.key) {
    const alternatives = v.records.filter((r) =>
      comparison.versions.includes(r.id),
    );
    const finish = (keep: boolean) =>
      void run(async () => {
        await resolveConflict(
          user,
          selected,
          comparison.objectId,
          comparison.versions,
          comparison.chosen,
          keep,
        );
        setScreen("list");
        void sync();
      });
    return e(
      "section",
      { class: "planner conflict-screen" },
      e(PageHeader, {
        eyebrow: "Конфликт версий",
        title: "Выберите актуальную версию",
        description:
          "Заметку изменили независимо. Исходные версии останутся в истории.",
        back: () => setScreen("list"),
      }),
      e(
        "div",
        { class: "conflict-grid" },
        alternatives.map((r) =>
          e(
            "article",
            { class: "note-row", key: r.id },
            e(
              "label",
              { class: "check-row" },
              e("input", {
                type: "radio",
                name: "chosen-version",
                checked: comparison.chosen === r.id,
                onChange: () => setComparison({ ...comparison, chosen: r.id }),
              }),
              e(
                "strong",
                null,
                notes[r.id]?.author?.name ?? "Источник неизвестен",
              ),
            ),
            e(
              "small",
              null,
              notes[r.id]?.author
                ? new Date(notes[r.id].author!.time).toLocaleString()
                : "Время неизвестно",
            ),
            e("h3", null, notes[r.id]?.title || "Без заголовка"),
            e("p", { class: "note-preview" }, notes[r.id]?.text),
          ),
        ),
      ),
      feedback,
      e(
        "div",
        { class: "actions" },
        e(
          "button",
          { class: "primary", disabled: busy, onClick: () => finish(true) },
          alternatives.length === 2 ? "Сохранить обе" : "Сохранить все",
        ),
        e(
          "button",
          { disabled: busy, onClick: () => finish(false) },
          "Выбрать версию",
        ),
      ),
    );
  }
  if (screen === "reminder" && draft) {
    const quick = (hours: number) => {
      const local = localTime(Date.now() + hours * 3600000, zone);
      setReminderDate(local.slice(0, 10));
      setReminderClock(local.slice(11));
    };
    const tomorrow = () => {
      setReminderDate(localDateAfter(1));
      setReminderClock("09:00");
    };
    return e(
      "section",
      { class: "reminder-form" },
      e(PageHeader, {
        title: draft.reminder
          ? "Редактирование напоминания"
          : "Новое напоминание",
        description: "Одно расписание на заметку · часовой пояс " + zone,
        back: () => setScreen("list"),
      }),
      e(
        "div",
        { class: "quick-filters reminder-quick-actions" },
        e("button", { type: "button", onClick: () => quick(1) }, "Через час"),
        e("button", { type: "button", onClick: tomorrow }, "Завтра, 09:00"),
      ),
      e(
        "form",
        {
          onSubmit: (event: Event) => {
            event.preventDefault();
            void run(async () => {
              const local =
                reminderDate +
                "T" +
                (reminderAllDay
                  ? reminderSettings.all_day_time
                  : reminderClock);
              if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(local))
                throw Error("Укажите дату и время");
              if (reminderMode !== "neutral" && !reminderConsent)
                throw Error("Подтвердите отправку текста через push-службу");
              const pushText =
                reminderMode === "title"
                  ? Array.from(draft.title).slice(0, 200).join("")
                  : reminderText;
              if (
                reminderMode === "custom" &&
                (!pushText.trim() || Array.from(pushText).length > 200)
              )
                throw Error("Собственный текст: от 1 до 200 символов");
              if (
                reminderEnd.type === "date" &&
                reminderEnd.date < reminderDate
              )
                throw Error(
                  "Дата окончания не может быть раньше первого срабатывания",
                );
              const schedule = {
                local,
                repeat: reminderRepeat,
                end: reminderEnd,
                allDay: reminderAllDay,
                important: reminderImportant,
              };
              const old = draft.reminder,
                unchanged =
                  old &&
                  JSON.stringify({
                    local: reminderAllDay ? old.local.slice(0, 10) : old.local,
                    repeat: old.repeat ?? { type: "once" },
                    end: old.end ?? { type: "never" },
                    allDay: Boolean(old.allDay),
                    important: Boolean(old.important),
                  }) ===
                    JSON.stringify({
                      ...schedule,
                      local: reminderAllDay
                        ? schedule.local.slice(0, 10)
                        : schedule.local,
                    });
              changeReminder({
                id: unchanged ? old!.id : crypto.randomUUID(),
                state: "active",
                ...schedule,
                mode: reminderMode,
                text: reminderMode === "neutral" ? "" : pushText,
              });
              setScreen("list");
              await flush();
              void sync();
            });
          },
        },
        e(
          "div",
          { class: "reminder-fields reminder-wide" },
          e(
            "label",
            null,
            "Дата первого срабатывания",
            e("input", {
              type: "date",
              required: true,
              value: reminderDate,
              onInput: (ev: Event) =>
                setReminderDate((ev.target as HTMLInputElement).value),
            }),
          ),
          e(
            "label",
            null,
            "Время",
            e("input", {
              type: "time",
              required: !reminderAllDay,
              disabled: reminderAllDay,
              value: reminderAllDay
                ? reminderSettings.all_day_time
                : reminderClock,
              onInput: (ev: Event) =>
                setReminderClock((ev.target as HTMLInputElement).value),
            }),
          ),
        ),
        e(
          "label",
          { class: "check-row reminder-all-day reminder-wide" },
          e("input", {
            type: "checkbox",
            checked: reminderAllDay,
            onChange: (ev: Event) =>
              setReminderAllDay((ev.target as HTMLInputElement).checked),
          }),
          "Весь день · push в " + reminderSettings.all_day_time,
        ),
        e(
          "fieldset",
          { class: "reminder-repeat reminder-wide" },
          e("legend", null, "Повтор"),
          e(
            "label",
            null,
            "Расписание",
            e(
              "select",
              {
                value: reminderRepeat.type,
                onChange: (ev: Event) => {
                  const type = (ev.target as HTMLSelectElement).value;
                  setReminderRepeat(
                    type === "daily"
                      ? { type: "daily" }
                      : type === "weekly"
                        ? {
                            type: "weekly",
                            days: [
                              new Date(
                                (reminderDate || "2026-01-05") + "T00:00:00Z",
                              ).getUTCDay() || 7,
                            ],
                          }
                        : type === "interval"
                          ? { type: "interval", days: 2 }
                          : type === "monthly"
                            ? {
                                type: "monthly",
                                day: Number(reminderDate.slice(8, 10)) || 1,
                                shortMonth: "last",
                              }
                            : { type: "once" },
                  );
                },
              },
              e("option", { value: "once" }, "Один раз"),
              e("option", { value: "daily" }, "Каждый день"),
              e("option", { value: "weekly" }, "По дням недели"),
              e("option", { value: "interval" }, "Каждые N дней"),
              e("option", { value: "monthly" }, "Каждый месяц"),
            ),
          ),
          reminderRepeat.type === "weekly" &&
            e(
              "div",
              { class: "weekday-picker" },
              ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((label, index) =>
                e(
                  "label",
                  { class: "check-row", key: label },
                  e("input", {
                    type: "checkbox",
                    checked: reminderRepeat.days.includes(index + 1),
                    onChange: (ev: Event) => {
                      const checked = (ev.target as HTMLInputElement).checked,
                        days = checked
                          ? [...reminderRepeat.days, index + 1]
                          : reminderRepeat.days.filter(
                              (day) => day !== index + 1,
                            );
                      if (days.length)
                        setReminderRepeat({
                          type: "weekly",
                          days: days.sort(),
                        });
                    },
                  }),
                  label,
                ),
              ),
            ),
          reminderRepeat.type === "interval" &&
            e(
              "label",
              null,
              "Интервал, дней",
              e("input", {
                type: "number",
                min: 2,
                max: 365,
                value: reminderRepeat.days,
                onInput: (ev: Event) =>
                  setReminderRepeat({
                    type: "interval",
                    days: Number((ev.target as HTMLInputElement).value),
                  }),
              }),
            ),
          reminderRepeat.type === "monthly" &&
            e(
              "div",
              null,
              e(
                "label",
                null,
                "День месяца",
                e("input", {
                  type: "number",
                  min: 1,
                  max: 31,
                  value: reminderRepeat.day,
                  onInput: (ev: Event) =>
                    setReminderRepeat({
                      ...reminderRepeat,
                      day: Number((ev.target as HTMLInputElement).value),
                    }),
                }),
              ),
              e(
                "label",
                null,
                "Если такого дня нет",
                e(
                  "select",
                  {
                    value: reminderRepeat.shortMonth,
                    onChange: (ev: Event) =>
                      setReminderRepeat({
                        ...reminderRepeat,
                        shortMonth: (ev.target as HTMLSelectElement).value as
                          | "last"
                          | "skip",
                      }),
                  },
                  e("option", { value: "last" }, "В последний день месяца"),
                  e("option", { value: "skip" }, "Пропустить месяц"),
                ),
              ),
            ),
          reminderRepeat.type !== "once" &&
            e(
              "div",
              null,
              e(
                "label",
                null,
                "Окончание",
                e(
                  "select",
                  {
                    value: reminderEnd.type,
                    onChange: (ev: Event) => {
                      const type = (ev.target as HTMLSelectElement).value;
                      setReminderEnd(
                        type === "date"
                          ? { type: "date", date: reminderDate }
                          : type === "count"
                            ? { type: "count", count: 10 }
                            : { type: "never" },
                      );
                    },
                  },
                  e("option", { value: "never" }, "Без окончания"),
                  e("option", { value: "date" }, "По дату включительно"),
                  e(
                    "option",
                    { value: "count" },
                    "После количества срабатываний",
                  ),
                ),
              ),
              reminderEnd.type === "date" &&
                e(
                  "label",
                  null,
                  "Последняя дата",
                  e("input", {
                    type: "date",
                    required: true,
                    value: reminderEnd.date,
                    onInput: (ev: Event) =>
                      setReminderEnd({
                        type: "date",
                        date: (ev.target as HTMLInputElement).value,
                      }),
                  }),
                ),
              reminderEnd.type === "count" &&
                e(
                  "label",
                  null,
                  "Количество, включая первое",
                  e("input", {
                    type: "number",
                    min: 1,
                    max: 10000,
                    required: true,
                    value: reminderEnd.count,
                    onInput: (ev: Event) =>
                      setReminderEnd({
                        type: "count",
                        count: Number((ev.target as HTMLInputElement).value),
                      }),
                  }),
                ),
            ),
        ),
        e(
          "label",
          { class: "check-row important-control" },
          e("input", {
            type: "checkbox",
            checked: reminderImportant,
            onChange: (ev: Event) =>
              setReminderImportant((ev.target as HTMLInputElement).checked),
          }),
          "Важное напоминание",
        ),
        e(
          "label",
          { class: "reminder-push-default" },
          "Режим push для хранилища",
          e(
            "select",
            {
              value: pushDefaults[draft.vault] ?? "neutral",
              disabled: busy,
              onChange: async (ev: Event) => {
                const mode = (ev.target as HTMLSelectElement)
                  .value as VaultPushMode;
                if (
                  mode === "title" &&
                  !(await appConfirm(
                    "Заголовки будущих напоминаний будут передаваться серверу и push-службе без шифрования.",
                    {
                      title: "Использовать заголовок в уведомлениях?",
                      confirmLabel: "Использовать",
                    },
                  ))
                )
                  return;
                void run(async () => {
                  await setVaultPushMode(user, draft.vault, mode);
                  setPushDefaults((current) => ({
                    ...current,
                    [draft.vault]: mode,
                  }));
                });
              },
            },
            e("option", { value: "neutral" }, "Нейтральный"),
            e("option", { value: "title" }, "Заголовок заметки"),
          ),
        ),
        e(
          "fieldset",
          { class: "reminder-copy-options reminder-wide" },
          e("legend", null, "Текст уведомления"),
          e(
            "label",
            { class: "check-row" },
            e("input", {
              type: "radio",
              name: "reminder-mode",
              checked: reminderMode === "neutral",
              onChange: () => setReminderMode("neutral"),
            }),
            "Нейтральный: «У вас запланировано напоминание»",
          ),
          e(
            "label",
            { class: "check-row" },
            e("input", {
              type: "radio",
              name: "reminder-mode",
              checked: reminderMode === "custom",
              onChange: () => setReminderMode("custom"),
            }),
            "Свой текст",
          ),
          e(
            "button",
            {
              type: "button",
              class:
                reminderMode === "title"
                  ? "title-push-button selected"
                  : "title-push-button",
              "aria-pressed": reminderMode === "title",
              onClick: () => {
                setReminderMode("title");
                setReminderText("");
              },
            },
            "Взять заголовок как текст сообщения",
          ),
        ),
        reminderMode === "custom" &&
          e(
            "div",
            null,
            e(
              "label",
              null,
              "Текст push",
              e("textarea", {
                rows: 3,
                maxLength: 200,
                required: true,
                value: reminderText,
                onInput: (ev: Event) =>
                  setReminderText((ev.target as HTMLTextAreaElement).value),
              }),
            ),
            e("small", null, Array.from(reminderText).length + " / 200"),
          ),
        reminderMode === "title" &&
          e(
            "div",
            { class: "title-push-value" },
            e("strong", null, "Текущий текст push"),
            e(
              "p",
              null,
              Array.from(draft.title).slice(0, 200).join("") ||
                "Сначала укажите заголовок заметки",
            ),
            Array.from(draft.title).length > 200 &&
              e(
                "small",
                null,
                "В push попадут первые 200 символов. Текст будет обновляться вместе с заголовком.",
              ),
          ),
        reminderMode !== "neutral" &&
          e(
            "label",
            { class: "check-row" },
            e("input", {
              type: "checkbox",
              checked: reminderConsent,
              required: true,
              onChange: (ev: Event) =>
                setReminderConsent((ev.target as HTMLInputElement).checked),
            }),
            "Разрешаю передать этот текст серверу и push-службе. Он не будет защищён ключом хранилища.",
          ),
        e(
          "details",
          { class: "reminder-preview-disclosure reminder-wide" },
          e(
            "summary",
            { class: "tertiary-button" },
            e(UiIcon, { name: "bell", size: 18 }),
            "Показать превью",
          ),
          e(
            "div",
            {
              class: "reminder-preview",
              "aria-label": "Предпросмотр уведомления",
            },
            e("img", { src: "/icon.svg", width: 38, height: 38, alt: "" }),
            e(
              "div",
              null,
              e("strong", null, "Tasks"),
              e(
                "p",
                null,
                reminderMode === "custom"
                  ? reminderText || "Введите свой текст"
                  : reminderMode === "title"
                    ? Array.from(draft.title).slice(0, 200).join("") ||
                      "Сначала укажите заголовок заметки"
                    : "У вас запланировано напоминание",
              ),
            ),
          ),
        ),
        feedback,
        e(
          "button",
          {
            class: "primary reminder-submit reminder-wide",
            disabled: busy,
            type: "submit",
          },
          busy ? "Сохраняем…" : "Сохранить напоминание",
        ),
      ),
    );
  }
  if (screen === "history" && history) {
    const currentVault = state?.vaults.find(
        (item) => item.header.id === history.vault,
      ),
      currentId =
        currentVault &&
        heads(currentVault).find((item) => item.objectId === history.objectId)
          ?.id;
    const selectedVersion = history.entries.find(
        (item) => item.revision.id === history.selected,
      ),
      currentVersion =
        history.entries.find((item) => item.revision.id === currentId) ??
        history.entries[0];
    const preview = (entry: typeof selectedVersion, label: string) =>
      entry &&
      e(
        "article",
        { class: "version-preview" },
        e("p", { class: "eyebrow" }, label),
        e("h2", null, entry.note.title || "Без заголовка"),
        entry.note.html
          ? e("div", {
              class: "rich-note-content",
              dangerouslySetInnerHTML: {
                __html: sanitizeNoteHtml(entry.note.html),
              },
            })
          : e("p", { class: "note-preview" }, entry.note.text || "Нет текста"),
        Boolean(entry.note.checklist?.length) &&
          e(
            "p",
            { class: "hint" },
            "Чек-лист: " +
              entry.note.checklist!.filter((item) => item.done).length +
              " / " +
              entry.note.checklist!.length,
          ),
        Boolean(entry.note.attachments?.length) &&
          e(
            "p",
            { class: "hint" },
            "Вложения: " + entry.note.attachments!.length,
          ),
      );
    return e(
      "section",
      { class: "planner history-screen" },
      e(PageHeader, {
        eyebrow: "История",
        title: "История версий",
        description:
          "Все версии расшифровываются только на этом устройстве. Восстановление создаёт новую версию, не удаляя текущую.",
        back: () => {
          setHistory(null);
          setScreen(history.back);
        },
      }),
      e(
        "div",
        { class: "version-layout" },
        e(
          "div",
          { class: "version-list" },
          history.entries.map((entry) =>
            e(
              "button",
              {
                key: entry.revision.id,
                class:
                  history.selected === entry.revision.id
                    ? "version-row selected"
                    : "version-row",
                onClick: () =>
                  setHistory({ ...history, selected: entry.revision.id }),
              },
              e(
                "strong",
                null,
                entry.revision.id === currentId
                  ? "Текущая версия"
                  : entry.note.author
                    ? new Date(entry.note.author.time).toLocaleString("ru-RU")
                    : "Время неизвестно",
              ),
              e(
                "small",
                null,
                (entry.note.author?.name ?? "Источник неизвестен") +
                  (entry.note.lifecycle?.state === "archived"
                    ? " · Архив"
                    : entry.note.lifecycle?.state === "trashed"
                      ? " · Корзина"
                      : ""),
              ),
            ),
          ),
        ),
        e(
          "div",
          { class: "version-comparison" },
          preview(currentVersion, "ТЕКУЩАЯ"),
          selectedVersion?.revision.id !== currentVersion?.revision.id &&
            preview(selectedVersion, "ВЫБРАННАЯ"),
        ),
      ),
      selectedVersion &&
        selectedVersion.revision.id !== currentId &&
        e(
          "button",
          {
            class: "primary",
            disabled: busy,
            onClick: async () => {
              if (
                await appConfirm("Старое напоминание останется выключенным.", {
                  title: "Восстановить выбранное содержимое как новую версию?",
                  confirmLabel: "Восстановить",
                })
              )
                void run(async () => {
                  await restoreNoteVersion(
                    user,
                    history.vault,
                    history.objectId,
                    history.selected,
                  );
                  const back = history.back;
                  setHistory(null);
                  setScreen(back);
                  setStatus("Выбранная версия восстановлена как новая.");
                  void sync();
                });
            },
          },
          "Восстановить эту версию",
        ),
      feedback,
    );
  }
  if (viewing && !draft) {
    const current = state?.vaults.find(
        (item) => item.header.id === viewing.vault,
      ),
      versions = current
        ? heads(current).filter((item) => item.objectId === viewing.object)
        : [],
      competing = versions.length > 1,
      revision = versions.find((item) => item.id === viewing.revision),
      lifecycle =
        current && revision ? statusOf(current, revision, viewing) : "active",
      readOnly = Boolean(
        current?.membershipRevoked ||
        current?.role === "viewer" ||
        entityKind(viewing) !== "note",
      );
    return e(
      "section",
      { class: "note-view" },
      e(
        "div",
        { class: "note-view-topbar" },
        e(
          "button",
          {
            class: "ui-back",
            onClick: () => {
              showViewing(null);
              setMenuOpen(false);
            },
            "aria-label": "Назад",
            title: "Назад",
          },
          e(UiIcon, { name: "back", size: 18 }),
        ),
        e(
          "div",
          { class: "note-view-actions" },
          lifecycle !== "active" &&
            e(
              "details",
              {
                class:
                  "compact-info-tip note-lifecycle-tip app-popover " +
                  (lifecycle === "trashed" ? "warning" : "info"),
                onToggle: keepOnlyPopover,
              },
              e(
                "summary",
                {
                  class: "icon-button",
                  "aria-label": "Состояние заметки",
                  title: "Состояние заметки",
                },
                e(UiIcon, { name: "info", size: 18 }),
              ),
              e(
                "div",
                { class: "context-tip-panel" },
                lifecycle === "archived"
                  ? "Заметка находится в архиве. Напоминание приостановлено."
                  : "Заметка находится в корзине. Она будет удалена автоматически через 30 дней.",
              ),
            ),
          viewing.pinned &&
            e(
              "span",
              { class: "note-pinned-state" },
              e(UiIcon, { name: "pin", size: 15 }),
              "Закреплена",
            ),

          e(
            "div",
            { class: "note-view-menu-anchor" },

            e(
              "button",
              {
                class: "tertiary-button note-view-action",
                disabled: competing,
                onClick: () => setMenuOpen(!menuOpen),
                "aria-expanded": menuOpen && !competing,
                "aria-label": "Действия с заметкой",
              },
              e(UiIcon, { name: "more", size: 19 }),
              e("span", null, "Действия"),
            ),
            menuOpen &&
              !competing &&
              e(
                "div",
                { class: "note-action-menu", role: "menu" },
                lifecycle === "active" &&
                  !readOnly &&
                  e(
                    "button",
                    {
                      onClick: () => {
                        setMenuOpen(false);
                        void run(() =>
                          updateViewing({ pinned: !viewing.pinned }),
                        );
                      },
                    },
                    e(UiIcon, { name: "pin", size: 18 }),
                    viewing.pinned ? "Открепить" : "Закрепить",
                  ),
                lifecycle === "active" &&
                  !readOnly &&
                  e(
                    "button",
                    {
                      disabled: busy,
                      onClick: () => {
                        if (current)
                          void run(() => duplicate(current, viewing.revision));
                      },
                    },
                    e(UiIcon, { name: "copy", size: 18 }),
                    "Создать копию",
                  ),
                e(
                  "button",
                  { disabled: busy, onClick: exportViewingZip },
                  e(UiIcon, { name: "download", size: 18 }),
                  "Экспортировать ZIP",
                ),
                current &&
                  e(
                    "button",
                    {
                      disabled: busy,
                      onClick: () =>
                        void run(() =>
                          openHistory(
                            current,
                            viewing.object,
                            lifecycle === "archived"
                              ? "archive"
                              : lifecycle === "trashed"
                                ? "trash"
                                : "list",
                          ),
                        ),
                    },
                    e(UiIcon, { name: "history", size: 18 }),
                    "История версий",
                  ),
                lifecycle === "active" &&
                  current &&
                  !readOnly &&
                  e(
                    "button",
                    {
                      disabled: busy,
                      onClick: () =>
                        void run(() => archiveCurrent(current, viewing.object)),
                    },
                    e(UiIcon, { name: "archive", size: 18 }),
                    "Архивировать",
                  ),
                lifecycle === "archived" &&
                  current &&
                  revision &&
                  !readOnly &&
                  e(
                    "button",
                    {
                      disabled: busy,
                      onClick: () =>
                        void run(() =>
                          restoreArchive(current, revision, viewing),
                        ),
                    },
                    e(UiIcon, { name: "archive", size: 18 }),
                    "Вернуть из архива",
                  ),
                lifecycle !== "trashed" &&
                  current &&
                  !readOnly &&
                  e(
                    "button",
                    {
                      class: "menu-danger",
                      disabled: busy,
                      onClick: async () => {
                        if (
                          await appConfirm(
                            "Она будет окончательно удалена через 30 дней.",
                            {
                              title: "Переместить заметку в корзину?",
                              confirmLabel: "В корзину",
                              danger: true,
                            },
                          )
                        )
                          void run(() => trashCurrent(current, viewing.object));
                      },
                    },
                    e(UiIcon, { name: "trash", size: 18 }),
                    "Удалить",
                  ),
                lifecycle === "trashed" &&
                  current &&
                  !readOnly &&
                  e(
                    "button",
                    {
                      class: "menu-restore",
                      disabled: busy,
                      onClick: () =>
                        void run(() => restoreTrash(current, viewing.object)),
                    },
                    e(UiIcon, { name: "history", size: 18 }),
                    "Восстановить",
                  ),
                lifecycle === "trashed" &&
                  current &&
                  !readOnly &&
                  (!current.shared || current.role === "owner") &&
                  e(
                    "button",
                    {
                      class: "menu-danger menu-purge",
                      disabled: busy,
                      onClick: async () => {
                        if (
                          await appConfirm(
                            "Восстановить её средствами приложения будет невозможно.",
                            {
                              title: "Удалить заметку и всю историю навсегда?",
                              confirmLabel: "Удалить навсегда",
                              danger: true,
                            },
                          )
                        )
                          void run(() => purgeCurrent(current, viewing.object));
                      },
                    },
                    e(UiIcon, { name: "trash", size: 18 }),
                    "Удалить навсегда",
                  ),
              ),
          ),
          lifecycle === "active" &&
            !competing &&
            !readOnly &&
            e(
              "button",
              {
                class: "primary note-view-action",
                onClick: () =>
                  showDraft({ ...viewing, dirty: false, editorMode: "edit" }),
                "aria-label": "Редактировать заметку",
              },
              e(UiIcon, { name: "edit", size: 19 }),
              e("span", null, "Редактировать"),
            ),
        ),
      ),
      competing &&
        e(
          "div",
          { class: "error", role: "status" },
          "Заметка изменена на нескольких устройствах. Выберите версию, прежде чем редактировать.",
          e(
            "button",
            {
              onClick: () => {
                setComparison({
                  objectId: viewing.object,
                  versions: versions.map((item) => item.id),
                  chosen: versions[0].id,
                });
                showViewing(null);
                setMenuOpen(false);
                setScreen("conflict");
              },
            },
            "Сравнить версии",
          ),
        ),
      readOnly &&
        e(
          "p",
          { class: "auth-notice" },
          entityKind(viewing) !== "note"
            ? "Это задача проекта. Для изменения статуса, сроков и проекта откройте раздел «Проекты»."
            : current?.membershipRevoked
              ? "Доступ отозван. Это только ранее загруженная локальная копия; изменения не отправляются на сервер."
              : "Роль «Просмотр»: содержимое заметки нельзя изменять. Комментарии разрешены отдельно.",
        ),
      viewing.cover &&
        (() => {
          const item = (viewing.attachments ?? []).find(
            (x) => x.id === viewing.cover!.attachmentId,
          );
          return item
            ? e(BlobImage, {
                key: item.id,
                cacheKey: item.id,
                alt: item.name,
                className: "note-cover",
                load: () => attachmentPreviewBlob(user, viewing.vault, item),
              })
            : null;
        })(),
      e("h1", null, viewing.title || "Без заголовка"),
      tagChips(viewing.vault, viewing.tagIds).length > 0 &&
        e(
          "div",
          { class: "tag-list" },
          tagChips(viewing.vault, viewing.tagIds).map((tag) =>
            e(
              "span",
              {
                class: "tag-chip",
                style: { "--tag-color": tag.color },
                key: tag.id,
              },
              tag.name,
            ),
          ),
        ),
      viewing.html
        ? e("div", {
            class: "note-view-text rich-note-content",
            dangerouslySetInnerHTML: { __html: sanitizeNoteHtml(viewing.html) },
          })
        : viewing.text
          ? e("div", { class: "note-view-text" }, viewing.text)
          : e("p", { class: "muted" }, "В заметке пока нет текста."),
      Boolean(viewing.checklist?.length) &&
        e(
          "section",
          { class: "checklist-view" },
          e("h2", null, "Чек-лист"),
          viewing.checklist!.map((item) =>
            e(
              "label",
              { class: "checklist-view-row", key: item.id },
              e("input", {
                type: "checkbox",
                checked: item.done,
                disabled: busy || readOnly,
                onChange: (ev: Event) =>
                  void run(() =>
                    updateViewing({
                      checklist: viewing.checklist!.map((current) =>
                        current.id === item.id
                          ? {
                              ...current,
                              done: (ev.target as HTMLInputElement).checked,
                            }
                          : current,
                      ),
                    }),
                  ),
              }),
              e(
                "span",
                { class: item.done ? "completed" : "" },
                item.text || "Пустой пункт",
              ),
            ),
          ),
        ),
      e(Attachments, {
        items: viewing.attachments ?? [],
        coverId: viewing.cover?.attachmentId,
        moveTargets: readOnly ? [] : viewingMoveTargets(),
        viewMode: true,
        loadPreview: (item) => attachmentPreviewBlob(user, viewing.vault, item),
        loadFullImage: (item) => attachmentBlob(user, viewing.vault, item),
        onDownload: (item) =>
          void run(() => downloadAttachment(item, viewing.vault)),
        onSetCover: readOnly
          ? undefined
          : (item) =>
              void run(() =>
                updateViewing({ cover: { attachmentId: item.id } }),
              ),
        onMove: readOnly
          ? undefined
          : (item, target) =>
              void run(() => moveViewingAttachment(item, target)),
      }),
      e(
        "section",
        { class: "comments-card" },
        e(
          "div",
          { class: "section-heading" },
          e(
            "div",
            null,
            e("h2", null, "Комментарии"),
            e(
              "p",
              { class: "muted" },
              "Зашифрованное обсуждение внутри совместной заметки",
            ),
          ),
          e(
            "button",
            {
              class: "tertiary-button",
              disabled: busy || Boolean(current?.membershipRevoked),
              onClick: () => void toggleComments(),
            },
            commentsOpen
              ? "Скрыть"
              : comments.length
                ? "Показать · " + comments.length
                : "Показать",
          ),
        ),
        commentsOpen &&
          e(
            "div",
            { class: "comment-thread" },
            !comments.length &&
              e("div", { class: "empty-mini" }, "Комментариев пока нет."),
            comments.map((comment) =>
              e(
                "article",
                { class: "comment-item", key: comment.id },
                e(
                  "span",
                  { class: "avatar comment-avatar" },
                  comment.author.login.slice(0, 1).toUpperCase(),
                ),
                e(
                  "div",
                  { class: "comment-body" },
                  e(
                    "div",
                    { class: "comment-header" },
                    e(
                      "strong",
                      null,
                      comment.author.login +
                        (comment.author.id === user.id ? " · вы" : ""),
                    ),
                    e(
                      "small",
                      null,
                      new Date(comment.createdAt).toLocaleString("ru-RU") +
                        (comment.updatedAt !== comment.createdAt
                          ? " · изменён"
                          : ""),
                    ),
                  ),
                  commentEdit?.id === comment.id
                    ? e(
                        "form",
                        {
                          class: "comment-composer is-editing",
                          onSubmit: (ev: Event) => {
                            ev.preventDefault();
                            const next = commentEdit;
                            if (!next) return;
                            void run(async () => {
                              await updateComment(
                                user,
                                viewing.vault,
                                viewing.object,
                                next.id,
                                next.text,
                                sanitizeNoteHtml(next.html),
                              );
                              setCommentEdit(null);
                              await refreshComments();
                              setStatus("Комментарий изменён.");
                            });
                          },
                        },
                        e(RichTextEditor, {
                          key: "edit-" + comment.id,
                          variant: "comment",
                          html: commentEdit.html,
                          text: commentEdit.text,
                          onChange: (html: string, text: string) =>
                            setCommentEdit((current) =>
                              current && current.id === comment.id
                                ? { ...current, html, text }
                                : current,
                            ),
                          onError: setError,
                        }),
                        e(
                          "div",
                          { class: "form-actions" },
                          e(
                            "button",
                            {
                              type: "button",
                              class: "tertiary-button",
                              disabled: busy,
                              onClick: () => setCommentEdit(null),
                            },
                            "Отмена",
                          ),
                          e(
                            "button",
                            {
                              class: "primary",
                              disabled:
                                busy ||
                                !commentEdit.text.trim() ||
                                commentEdit.text.trim().length > 4000,
                            },
                            "Сохранить",
                          ),
                        ),
                      )
                    : comment.html
                      ? e("div", {
                          class: "comment-content rich-note-content",
                          dangerouslySetInnerHTML: {
                            __html: sanitizeNoteHtml(comment.html),
                          },
                        })
                      : e("p", { class: "comment-content" }, comment.text),
                ),
                commentEdit?.id !== comment.id &&
                  e(
                    "div",
                    { class: "comment-actions" },
                    comment.author.id === user.id &&
                      e(
                        "button",
                        {
                          class: "comment-action-button",
                          disabled: busy,
                          "aria-label": "Изменить комментарий",
                          title: "Изменить",
                          onClick: () =>
                            setCommentEdit({
                              id: comment.id,
                              text: comment.text,
                              html: comment.html ?? plainToHtml(comment.text),
                            }),
                        },
                        e(UiIcon, { name: "edit", size: 16 }),
                      ),
                    (comment.author.id === user.id ||
                      current?.role === "owner") &&
                      e(
                        "button",
                        {
                          class: "comment-action-button danger",
                          disabled: busy,
                          "aria-label": "Удалить комментарий",
                          title: "Удалить",
                          onClick: async () => {
                            if (
                              await appConfirm("", {
                                title: "Удалить комментарий?",
                                confirmLabel: "Удалить",
                                danger: true,
                              })
                            )
                              void run(async () => {
                                await deleteComment(
                                  user,
                                  viewing.vault,
                                  comment.id,
                                );
                                if (commentEdit?.id === comment.id)
                                  setCommentEdit(null);
                                await refreshComments();
                              });
                          },
                        },
                        e(UiIcon, { name: "trash", size: 16 }),
                      ),
                  ),
              ),
            ),
            !current?.membershipRevoked &&
              e(
                "form",
                {
                  class: "comment-composer",
                  onSubmit: (ev: Event) => {
                    ev.preventDefault();
                    const text = commentText,
                      html = sanitizeNoteHtml(commentHtml);
                    void run(async () => {
                      await createComment(
                        user,
                        viewing.vault,
                        viewing.object,
                        text,
                        html,
                      );
                      setCommentText("");
                      setCommentHtml("");
                      setCommentEditorVersion((value) => value + 1);
                      await refreshComments();
                      setStatus("Комментарий отправлен.");
                    });
                  },
                },
                e(RichTextEditor, {
                  key: "new-" + viewing.object + "-" + commentEditorVersion,
                  variant: "comment",
                  html: commentHtml,
                  text: commentText,
                  onChange: (html: string, text: string) => {
                    setCommentHtml(html);
                    setCommentText(text);
                  },
                  onError: setError,
                }),
                e(
                  "div",
                  { class: "form-actions" },
                  e(
                    "button",
                    {
                      class: "primary",
                      disabled:
                        busy ||
                        !commentText.trim() ||
                        commentText.trim().length > 4000,
                    },
                    "Отправить",
                  ),
                ),
              ),
          ),
      ),
      viewing.reminder &&
        e(
          "section",
          { class: "reminder-card" },
          e("h2", null, "Напоминание"),
          e(
            "p",
            null,
            new Date(viewing.reminder.local + "Z").toLocaleString("ru-RU", {
              timeZone: "UTC",
            }),
            " · ",
            viewing.reminder.state === "active"
              ? "Активно"
              : viewing.reminder.state === "done"
                ? "Выполнено"
                : "Выключено",
          ),
          e(
            "p",
            { class: "hint" },
            viewing.reminder.mode === "custom"
              ? "Для push разрешён отдельный собственный текст."
              : viewing.reminder.mode === "title"
                ? "Текст push автоматически повторяет заголовок заметки."
                : "Push не содержит названия хранилища и текста заметки.",
          ),
        ),
      lifecycle !== "active" &&
        current &&
        e(
          "details",
          { class: "note-history-disclosure" },
          e("summary", null, "История действий"),
          e(
            "div",
            { class: "note-history-list" },
            versions
              .slice()
              .sort(
                (a, b) =>
                  (notes[b.id]?.author?.time ?? 0) -
                  (notes[a.id]?.author?.time ?? 0),
              )
              .map((item) =>
                e(
                  "div",
                  { key: item.id },
                  e(
                    "strong",
                    null,
                    statusOf(current, item, notes[item.id] ?? viewing) ===
                      "trashed"
                      ? "Перемещено в корзину"
                      : statusOf(current, item, notes[item.id] ?? viewing) ===
                          "archived"
                        ? "Перемещено в архив"
                        : "Изменено",
                  ),
                  e(
                    "small",
                    null,
                    notes[item.id]?.author
                      ? new Date(notes[item.id].author!.time).toLocaleString(
                          "ru-RU",
                        )
                      : "Время неизвестно",
                  ),
                ),
              ),
            e(
              "button",
              {
                class: "tertiary-button",
                onClick: () =>
                  void run(() =>
                    openHistory(
                      current,
                      viewing.object,
                      lifecycle === "archived" ? "archive" : "trash",
                    ),
                  ),
              },
              "Открыть историю версий",
            ),
          ),
        ),
      feedback,
    );
  }
  if (draft)
    return e(
      "section",
      { class: "note-editor" },
      e(
        "div",
        { class: "note-editor-header" },
        e(
          "button",
          {
            class: "ui-back",
            disabled: busy,
            onClick: () => void cancelEditing(),
            "aria-label": "Назад",
            title: "Назад",
          },
          e(UiIcon, { name: "back", size: 18 }),
        ),
        e(
          "span",
          { class: "note-editor-state" },
          draft.dirty
            ? "Есть изменения"
            : draft.revision
              ? "Без изменений"
              : "Новая заметка",
        ),
        e(
          "button",
          {
            class: "primary",
            disabled: busy,
            onClick: () => void run(finishEditing),
          },
          "Готово",
        ),
      ),
      e(
        "h1",
        { class: "note-editor-title" },
        draft.editorMode === "create"
          ? "Создание новой заметки"
          : "Редактирование заметки",
      ),
      e(
        "label",
        { class: "note-title-field" },
        e("span", { class: "sr-only" }, "Заголовок"),
        e("input", {
          value: draft.title,
          maxLength: 500,
          placeholder: "Название заметки",
          onInput: (ev: Event) =>
            change("title", (ev.target as HTMLInputElement).value),
        }),
      ),
      e("label", { class: "editor-label sr-only" }, "Текст заметки"),
      fileUpload &&
        e(
          "div",
          {
            class: "file-upload-progress",
            "aria-live": "polite",
            "aria-busy": "true",
          },
          e(
            "span",
            { class: "upload-icon" },
            e(UiIcon, { name: "upload", size: 20 }),
          ),
          e(
            "div",
            { class: "upload-copy" },
            e("strong", null, fileUpload.name),
            e(
              "span",
              null,
              "Зашифрованная загрузка · " + fileUpload.percent + "%",
            ),
            e("progress", { max: 100, value: fileUpload.percent }),
          ),
          e(
            "button",
            {
              type: "button",
              class: "tertiary-button",
              onClick: () => uploadAbort.current?.abort(),
            },
            "Отменить",
          ),
        ),
      e(RichTextEditor, {
        key: draft.object,
        html: draft.html,
        text: draft.text,
        attachments: draft.attachments ?? [],
        coverId: draft.cover?.attachmentId,
        onChange: (html: string, text: string) => changeContent({ html, text }),
        onAttachmentsChange: (attachments: NonNullable<Note["attachments"]>) =>
          changeContent({ attachments }),
        onFilesSelected: uploadFiles,
        onRemoveAttachment: (item) =>
          void run(() => removeAttachmentFromDraft(item)),
        onDownloadAttachment: (item) =>
          void run(() => downloadAttachment(item, draft.vault)),
        onRenameAttachment: renameDraftAttachment,
        onSetCover: (item) =>
          changeContent({ cover: { attachmentId: item.id } }),
        loadPreview: (item) => attachmentPreviewBlob(user, draft.vault, item),
        onError: setError,
      }),
      checklistEditor(),
      e(
        "section",
        { class: "note-tags" },
        e(TagPicker, {
          tags: activeTags(draft.vault),
          selectedIds: draft.tagIds ?? [],
          onChange: (tagIds) => changeContent({ tagIds }),
          onManage: () => openTagManager("list", draftRef.current),
          placement: "above",
          heading: "Теги",
          label: "Изменить",
          showIcon: false,
          layout: "editor",
        }),
      ),
      e(
        "label",
        { class: "check-row pin-control" },
        e("input", {
          type: "checkbox",
          checked: Boolean(draft.pinned),
          onChange: (ev: Event) =>
            changeContent({ pinned: (ev.target as HTMLInputElement).checked }),
        }),
        "Закрепить заметку",
      ),
      e(
        "section",
        { class: "reminder-card" },
        e(
          "div",
          { class: "section-heading" },
          e("h2", null, "Напоминание"),
          !draft.reminder &&
            e("button", { onClick: openReminderForm }, "Включить"),
        ),
        draft.reminder &&
          e(
            "div",
            { class: "reminder-swipe-shell", "data-swipe-id": "reminder" },
            e(
              "button",
              {
                class: "reminder-swipe-delete",
                "aria-label": "Удалить напоминание",
                onClick: () => {
                  setReminderSwipeOffset(0);
                  changeReminder(undefined);
                },
              },
              e(UiIcon, { name: "trash", size: 21 }),
            ),
            e(
              "div",
              {
                class: "reminder-swipe-content",
                style: { transform: `translateX(-${reminderSwipeOffset}px)` },
                onTouchStart: (ev: TouchEvent) => {
                  reminderTouchX.current = ev.touches[0]?.clientX ?? null;
                  setReminderSwipeOffset(0);
                },
                onTouchMove: (ev: TouchEvent) => {
                  const start = reminderTouchX.current,
                    current = ev.touches[0]?.clientX;
                  if (start !== null && current !== undefined)
                    setReminderSwipeOffset(
                      Math.max(0, Math.min(82, start - current)),
                    );
                },
                onTouchEnd: () => {
                  setReminderSwipeOffset((current) => (current > 46 ? 82 : 0));
                  reminderTouchX.current = null;
                },
              },
              e(
                "p",
                null,
                new Date(draft.reminder.local + "Z").toLocaleString("ru-RU", {
                  timeZone: "UTC",
                }),
                " · ",
                draft.reminder.state === "active"
                  ? "Активно"
                  : draft.reminder.state === "done"
                    ? "Выполнено"
                    : "Выключено",
              ),
              e(
                "p",
                { class: "hint" },
                draft.reminder.mode === "custom"
                  ? "Push отправит сохранённый собственный текст."
                  : draft.reminder.mode === "title"
                    ? "Текст push автоматически повторяет заголовок заметки."
                    : "Push не содержит названия хранилища и текста заметки.",
              ),
              e(
                "div",
                { class: "actions compact" },
                e("button", { onClick: openReminderForm }, "Изменить"),
                draft.reminder.state === "active" &&
                  e(
                    "button",
                    {
                      disabled: busy,
                      onClick: () =>
                        void run(async () => {
                          changeReminder({
                            ...draft.reminder!,
                            id: crypto.randomUUID(),
                            state: "done",
                          });
                          await flush();
                          void sync();
                        }),
                    },
                    "Выполнено",
                  ),
              ),
            ),
          ),
      ),
      feedback,
      error &&
        e(
          "button",
          { onClick: () => void run(() => flush(true)) },
          "Повторить сохранение",
        ),
    );
  if (screen === "choose-vault")
    return e(
      "section",
      { class: "vault-choice-screen" },
      e(PageHeader, {
        title: "Выберите хранилище",
        description: "Откройте существующее хранилище или создайте новое.",
      }),
      e(
        "div",
        { class: "vault-choice-list" },
        active
          .filter((item) => !item.transfer)
          .map((item) =>
            e(
              "button",
              {
                class: "vault-choice-row",
                key: item.header.id,
                onClick: () => void activateVault(item.header.id),
              },
              e(
                "span",
                { class: "vault-choice-icon" },
                e(UiIcon, { name: item.key ? "database" : "lock", size: 20 }),
              ),
              e(
                "span",
                null,
                e("strong", null, names[item.header.id] || "Хранилище"),
                e(
                  "small",
                  null,
                  item.key
                    ? "Открыто"
                    : "Закрыто · потребуется фраза или системная разблокировка",
                ),
              ),
              e(UiIcon, { name: "chevron-right", size: 18 }),
            ),
          ),
      ),
      e(
        "button",
        { class: "primary vault-choice-create", onClick: () => form("create") },
        e(UiIcon, { name: "plus", size: 18 }),
        "Создать новое хранилище",
      ),
    );
  if (screen === "create" || screen === "open" || screen === "transfer") {
    const title =
      screen === "open"
        ? "Открыть хранилище"
        : screen === "transfer"
          ? "Перенос с новой фразой"
          : "Новое хранилище";
    const description =
      screen === "open"
        ? "Разблокируйте зашифрованное содержимое на этом устройстве."
        : screen === "transfer"
          ? "Создайте новое хранилище и перенесите доступные локальные данные без риска потери."
          : "Создайте отдельное зашифрованное хранилище для заметок, задач и файлов.";
    const leave = () => {
      if (screen === "open") {
        postponeUnlock();
        return;
      }
      automaticCreateScreen.current = false;
      setScreen(screen === "create" ? vaultFlowReturn.current : "list");
      setPhrase("");
      setRepeat("");
    };
    return e(
      "section",
      { class: "vault-flow-screen" },
      e(PageHeader, { title, description, back: leave }),
      e(
        "div",
        { class: "vault-flow-layout" },
        e(
          "section",
          { class: "settings-panel vault-flow-card" },
          screen !== "open" &&
            e(
              "details",
              {
                class: "vault-info-tip app-popover",
                onToggle: keepOnlyPopover,
              },
              e(
                "summary",
                {
                  class: "icon-button",
                  "aria-label": "О шифровании хранилища",
                  title: "О шифровании хранилища",
                },
                e(UiIcon, { name: "info", size: 18 }),
              ),
              e(
                "div",
                { class: "context-tip-panel" },
                "Название хранилища видно до разблокировки и синхронизируется отдельно. Содержимое, теги, задачи и файлы передаются и хранятся только в зашифрованном виде.",
              ),
            ),
          screen === "open" &&
            v?.systemUnlock &&
            e(
              "div",
              { class: "system-unlock-card" },
              e(
                "span",
                { class: "security-key-icon" },
                e(UiIcon, { name: "key", size: 23 }),
              ),
              e(
                "div",
                null,
                e("strong", null, "Системная разблокировка настроена"),
                e(
                  "p",
                  null,
                  "Можно подтвердить доступ системным WebAuthn-аутентификатором или использовать фразу ниже.",
                ),
              ),
              e(
                "button",
                {
                  class: "secondary-button",
                  type: "button",
                  disabled: busy,
                  onClick: () => void activateVault(selected),
                },
                busy ? "Ожидаем проверку…" : "Разблокировать системно",
              ),
            ),
          e(
            "form",
            { class: "vault-form", onSubmit: submit },
            screen !== "open" &&
              e(
                "label",
                { class: "field-stack" },
                e("span", null, "Название"),
                e("input", {
                  required: true,
                  maxLength: 200,
                  value: name,
                  placeholder: "Например, Личное",
                  onInput: (ev: Event) =>
                    setName((ev.target as HTMLInputElement).value),
                }),
              ),
            e(
              "div",
              { class: "field-stack phrase-field" },
              e("label", { for: "vault-phrase" }, "Фраза хранилища"),
              e("input", {
                id: "vault-phrase",
                type: "password",
                autoComplete:
                  screen === "open" ? "current-password" : "new-password",
                autoFocus: screen === "open",
                required: true,
                value: phrase,
                onInput: (ev: Event) =>
                  setPhrase((ev.target as HTMLInputElement).value),
              }),
              e(
                "details",
                { class: "phrase-help app-popover", onToggle: keepOnlyPopover },
                e("summary", null, "Что такое фраза?"),
                e(
                  "div",
                  { class: "context-tip-panel phrase-tip" },
                  e("strong", null, "Фраза остаётся только у вас"),
                  e(
                    "p",
                    null,
                    "Tasks не отправляет её на сервер. Без фразы или настроенного доверенного доступа восстановить основной ключ невозможно.",
                  ),
                  e(
                    "p",
                    null,
                    "Закрытие хранилища не удаляет заметки — оно только убирает локальный доступ к ключу.",
                  ),
                ),
              ),
            ),
            screen !== "open" &&
              e(
                "label",
                { class: "field-stack" },
                e("span", null, "Повторите фразу"),
                e("input", {
                  type: "password",
                  autoComplete: "new-password",
                  required: true,
                  value: repeat,
                  onInput: (ev: Event) =>
                    setRepeat((ev.target as HTMLInputElement).value),
                }),
              ),
            screen !== "open" &&
              e(
                "p",
                { class: "field-hint" },
                "Минимум 6 любых символов. Фраза не отправляется на сервер.",
              ),
            screen === "transfer" &&
              e(
                "label",
                { class: "checkbox-row danger-confirm" },
                e("input", {
                  type: "checkbox",
                  checked: confirmed,
                  required: true,
                  onChange: (ev: Event) =>
                    setConfirmed((ev.target as HTMLInputElement).checked),
                }),
                e(
                  "span",
                  null,
                  "После подтверждённого переноса старое серверное хранилище можно удалить. Изменения с других офлайн-устройств могут отсутствовать в новой копии.",
                ),
              ),
            feedback,
            e(
              "div",
              { class: "form-actions" },
              screen === "open" &&
                e(
                  "button",
                  {
                    type: "button",
                    class: "tertiary-button",
                    disabled: busy,
                    onClick: postponeUnlock,
                  },
                  "В другой раз",
                ),
              e(
                "button",
                { class: "primary", disabled: busy, type: "submit" },
                busy
                  ? "Подождите…"
                  : screen === "open"
                    ? "Открыть по фразе"
                    : screen === "transfer"
                      ? "Перенести безопасно"
                      : "Создать хранилище",
              ),
            ),
          ),
        ),
      ),
    );
  }
  if (screen === "stash")
    return e(
      "section",
      { class: "planner stash-screen" },
      e(PageHeader, {
        eyebrow: "Локальное восстановление",
        title: "Отложенные заметки",
        description:
          "Зашифрованные локальные изменения, которые не удалось безопасно вернуть в исходное хранилище.",
        back: () => setScreen("list"),
      }),
      e(
        "details",
        {
          class: "compact-info-tip app-popover info",
          onToggle: keepOnlyPopover,
        },
        e(
          "summary",
          {
            class: "icon-button",
            "aria-label": "О локальных данных",
            title: "О локальных данных",
          },
          e(UiIcon, { name: "info", size: 18 }),
        ),
        e(
          "div",
          { class: "context-tip-panel" },
          "Эти данные сохранены только на этом устройстве. Перенесите их в доступное хранилище или оставьте до следующего раза.",
        ),
      ),
      e(
        "label",
        null,
        "Перенести в открытое хранилище",
        e(
          "select",
          {
            value: target,
            onChange: (ev: Event) =>
              setTarget((ev.target as HTMLSelectElement).value),
          },
          e("option", { value: "" }, "Выберите хранилище"),
          opened.map((v) =>
            e("option", { value: v.header.id }, names[v.header.id]),
          ),
        ),
      ),
      !opened.length &&
        e(
          "p",
          { class: "hint" },
          "Вернитесь назад и создайте или откройте хранилище. Заметки останутся здесь.",
        ),
      state?.stash.map((item) =>
        e(
          "article",
          { class: "note-row", key: item.id },
          e("h3", null, stash[item.id]?.title || "Без заголовка"),
          e("p", { class: "note-preview" }, stash[item.id]?.text),
          e(
            "div",
            { class: "actions" },
            e(
              "button",
              {
                disabled: busy || !opened.some((v) => v.header.id === target),
                onClick: () =>
                  void run(async () => {
                    await moveStash(user, item.id, target);
                    void sync();
                  }),
              },
              "Перенести",
            ),
            e(
              "button",
              {
                disabled: busy,
                onClick: async () => {
                  if (
                    await appConfirm("Восстановить её будет невозможно.", {
                      title: "Удалить эту отложенную заметку с устройства?",
                      confirmLabel: "Удалить",
                      danger: true,
                    })
                  )
                    void run(() => discardStash(user, item.id));
                },
              },
              "Удалить с устройства",
            ),
          ),
        ),
      ),
      !state?.stash.length && e("p", null, "Отложенных заметок нет"),
      feedback,
      e("button", { onClick: () => setScreen("list") }, "Оставить на потом"),
    );
  if (screen === "schedule") {
    const localNotes = (state?.vaults ?? [])
      .flatMap((current) =>
        current.key && !current.deleted
          ? heads(current).map((revision) => ({
              current,
              revision,
              note: notes[revision.id],
            }))
          : [],
      )
      .filter(
        (item) =>
          Boolean(item.note) &&
          statusOf(item.current, item.revision, item.note!) === "active",
      );
    const findLocal = (item: ReminderStatus) =>
      localNotes.find(
        (local) =>
          local.current.header.id === item.vault_id &&
          local.revision.objectId === item.object_id,
      );
    const nowLocal = localTime(Date.now(), zone),
      today = nowLocal.slice(0, 10),
      tomorrowDate = new Date(Date.parse(today + "T00:00:00Z") + 86400000)
        .toISOString()
        .slice(0, 10);
    const activeStatuses = new Set(["scheduled", "fired", "seen", "missed"]),
      visible = serverReminders
        .filter(
          (item) =>
            item.plan_state === "active" &&
            (showReminderHistory || activeStatuses.has(item.occurrence_status)),
        )
        .filter((item) => {
          if (!selectedTags.length) return true;
          const local = findLocal(item);
          return Boolean(
            local &&
            local.current.header.id === selected &&
            selectedTags.every((tagId) =>
              (local.note!.tagIds ?? []).includes(tagId),
            ),
          );
        });
    const taskItems = localNotes
      .filter(
        (item) =>
          entityKind(item.note!) === "task" &&
          item.note!.task &&
          item.note!.task!.status !== "cancelled",
      )
      .filter(
        (item) =>
          !selectedTags.length ||
          (item.current.header.id === selected &&
            selectedTags.every((tagId) =>
              (item.note!.tagIds ?? []).includes(tagId),
            )),
      );
    const taskDate = (item: (typeof taskItems)[number]) =>
      item.note!.task!.endDate ?? item.note!.task!.startDate ?? "";
    const activeTask = (item: (typeof taskItems)[number]) =>
      !["done", "cancelled"].includes(item.note!.task!.status);
    const taskGroups: [
      string,
      string,
      (item: (typeof taskItems)[number]) => boolean,
    ][] = [
      [
        "tasks-overdue",
        "Просрочено",
        (item) =>
          activeTask(item) && Boolean(taskDate(item)) && taskDate(item) < today,
      ],
      [
        "tasks-today",
        "Сегодня",
        (item) => activeTask(item) && taskDate(item) === today,
      ],
      [
        "tasks-upcoming",
        "Ближайшее",
        (item) => activeTask(item) && taskDate(item) > today,
      ],
      [
        "tasks-unscheduled",
        "Без срока",
        (item) => activeTask(item) && !taskDate(item),
      ],
      ["tasks-done", "Выполнено", (item) => item.note!.task!.status === "done"],
    ];
    const itemLocal = (item: ReminderStatus) =>
      item.snooze_local ?? item.scheduled_local;
    const groups: [string, string, (item: ReminderStatus) => boolean][] = [
      [
        "overdue",
        "Просрочено",
        (item) =>
          ["scheduled", "fired", "seen"].includes(item.occurrence_status) &&
          itemLocal(item) < nowLocal,
      ],
      [
        "today",
        "Сегодня",
        (item) =>
          ["scheduled", "fired", "seen"].includes(item.occurrence_status) &&
          itemLocal(item).slice(0, 10) === today &&
          itemLocal(item) >= nowLocal,
      ],
      [
        "tomorrow",
        "Завтра",
        (item) =>
          ["scheduled", "fired", "seen"].includes(item.occurrence_status) &&
          itemLocal(item).slice(0, 10) === tomorrowDate,
      ],
      [
        "later",
        "Позже",
        (item) =>
          ["scheduled", "fired", "seen"].includes(item.occurrence_status) &&
          itemLocal(item).slice(0, 10) > tomorrowDate,
      ],
      ["missed", "Пропущено", (item) => item.occurrence_status === "missed"],
      [
        "history",
        "История",
        (item) => ["done", "skipped"].includes(item.occurrence_status),
      ],
    ];
    const selectedItem = serverReminders.find(
        (item) => item.occurrence_id === selectedOccurrence,
      ),
      selectedLocal = selectedItem && findLocal(selectedItem);
    const repeatLabel = (item: ReminderStatus) => {
      const schedule = JSON.parse(item.schedule) as {
        repeat: ReminderRepeat;
        allDay: boolean;
        important: boolean;
      };
      return schedule.repeat.type === "once"
        ? "Один раз"
        : schedule.repeat.type === "daily"
          ? "Ежедневно"
          : schedule.repeat.type === "weekly"
            ? "По дням недели"
            : schedule.repeat.type === "interval"
              ? "Каждые " + schedule.repeat.days + " дн."
              : "Ежемесячно";
    };
    const refreshReminders = async () => {
      const value = await reminderRequest(user, "");
      setServerReminders(value.items);
      setReminderSettings(value.settings);
    };
    const act = (
      item: ReminderStatus,
      operation: "complete" | "skip" | "snooze" | "pause",
      local: null | string = null,
    ) =>
      void run(async () => {
        await reminderRequest(user, "action", {
          occurrenceId: item.occurrence_id,
          operation,
          local,
        });
        setSnoozeOpen(false);
        await refreshReminders();
      });
    const addNew = () => {
      const current = v?.key && !v.deleted ? v : opened[0];
      if (!current?.key) {
        setError("Сначала откройте хранилище");
        return;
      }
      select(current.header.id);
      const d: Draft = {
        vault: current.header.id,
        object: crypto.randomUUID(),
        revision: null,
        title: "",
        text: "",
        dirty: false,
        key: current.key,
        editorMode: "create",
      };
      showViewing(null);
      showDraft(d);
      prepareReminderForm(d);
    };
    const removeSchedule = () => {
      if (!selectedLocal) return;
      const d: Draft = {
        ...selectedLocal.note!,
        vault: selectedLocal.current.header.id,
        object: selectedLocal.revision.objectId,
        revision: selectedLocal.revision.id,
        dirty: true,
        key: selectedLocal.current.key!,
      };
      showDraft({ ...d, reminder: undefined });
      setSelectedOccurrence("");
      setScreen("list");
      void run(async () => {
        await flush();
        void sync();
      });
    };
    const pauseSchedule = () => {
      if (!selectedLocal?.note?.reminder) {
        act(selectedItem!, "pause");
        return;
      }
      const d: Draft = {
        ...selectedLocal.note,
        vault: selectedLocal.current.header.id,
        object: selectedLocal.revision.objectId,
        revision: selectedLocal.revision.id,
        dirty: true,
        key: selectedLocal.current.key!,
      };
      showDraft({
        ...d,
        reminder: { ...selectedLocal.note.reminder, state: "off" },
      });
      setSelectedOccurrence("");
      setScreen("list");
      void run(async () => {
        await flush();
        void sync();
      });
    };
    const formatLocal = (local: string) =>
      new Date(local + "Z").toLocaleString("ru-RU", {
        timeZone: "UTC",
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      });
    const compactHistoryLocal = (local: string) => {
      const [date, time = ""] = local.split("T"),
        [year, month, day] = date.split("-");
      return [day + "." + month + "." + year.slice(-2), time.slice(0, 5)];
    };
    if (selectedItem)
      return e(
        "section",
        { class: "card planner occurrence-detail" },
        e(
          "button",
          {
            class: "ui-back",
            "aria-label": "Назад",
            title: "Назад",
            onClick: () => {
              setSelectedOccurrence("");
              setSnoozeOpen(false);
            },
          },
          e(UiIcon, { name: "back", size: 18 }),
        ),
        e(
          "p",
          { class: "eyebrow" },
          selectedItem.occurrence_status === "missed"
            ? "ПРОПУЩЕНО"
            : selectedItem.occurrence_status === "done"
              ? "ВЫПОЛНЕНО"
              : "СРАБАТЫВАНИЕ",
        ),
        e(
          "h1",
          null,
          selectedLocal?.note?.title || "Напоминание из закрытого хранилища",
        ),
        e(
          "p",
          { class: "occurrence-time" },
          formatLocal(
            selectedItem.snooze_local ?? selectedItem.scheduled_local,
          ),
        ),
        e(
          "p",
          { class: "hint" },
          (names[selectedItem.vault_id] || "Закрытое хранилище") +
            " · " +
            repeatLabel(selectedItem) +
            (JSON.parse(selectedItem.schedule).important ? " · Важное" : ""),
        ),
        selectedLocal &&
          e(
            "article",
            { class: "linked-note" },
            e("strong", null, "Связанная заметка"),
            e(
              "p",
              null,
              selectedLocal.note!.text.slice(0, 180) || "Нет текста",
            ),
          ),
        ["scheduled", "fired", "seen"].includes(
          selectedItem.occurrence_status,
        ) &&
          e(
            "div",
            { class: "actions occurrence-actions" },
            e(
              "button",
              {
                class: "primary",
                disabled: busy,
                onClick: () => act(selectedItem, "complete"),
              },
              "Выполнить",
            ),
            e(
              "button",
              { disabled: busy, onClick: () => setSnoozeOpen(!snoozeOpen) },
              "Отложить",
            ),
          ),
        snoozeOpen &&
          e(
            "section",
            { class: "snooze-sheet" },
            e("h2", null, "Отложить"),
            e(
              "div",
              { class: "quick-filters" },
              [
                [15, "15 минут"],
                [60, "1 час"],
                [180, "3 часа"],
              ].map(([minutes, label]) =>
                e(
                  "button",
                  {
                    disabled: busy,
                    onClick: () =>
                      act(
                        selectedItem,
                        "snooze",
                        localTime(Date.now() + Number(minutes) * 60000, zone),
                      ),
                  },
                  label,
                ),
              ),
              e(
                "button",
                {
                  disabled: busy,
                  onClick: () =>
                    act(selectedItem, "snooze", localDateAfter(1) + "T09:00"),
                },
                "Завтра, 09:00",
              ),
              e(
                "button",
                {
                  disabled: busy,
                  onClick: () => {
                    let ms = Date.now() + 86400000;
                    while (
                      ![6, 7].includes(
                        new Date(localTime(ms, zone) + "Z").getUTCDay() || 7,
                      )
                    )
                      ms += 86400000;
                    act(
                      selectedItem,
                      "snooze",
                      localTime(ms, zone).slice(0, 10) + "T09:00",
                    );
                  },
                },
                "На выходные",
              ),
            ),
            e(
              "label",
              null,
              "Своя дата и время",
              e("input", {
                type: "datetime-local",
                value: snoozeLocal,
                min: localTime(Date.now() + 60000, zone),
                onInput: (ev: Event) =>
                  setSnoozeLocal((ev.target as HTMLInputElement).value),
              }),
            ),
            e(
              "button",
              {
                class: "primary",
                disabled: busy || !snoozeLocal,
                onClick: () => act(selectedItem, "snooze", snoozeLocal),
              },
              "Отложить",
            ),
          ),
        e(
          "div",
          { class: "actions" },
          selectedLocal &&
            e(
              "button",
              {
                onClick: () => {
                  openRevision(selectedLocal.current, selectedLocal.revision);
                  setSelectedOccurrence("");
                  setScreen("list");
                },
              },
              "Открыть заметку",
            ),
          selectedLocal &&
            e(
              "button",
              {
                onClick: () => {
                  setSelectedOccurrence("");
                  editReminderFor(
                    selectedLocal.current,
                    selectedLocal.revision,
                  );
                },
              },
              "Изменить напоминание",
            ),
          e(
            "button",
            { disabled: busy, onClick: pauseSchedule },
            "Приостановить расписание",
          ),
        ),
        selectedLocal
          ? e(
              "button",
              {
                class: "danger-button",
                disabled: busy,
                onClick: async () => {
                  if (
                    await appConfirm("", {
                      title:
                        "Удалить расписание и всю историю его срабатываний?",
                      confirmLabel: "Удалить",
                      danger: true,
                    })
                  )
                    removeSchedule();
                },
              },
              "Удалить напоминание",
            )
          : state?.vaults.some(
              (item) =>
                item.header.id === selectedItem.vault_id &&
                !item.deleted &&
                !item.key,
            ) &&
              e(
                "button",
                { onClick: () => form("open", selectedItem.vault_id) },
                "Открыть хранилище",
              ),
        feedback,
      );
    return e(
      "section",
      { class: "planner today-screen" },
      e(PageHeader, {
        eyebrow: new Date().toLocaleDateString("ru-RU", {
          weekday: "long",
          day: "numeric",
          month: "long",
        }),
        title: "Сегодня",
        description:
          "Задачи по срокам и напоминания, которые требуют внимания.",
        back: section !== "today" ? () => setScreen("list") : undefined,
        actions: e(
          "button",
          {
            class: "primary today-add",
            onClick: () => setTodayMenuOpen(!todayMenuOpen),
            "aria-expanded": todayMenuOpen,
          },
          e(UiIcon, { name: "plus", size: 17 }),
          "Добавить",
        ),
      }),
      e(
        "div",
        { class: "today-counters" },
        e(
          "div",
          null,
          e(
            "strong",
            null,
            String(
              taskItems.filter(taskGroups[0][2]).length +
                visible.filter(groups[0][2]).length,
            ),
          ),
          e("span", null, "Просрочено"),
        ),
        e(
          "div",
          null,
          e(
            "strong",
            null,
            String(
              taskItems.filter(taskGroups[1][2]).length +
                visible.filter(groups[1][2]).length,
            ),
          ),
          e("span", null, "Сегодня"),
        ),
        e(
          "div",
          null,
          e(
            "strong",
            null,
            String(
              taskItems.filter(taskGroups[2][2]).length +
                visible.filter(
                  (item) => groups[2][2](item) || groups[3][2](item),
                ).length,
            ),
          ),
          e("span", null, "Ближайшее"),
        ),
        e(
          "div",
          null,
          e("strong", null, String(taskItems.filter(taskGroups[4][2]).length)),
          e("span", null, "Выполнено"),
        ),
      ),
      todayMenuOpen &&
        e(
          "div",
          { class: "note-action-menu today-add-menu" },
          e("button", { onClick: addNew }, "Новая заметка с напоминанием"),
          e(
            "button",
            { onClick: () => setTodayPickOpen(!todayPickOpen) },
            "Выбрать существующую заметку",
          ),
        ),
      todayPickOpen &&
        e(
          "div",
          { class: "today-note-picker" },
          localNotes.map((item) =>
            e(
              "button",
              {
                class: "note-row",
                key: item.revision.id,
                onClick: () => {
                  setTodayMenuOpen(false);
                  setTodayPickOpen(false);
                  editReminderFor(item.current, item.revision);
                },
              },
              e("strong", null, item.note!.title || "Без заголовка"),
              e("small", null, names[item.current.header.id]),
            ),
          ),
        ),
      e(
        "details",
        { class: "today-options" },
        e(
          "summary",
          null,
          e(UiIcon, { name: "more", size: 18 }),
          "Параметры",
          Boolean(selectedTags.length || showReminderHistory) &&
            e("span", { class: "mobile-control-dot", "aria-hidden": "true" }),
        ),
        e(
          "div",
          { class: "today-options-panel" },
          v?.key &&
            e(TagPicker, {
              tags: activeTags(v.header.id),
              selectedIds: selectedTags,
              onChange: setSelectedTags,
              onManage: () => openTagManager("schedule"),
              mode: "inline",
            }),
          e(
            "label",
            { class: "check-row history-toggle" },
            e("input", {
              type: "checkbox",
              checked: showReminderHistory,
              onChange: (ev: Event) =>
                setShowReminderHistory((ev.target as HTMLInputElement).checked),
            }),
            "Показать выполненное и пропущенное",
          ),
        ),
      ),
      !visible.length &&
        !taskItems.some(activeTask) &&
        e(
          "div",
          { class: "empty-state" },
          e("h2", null, "На сегодня ничего не запланировано"),
          e(
            "p",
            null,
            "Задачи со сроком и напоминания появятся здесь автоматически.",
          ),
        ),
      taskGroups.map(([key, label, test]) => {
        const items = taskItems.filter(test);
        if ((key === "tasks-done" && !showReminderHistory) || !items.length)
          return null;
        return e(
          "section",
          { class: "today-group today-task-group", key },
          e("h2", null, "Задачи · " + label),
          items.map((item) => {
            const task = item.note!.task!,
              project = localNotes.find(
                (candidate) =>
                  entityKind(candidate.note!) === "project" &&
                  candidate.revision.objectId === item.note!.projectId,
              )?.note;
            const due = taskDate(item);
            return e(
              "button",
              {
                class:
                  "today-task-row" +
                  (task.status === "done" ? " completed" : ""),
                key: item.revision.id,
                onClick: onOpenProjects,
              },
              e(
                "span",
                { class: "task-status-control", "aria-hidden": "true" },
                task.status === "done"
                  ? e(UiIcon, { name: "check", size: 14 })
                  : null,
              ),
              e(
                "span",
                { class: "today-task-copy" },
                e("strong", null, item.note!.title || "Без названия"),
                e(
                  "small",
                  null,
                  [
                    project?.title,
                    names[item.current.header.id],
                    due
                      ? new Date(due + "T00:00:00Z").toLocaleDateString(
                          "ru-RU",
                          { day: "numeric", month: "short" },
                        )
                      : "Без срока",
                  ]
                    .filter(Boolean)
                    .join(" · "),
                ),
              ),
              e(
                "span",
                { class: "occurrence-chevron" },
                e(UiIcon, { name: "chevron-right", size: 17 }),
              ),
            );
          }),
        );
      }),
      groups.map(([key, label, test]) => {
        const items = visible.filter(test);
        return items.length
          ? e(
              "section",
              { class: "today-group reminder-group", key },
              e("h2", null, "Напоминания · " + label),
              items.map((item) => {
                const local = findLocal(item),
                  schedule = JSON.parse(item.schedule),
                  localValue = itemLocal(item),
                  historyTime = compactHistoryLocal(localValue);
                return e(
                  "button",
                  {
                    class:
                      "occurrence-row" +
                      (schedule.important ? " important" : ""),
                    key: item.occurrence_id,
                    onClick: () => setSelectedOccurrence(item.occurrence_id),
                  },
                  key === "today"
                    ? e(
                        "span",
                        { class: "occurrence-time" },
                        schedule.allDay
                          ? "Весь день"
                          : localValue.slice(11, 16),
                      )
                    : e(
                        "span",
                        { class: "occurrence-time history-date" },
                        e("span", null, historyTime[0]),
                        e(
                          "span",
                          null,
                          schedule.allDay ? "Весь день" : historyTime[1],
                        ),
                      ),
                  e(
                    "span",
                    { class: "occurrence-copy" },
                    e(
                      "strong",
                      null,
                      local?.note?.title ||
                        "Напоминание из закрытого хранилища",
                    ),
                    e(
                      "small",
                      null,
                      (names[item.vault_id] || "Закрытое хранилище") +
                        " · " +
                        repeatLabel(item) +
                        (item.snooze_local ? " · Отложено" : ""),
                    ),
                  ),
                  e(
                    "span",
                    { class: "occurrence-chevron" },
                    e(UiIcon, { name: "chevron-right", size: 17 }),
                  ),
                );
              }),
            )
          : null;
      }),
      feedback,
    );
  }
  if (screen === "tags" && v?.key) {
    const catalog = activeTags(v.header.id),
      leaveTags = () => {
        const pending = tagEditorDraft.current;
        tagEditorDraft.current = null;
        setScreen(tagEditorReturn.current);
        setEditingTag("");
        setTagName("");
        if (pending) showDraft(pending);
      };
    return e(
      "section",
      { class: "planner tag-manager" },
      e(PageHeader, {
        eyebrow: "Организация",
        title: "Теги хранилища",
        description:
          "Названия и цвета тегов хранятся в зашифрованном виде. Удаление тега не удаляет заметки.",
        back: leaveTags,
      }),
      e(
        "form",
        {
          class: "tag-form",
          onSubmit: (event: Event) => {
            event.preventDefault();
            void run(async () => {
              if (editingTag)
                await renameTag(user, selected, editingTag, tagName, tagColor);
              else await createTag(user, selected, tagName, tagColor);
              setTagName("");
              setEditingTag("");
              void sync();
            });
          },
        },
        e(
          "label",
          null,
          editingTag ? "Название тега" : "Новый тег",
          e("input", {
            required: true,
            maxLength: 60,
            value: tagName,
            onInput: (ev: Event) =>
              setTagName((ev.target as HTMLInputElement).value),
          }),
        ),
        e(
          "label",
          null,
          "Цвет",
          e("input", {
            type: "color",
            value: tagColor,
            onInput: (ev: Event) =>
              setTagColor((ev.target as HTMLInputElement).value),
          }),
        ),
        e(
          "button",
          { class: "primary", disabled: busy },
          editingTag ? "Сохранить" : "Добавить",
        ),
        editingTag &&
          e(
            "button",
            {
              type: "button",
              onClick: () => {
                setEditingTag("");
                setTagName("");
              },
            },
            "Отмена",
          ),
      ),
      catalog.map((tag) => {
        const count = heads(v).filter(
          (r) =>
            entityKind(notes[r.id] ?? { title: "", text: "" }) !== "project" &&
            (notes[r.id]?.tagIds ?? []).includes(tag.id),
        ).length;
        return e(
          "div",
          { class: "tag-manage-row", key: tag.id },
          e(
            "span",
            { class: "tag-chip", style: { "--tag-color": tag.color } },
            tag.name,
          ),
          e("small", null, count + " объектов"),
          e(
            "button",
            {
              onClick: () => {
                setEditingTag(tag.id);
                setTagName(tag.name);
                setTagColor(tag.color);
              },
            },
            "Изменить",
          ),
          e(
            "button",
            {
              class: "icon-danger",
              onClick: async () => {
                if (
                  await appConfirm("Заметки останутся на месте.", {
                    title: "Удалить тег «" + tag.name + "»?",
                    confirmLabel: "Удалить",
                    danger: true,
                  })
                )
                  void run(async () => {
                    await deleteTag(user, selected, tag.id);
                    setSelectedTags((current) =>
                      current.filter((id) => id !== tag.id),
                    );
                    void sync();
                  });
              },
            },
            "Удалить",
          ),
        );
      }),
      feedback,
    );
  }
  if ((screen === "archive" || screen === "trash") && v?.key) {
    const wanted = screen === "archive" ? "archived" : "trashed",
      normalized = query.trim().toLocaleLowerCase("ru");
    const conflictObjects = [
      ...new Set(heads(v).map((revision) => revision.objectId)),
    ].filter((objectId) => {
      const versions = heads(v).filter(
        (revision) => revision.objectId === objectId,
      );
      return (
        versions.length > 1 &&
        versions.some(
          (revision) =>
            notes[revision.id] &&
            statusOf(v, revision, notes[revision.id]) === wanted,
        )
      );
    });
    const items = heads(v)
      .map((revision) => ({ revision, note: notes[revision.id] }))
      .filter(
        (item): item is { revision: Revision; note: Note } =>
          Boolean(item.note) && entityKind(item.note!) === "note",
      )
      .filter(
        (item) =>
          !conflictObjects.includes(item.revision.objectId) &&
          statusOf(v, item.revision, item.note) === wanted &&
          !(
            screen === "trash" &&
            v.purgePending?.includes(item.revision.objectId)
          ) &&
          selectedTags.every((tagId) =>
            (item.note.tagIds ?? []).includes(tagId),
          ),
      )
      .map((item) => ({
        ...item,
        score: normalized
          ? noteSearchScore(query, {
              note: item.note,
              tags: tagChips(v.header.id, item.note.tagIds),
            })
          : 0,
      }))
      .filter((item) => !normalized || item.score)
      .sort((a, b) =>
        normalized
          ? searchSort === "relevance"
            ? b.score - a.score
            : searchSort === "oldest"
              ? (a.note.author?.time ?? 0) - (b.note.author?.time ?? 0)
              : (b.note.author?.time ?? 0) - (a.note.author?.time ?? 0)
          : sort === "title"
            ? a.note.title.localeCompare(b.note.title, "ru")
            : sort === "oldest"
              ? (a.note.author?.time ?? 0) - (b.note.author?.time ?? 0)
              : (b.note.author?.time ?? 0) - (a.note.author?.time ?? 0),
      );
    const all = heads(v)
      .map((revision) => ({ revision, note: notes[revision.id] }))
      .filter(
        (item): item is { revision: Revision; note: Note } =>
          Boolean(item.note) &&
          entityKind(item.note!) === "note" &&
          statusOf(v, item.revision, item.note) === wanted &&
          !v.purgePending?.includes(item.revision.objectId),
      );
    const lifecycleActions = e(
      "div",
      { class: "lifecycle-header-actions" },
      e(
        "details",
        {
          class:
            "lifecycle-info-tip app-popover " +
            (screen === "archive" ? "info" : "warning"),
          onToggle: keepOnlyPopover,
        },
        e(
          "summary",
          {
            class: "icon-button",
            "aria-label": "Информация",
            title: "Информация",
          },
          e(UiIcon, { name: "info", size: 19 }),
        ),
        e(
          "div",
          { class: "lifecycle-tool-panel" },
          screen === "archive"
            ? "Архивные заметки не удалены. Напоминания для них приостановлены."
            : "До даты окончательного удаления заметку можно восстановить вместе с её историей.",
        ),
      ),
      e(
        "details",
        { class: "lifecycle-tool app-popover", onToggle: keepOnlyPopover },
        e(
          "summary",
          { class: "icon-button", "aria-label": "Поиск", title: "Поиск" },
          e(UiIcon, { name: "search", size: 19 }),
          normalized &&
            e("span", { class: "mobile-control-dot", "aria-hidden": "true" }),
        ),
        e(
          "div",
          { class: "lifecycle-tool-panel" },
          e(
            "label",
            { class: "search-field" },
            e("span", { class: "sr-only" }, "Поиск"),
            e(
              "span",
              { class: "search-input-wrap" },
              e(UiIcon, { name: "search", size: 18 }),
              e("input", {
                type: "search",
                value: query,
                placeholder: "Найти заметку",
                onInput: (event: Event) =>
                  setQuery((event.target as HTMLInputElement).value),
              }),
            ),
          ),
        ),
      ),
      e(
        "details",
        { class: "lifecycle-tool app-popover", onToggle: keepOnlyPopover },
        e(
          "summary",
          {
            class: "icon-button",
            "aria-label": "Сортировка и фильтры",
            title: "Сортировка и фильтры",
          },
          e(UiIcon, { name: "settings", size: 19 }),
          selectedTags.length > 0 &&
            e("span", { class: "mobile-control-dot", "aria-hidden": "true" }),
        ),
        e(
          "div",
          { class: "lifecycle-tool-panel lifecycle-filter-panel" },
          normalized
            ? e(
                "label",
                { class: "sort-control" },
                e("span", null, "Сортировка"),
                e(
                  "select",
                  {
                    value: searchSort,
                    onChange: (event: Event) =>
                      setSearchSort(
                        (event.target as HTMLSelectElement)
                          .value as typeof searchSort,
                      ),
                  },
                  e("option", { value: "relevance" }, "По релевантности"),
                  e("option", { value: "newest" }, "Сначала новые"),
                  e("option", { value: "oldest" }, "Сначала старые"),
                ),
              )
            : e(
                "label",
                { class: "sort-control" },
                e("span", null, "Сортировка"),
                e(
                  "select",
                  {
                    value: sort,
                    onChange: (event: Event) =>
                      setSort(
                        (event.target as HTMLSelectElement)
                          .value as typeof sort,
                      ),
                  },
                  e("option", { value: "newest" }, "Сначала новые"),
                  e("option", { value: "oldest" }, "Сначала старые"),
                  e("option", { value: "title" }, "По заголовку"),
                ),
              ),
          e(TagPicker, {
            tags: activeTags(v.header.id),
            selectedIds: selectedTags,
            onChange: setSelectedTags,
            onManage: () => openTagManager(screen),
            mode: "inline",
          }),
        ),
      ),
      screen === "trash" &&
        Boolean(all.length) &&
        e(
          "button",
          {
            class: "icon-button lifecycle-empty-trash",
            disabled: busy,
            "aria-label": "Очистить корзину",
            title: "Очистить корзину",
            onClick: async () => {
              if (
                await appConfirm(
                  "Восстановление средствами приложения будет невозможно.",
                  {
                    title: "Окончательно удалить все заметки из корзины?",
                    confirmLabel: "Очистить корзину",
                    danger: true,
                  },
                )
              )
                void run(async () => {
                  for (const item of all)
                    await permanentlyDeleteNote(
                      user,
                      v.header.id,
                      item.revision.objectId,
                    );
                  setStatus(
                    "Очистка корзины поставлена в очередь синхронизации.",
                  );
                  void sync();
                });
            },
          },
          e(UiIcon, { name: "trash", size: 19 }),
        ),
    );
    return e(
      "section",
      { class: "planner lifecycle-screen" },
      e(PageHeader, {
        title: screen === "archive" ? "Архив" : "Корзина",
        description:
          screen === "archive"
            ? "Архивированные заметки остаются в хранилище и могут быть восстановлены."
            : "Удалённые заметки хранятся 30 дней до окончательного удаления.",
        back: () => {
          setQuery("");
          setSelectedTags([]);
          setScreen("list");
        },
        actions: lifecycleActions,
      }),
      conflictObjects.map((objectId) =>
        e(
          "button",
          {
            class: "conflict-notice",
            disabled: busy,
            key: "conflict-" + objectId,
            onClick: () => {
              const versions = heads(v)
                .filter((revision) => revision.objectId === objectId)
                .map((revision) => revision.id);
              setComparison({ objectId, versions, chosen: versions[0] });
              setScreen("conflict");
            },
          },
          "Разрешить конфликт версий: " +
            (notes[
              heads(v).find((revision) => revision.objectId === objectId)!.id
            ]?.title || "Без заголовка"),
        ),
      ),
      !items.length &&
        e(
          "div",
          { class: "empty-state" },
          e(
            "h2",
            null,
            normalized
              ? "Ничего не найдено"
              : screen === "archive"
                ? "Архив пуст"
                : "Корзина пуста",
          ),
          e(
            "p",
            null,
            normalized
              ? "Измените поисковый запрос."
              : screen === "archive"
                ? "Архивированные заметки появятся здесь."
                : "Удалённые заметки будут храниться здесь 30 дней.",
          ),
        ),
      items.map((item) => {
        const expiry = v.objectStates?.[item.revision.objectId]?.purgeAfter;
        const swipeOffset =
          lifecycleSwipe?.id === item.revision.id ? lifecycleSwipe.offset : 0;
        const finishLifecycleSwipe = () => {
          const offset = lifecycleSwipeOffset.current,
            width = lifecycleSwipeWidth.current;
          lifecycleTouchX.current = null;
          if (Math.abs(offset) >= Math.max(140, width * 0.55)) {
            setLifecycleSwipe({
              id: item.revision.id,
              offset: offset > 0 ? width : -width,
              dragging: false,
            });
            window.setTimeout(() => {
              if (offset > 0) {
                void run(() => restoreTrash(v, item.revision.objectId));
                return;
              }
              void (async () => {
                if (
                  await appConfirm("", {
                    title: "Удалить заметку и всю историю навсегда?",
                    confirmLabel: "Удалить навсегда",
                    danger: true,
                  })
                )
                  void run(() => purgeCurrent(v, item.revision.objectId));
                else setLifecycleSwipe(null);
              })();
            }, 180);
          } else if (Math.abs(offset) > 46)
            setLifecycleSwipe({
              id: item.revision.id,
              offset: offset > 0 ? 84 : -84,
              dragging: false,
            });
          else setLifecycleSwipe(null);
        };
        return e(
          "article",
          {
            class:
              "lifecycle-item" +
              (screen === "trash" ? " trash-swipe-item" : "") +
              (swipeOffset > 0
                ? " swipe-restore"
                : swipeOffset < 0
                  ? " swipe-purge"
                  : "") +
              (lifecycleSwipe?.id === item.revision.id &&
              lifecycleSwipe.dragging
                ? " dragging"
                : ""),
            key: item.revision.id,
            "data-swipe-id": item.revision.id,
            style:
              screen === "trash"
                ? { "--swipe-reveal": Math.abs(swipeOffset) + "px" }
                : undefined,
          },
          screen === "trash" &&
            e(
              "button",
              {
                class: "trash-swipe-action restore",
                "aria-label": "Восстановить заметку",
                onClick: () => {
                  setLifecycleSwipe(null);
                  void run(() => restoreTrash(v, item.revision.objectId));
                },
              },
              e(UiIcon, { name: "history", size: 20 }),
            ),
          screen === "trash" &&
            e(
              "button",
              {
                class: "trash-swipe-action purge",
                "aria-label": "Удалить навсегда",
                onClick: async () => {
                  if (
                    await appConfirm("", {
                      title: "Удалить заметку и всю историю навсегда?",
                      confirmLabel: "Удалить навсегда",
                      danger: true,
                    })
                  ) {
                    setLifecycleSwipe(null);
                    void run(() => purgeCurrent(v, item.revision.objectId));
                  }
                },
              },
              e(UiIcon, { name: "trash", size: 20 }),
            ),
          e(
            "button",
            {
              class: "lifecycle-item-main",
              style:
                screen === "trash"
                  ? { transform: `translateX(${swipeOffset}px)` }
                  : undefined,
              onTouchStart:
                screen === "trash"
                  ? (event: TouchEvent) => {
                      const element = event.currentTarget as HTMLElement,
                        existing =
                          lifecycleSwipe?.id === item.revision.id
                            ? lifecycleSwipe.offset
                            : 0;
                      lifecycleTouchX.current =
                        event.touches[0]?.clientX ?? null;
                      lifecycleSwipeWidth.current =
                        element.getBoundingClientRect().width;
                      lifecycleSwipeStartOffset.current = existing;
                      lifecycleSwipeOffset.current = existing;
                      lifecycleSwipeMoved.current = false;
                      setLifecycleSwipe({
                        id: item.revision.id,
                        offset: existing,
                        dragging: true,
                      });
                    }
                  : undefined,
              onTouchMove:
                screen === "trash"
                  ? (event: TouchEvent) => {
                      const start = lifecycleTouchX.current,
                        current = event.touches[0]?.clientX;
                      if (start !== null && current !== undefined) {
                        const delta = current - start,
                          activation = window.innerWidth * 0.05,
                          distance = Math.abs(delta),
                          drag =
                            distance >= activation
                              ? Math.sign(delta) * (distance - activation)
                              : 0,
                          offset = Math.max(
                            -lifecycleSwipeWidth.current,
                            Math.min(
                              lifecycleSwipeWidth.current,
                              lifecycleSwipeStartOffset.current + drag,
                            ),
                          );
                        lifecycleSwipeOffset.current = offset;
                        if (distance >= activation)
                          lifecycleSwipeMoved.current = true;
                        setLifecycleSwipe({
                          id: item.revision.id,
                          offset,
                          dragging: true,
                        });
                      }
                    }
                  : undefined,
              onTouchEnd: screen === "trash" ? finishLifecycleSwipe : undefined,
              onTouchCancel:
                screen === "trash"
                  ? () => {
                      lifecycleTouchX.current = null;
                      lifecycleSwipeOffset.current =
                        lifecycleSwipeStartOffset.current;
                      setLifecycleSwipe(
                        lifecycleSwipeStartOffset.current
                          ? {
                              id: item.revision.id,
                              offset: lifecycleSwipeStartOffset.current,
                              dragging: false,
                            }
                          : null,
                      );
                    }
                  : undefined,
              onClick: () => {
                if (lifecycleSwipeMoved.current) {
                  lifecycleSwipeMoved.current = false;
                  return;
                }
                openRevision(v, item.revision);
              },
            },
            e(
              "div",
              { class: "lifecycle-title-row" },
              e("strong", null, item.note.title || "Без заголовка"),
              screen === "trash" &&
                expiry &&
                e(
                  "span",
                  { class: "badge" },
                  "до " + new Date(expiry).toLocaleDateString("ru-RU"),
                ),
            ),
            e("span", { class: "note-preview" }, item.note.text.slice(0, 140)),
            tagChips(v.header.id, item.note.tagIds).length > 0 &&
              e(
                "span",
                { class: "tag-list" },
                tagChips(v.header.id, item.note.tagIds).map((tag) =>
                  e(
                    "span",
                    {
                      class: "tag-chip",
                      style: { "--tag-color": tag.color },
                      key: tag.id,
                    },
                    tag.name,
                  ),
                ),
              ),
            e(
              "small",
              null,
              screen === "trash"
                ? expiry
                  ? "Будет удалено " +
                    new Date(expiry).toLocaleDateString("ru-RU")
                  : "Ожидает синхронизации срока удаления"
                : "В архиве с " +
                    new Date(
                      item.note.lifecycle?.changedAt ??
                        item.note.author?.time ??
                        0,
                    ).toLocaleString("ru-RU"),
            ),
          ),
          screen === "archive" &&
            e(
              "div",
              { class: "lifecycle-item-actions" },
              e(
                "button",
                {
                  class: "secondary-button",
                  disabled: busy,
                  onClick: () =>
                    void run(() => restoreArchive(v, item.revision, item.note)),
                },
                "Восстановить",
              ),
              e(
                "button",
                {
                  class: "tertiary-button",
                  disabled: busy,
                  onClick: () =>
                    void run(() =>
                      openHistory(v, item.revision.objectId, screen),
                    ),
                },
                "История",
              ),
            ),
        );
      }),
      feedback,
    );
  }
  const normalizedQuery = query.trim().toLocaleLowerCase("ru");
  const candidates = (
    normalizedQuery
      ? (state?.vaults ?? []).filter(
          (current) => current.key && !current.deleted && !current.transfer,
        )
      : v?.key
        ? [v]
        : []
  ).flatMap((current) =>
    heads(current)
      .map((revision) => ({ current, revision, note: notes[revision.id] }))
      .filter(
        (item) =>
          Boolean(item.note) &&
          entityKind(item.note!) === "note" &&
          statusOf(current, item.revision, item.note!) === "active",
      ),
  );
  const visibleItems = candidates
    .map((item) => ({
      ...item,
      score: normalizedQuery
        ? noteSearchScore(query, {
            note: item.note!,
            tags: tagChips(item.current.header.id, item.note!.tagIds),
          })
        : 0,
    }))
    .filter(({ current, note, score }) => {
      if (normalizedQuery && !score) return false;
      if (
        (quickFilter === "pinned" && !note!.pinned) ||
        (quickFilter === "untagged" &&
          (note!.tagIds ?? []).some((id) =>
            activeTags(current.header.id).some((tag) => tag.id === id),
          )) ||
        (quickFilter === "reminder" && !note!.reminder)
      )
        return false;
      return (
        (!selectedTags.length || current.header.id === selected) &&
        selectedTags.every((tagId) => (note!.tagIds ?? []).includes(tagId))
      );
    })
    .sort((a, b) =>
      normalizedQuery
        ? searchSort === "relevance"
          ? b.score - a.score ||
            (b.note!.author?.time ?? 0) - (a.note!.author?.time ?? 0)
          : searchSort === "oldest"
            ? (a.note!.author?.time ?? 0) - (b.note!.author?.time ?? 0)
            : (b.note!.author?.time ?? 0) - (a.note!.author?.time ?? 0)
        : Number(Boolean(b.note!.pinned)) - Number(Boolean(a.note!.pinned)) ||
          (sort === "title"
            ? a.note!.title.localeCompare(b.note!.title, "ru")
            : sort === "oldest"
              ? (a.note!.author?.time ?? 0) - (b.note!.author?.time ?? 0)
              : (b.note!.author?.time ?? 0) - (a.note!.author?.time ?? 0)),
    );
  return e(
    "section",
    { class: "planner planner-list-screen notes-workspace" },
    e(PageHeader, {
      eyebrow: "Рабочая область",
      title: "Заметки",
      description: v?.key
        ? names[v.header.id] || "Открытое хранилище"
        : "Выберите или откройте хранилище.",
      actions: e(
        "button",
        {
          class: "tertiary-button notes-sync-action",
          disabled: busy,
          onClick: () => void run(sync),
        },
        e(UiIcon, { name: "sync", size: 17 }),
        "Синхронизировать",
      ),
    }),
    e(
      "div",
      { class: "notes-mobile-toolbar" },
      e(
        "details",
        {
          class: "notes-mobile-search-menu app-popover",
          onToggle: keepOnlyPopover,
        },
        e(
          "summary",
          { class: "icon-button", "aria-label": "Поиск", title: "Поиск" },
          e(UiIcon, { name: "search", size: 19 }),
          Boolean(normalizedQuery) &&
            e("span", { class: "mobile-control-dot", "aria-hidden": "true" }),
        ),
        e(
          "div",
          { class: "notes-mobile-panel notes-mobile-search-panel" },
          e(
            "label",
            { class: "search-field" },
            e("span", { class: "sr-only" }, "Поиск"),
            e(
              "span",
              { class: "search-input-wrap" },
              e(UiIcon, { name: "search", size: 18 }),
              e("input", {
                type: "search",
                value: query,
                placeholder: "Поиск заметок",
                onInput: (ev: Event) =>
                  setQuery((ev.target as HTMLInputElement).value),
              }),
            ),
          ),
        ),
      ),
      e(
        "details",
        {
          class: "notes-mobile-filter-menu app-popover",
          onToggle: keepOnlyPopover,
        },
        e(
          "summary",
          {
            class: "icon-button",
            "aria-label": "Фильтры и сортировка",
            title: "Фильтры и сортировка",
          },
          e(UiIcon, { name: "filter-dropdown", size: 20 }),
          (quickFilter !== "all" ||
            selectedTags.length > 0 ||
            sort !== "newest" ||
            searchSort !== "relevance") &&
            e("span", { class: "mobile-control-dot", "aria-hidden": "true" }),
        ),
        e(
          "div",
          { class: "notes-mobile-panel" },
          normalizedQuery
            ? e(
                "label",
                { class: "sort-control" },
                e("span", null, "Сортировка"),
                e(
                  "select",
                  {
                    value: searchSort,
                    onChange: (ev: Event) =>
                      setSearchSort(
                        (ev.target as HTMLSelectElement)
                          .value as typeof searchSort,
                      ),
                  },
                  e("option", { value: "relevance" }, "По релевантности"),
                  e("option", { value: "newest" }, "Сначала новые"),
                  e("option", { value: "oldest" }, "Сначала старые"),
                ),
              )
            : e(
                "label",
                { class: "sort-control" },
                e("span", null, "Сортировка"),
                e(
                  "select",
                  {
                    value: sort,
                    onChange: (ev: Event) =>
                      setSort(
                        (ev.target as HTMLSelectElement).value as typeof sort,
                      ),
                  },
                  e("option", { value: "newest" }, "Сначала новые"),
                  e("option", { value: "oldest" }, "Сначала старые"),
                  e("option", { value: "title" }, "По заголовку"),
                ),
              ),
          v?.key &&
            e(
              "div",
              { class: "mobile-filter-groups" },
              e(
                "div",
                { class: "quick-filters" },
                (
                  [
                    ["all", "Все"],
                    ["pinned", "Закреплённые"],
                    ["untagged", "Без тегов"],
                    ["reminder", "С напоминанием"],
                  ] as const
                ).map(([value, label]) =>
                  e(
                    "button",
                    {
                      class:
                        quickFilter === value
                          ? "filter-chip selected"
                          : "filter-chip",
                      "aria-pressed": quickFilter === value,
                      onClick: () => setQuickFilter(value),
                    },
                    label,
                  ),
                ),
              ),
              e(TagPicker, {
                tags: activeTags(v.header.id),
                selectedIds: selectedTags,
                onChange: setSelectedTags,
                onManage: () => openTagManager("list"),
                mode: "inline",
              }),
            ),
        ),
      ),
      e(
        "details",
        {
          class: "notes-mobile-more-menu app-popover",
          onToggle: keepOnlyPopover,
        },
        e(
          "summary",
          {
            class: "icon-button",
            "aria-label": "Дополнительные действия",
            title: "Дополнительные действия",
          },
          e(UiIcon, { name: "more", size: 20 }),
        ),
        e(
          "div",
          { class: "notes-mobile-panel notes-mobile-more-panel" },
          e(
            "button",
            {
              class: "mobile-menu-row",
              disabled: busy,
              onClick: (event: Event) => {
                (event.currentTarget as HTMLElement)
                  .closest("details")
                  ?.removeAttribute("open");
                setDesktopMenu(null);
                void run(sync);
              },
            },
            e(UiIcon, { name: "sync", size: 18 }),
            "Синхронизировать",
          ),
          e(
            "button",
            {
              class: "mobile-menu-row",
              disabled: busy,
              onClick: () => form("create"),
            },
            e(UiIcon, { name: "plus", size: 18 }),
            "Новое хранилище",
          ),
          e(
            "button",
            {
              class: "mobile-menu-row",
              disabled: !v?.key,
              onClick: () => {
                setQuery("");
                setSelectedTags([]);
                setScreen("archive");
              },
            },
            e(UiIcon, { name: "archive", size: 18 }),
            "Архив",
          ),
          e(
            "button",
            {
              class: "mobile-menu-row",
              disabled: !v?.key,
              onClick: () => {
                setQuery("");
                setSelectedTags([]);
                setScreen("trash");
              },
            },
            e(UiIcon, { name: "trash", size: 18 }),
            "Корзина",
          ),
          e(
            "button",
            { class: "mobile-menu-row", onClick: () => setScreen("stash") },
            e(UiIcon, { name: "file", size: 18 }),
            "Отложенные · " + (state?.stash.length ?? 0),
          ),
          e(
            "button",
            {
              class: "mobile-menu-row",
              onClick: () => {
                setName(state?.deviceName ?? "Устройство");
                setScreen("device");
              },
            },
            e(UiIcon, { name: "devices", size: 18 }),
            state?.deviceName ?? "Устройство",
          ),
          v &&
            !v.deleted &&
            e(
              "div",
              { class: "mobile-vault-menu-section" },
              e("p", { class: "mobile-menu-caption" }, "Хранилище"),
              v.systemUnlock &&
                v.key &&
                e(
                  "button",
                  {
                    class: "mobile-menu-row",
                    disabled: busy,
                    onClick: () =>
                      void run(async () => {
                        await flush();
                        showDraft(null);
                        showViewing(null);
                        await lockVault(user, selected);
                        setStatus("Хранилище заблокировано.");
                      }),
                  },
                  e(UiIcon, { name: "lock", size: 18 }),
                  "Заблокировать сейчас",
                ),
              v.systemUnlock &&
                e(
                  "button",
                  {
                    class: "mobile-menu-row",
                    disabled: busy,
                    onClick: () => {
                      setAutoLockMs(v.systemUnlock!.autoLockMs);
                      setScreen("system-unlock");
                      setPhrase("");
                      setError("");
                    },
                  },
                  e(UiIcon, { name: "settings", size: 18 }),
                  "Настройки разблокировки",
                ),
              v.systemUnlock &&
                e(
                  "button",
                  {
                    class: "mobile-menu-row",
                    disabled: busy,
                    onClick: async () => {
                      if (
                        await appConfirm("Фраза хранилища останется рабочей.", {
                          title:
                            "Забыть системную разблокировку на этом устройстве?",
                          confirmLabel: "Забыть",
                          danger: true,
                        })
                      )
                        void run(async () => {
                          await flush();
                          showDraft(null);
                          showViewing(null);
                          await forgetSystemUnlock(user, selected);
                          setStatus(
                            "Системная разблокировка забыта. Для открытия введите фразу.",
                          );
                        });
                    },
                  },
                  e(UiIcon, { name: "key", size: 18 }),
                  "Забыть системную разблокировку",
                ),
              !v.systemUnlock &&
                v.key &&
                e(
                  "button",
                  {
                    class: "mobile-menu-row",
                    disabled: busy || Boolean(v.transfer),
                    onClick: () => {
                      setAutoLockMs(900_000);
                      setPhrase("");
                      setScreen("system-unlock");
                    },
                  },
                  e(UiIcon, { name: "lock", size: 18 }),
                  "Включить системную разблокировку",
                ),
              e(
                "button",
                {
                  class: "mobile-menu-row",
                  disabled: busy || Boolean(v.transfer) || !v.access,
                  onClick: () => form("close-all", selected),
                },
                e(UiIcon, { name: "devices", size: 18 }),
                "Закрыть на всех устройствах",
              ),
              v.key &&
                e(
                  "button",
                  {
                    class: "mobile-menu-row",
                    disabled: busy || Boolean(v.transfer),
                    onClick: () => void run(() => closeVault(user, selected)),
                  },
                  e(UiIcon, { name: "lock", size: 18 }),
                  "Закрыть хранилище",
                ),
              v.key &&
                e(
                  "button",
                  {
                    class: "mobile-menu-row",
                    disabled: busy || Boolean(v.transfer),
                    onClick: () => form("transfer", selected),
                  },
                  e(UiIcon, { name: "key", size: 18 }),
                  "Забыл фразу · перенести",
                ),
              v.key &&
                e(
                  "button",
                  {
                    class: "mobile-menu-row danger",
                    disabled: busy || Boolean(v.transfer),
                    onClick: async () => {
                      const label = names[selected] || "это хранилище";
                      if (
                        await appConfirm(
                          "Хранилище исчезнет на остальных устройствах после синхронизации. Отменить это действие средствами приложения будет невозможно.",
                          {
                            title:
                              "Удалить «" +
                              label +
                              "» и все его серверные данные?",
                            confirmLabel: "Удалить хранилище",
                            danger: true,
                          },
                        )
                      )
                        void run(async () => {
                          await flush();
                          showDraft(null);
                          showViewing(null);
                          await deleteVault(user, selected);
                          setSelected("");
                          setScreen("choose-vault");
                          setStatus("Хранилище удалено.");
                        });
                    },
                  },
                  e(UiIcon, { name: "trash", size: 18 }),
                  "Удалить хранилище",
                ),
            ),
        ),
      ),
    ),
    e(
      "div",
      { class: "notes-commandbar notes-desktop-controls" },
      e(
        "label",
        { class: "vault-switcher" },
        e("span", null, "Хранилище"),
        e(
          "select",
          {
            value: selected || active[0]?.header.id || "",
            onChange: (ev: Event) =>
              void activateVault((ev.target as HTMLSelectElement).value),
          },
          active.map((v) =>
            e(
              "option",
              { value: v.header.id, key: v.header.id },
              names[v.header.id] || "Хранилище",
            ),
          ),
        ),
      ),
      e(
        "label",
        { class: "search-field" },
        e("span", null, "Поиск"),
        e(
          "span",
          { class: "search-input-wrap" },
          e(UiIcon, { name: "search", size: 18 }),
          e("input", {
            type: "search",
            value: query,
            placeholder: "По всем открытым хранилищам",
            onInput: (ev: Event) =>
              setQuery((ev.target as HTMLInputElement).value),
          }),
        ),
      ),
      normalizedQuery
        ? e(
            "label",
            { class: "sort-control" },
            e("span", null, "Сортировка"),
            e(
              "select",
              {
                value: searchSort,
                onChange: (ev: Event) =>
                  setSearchSort(
                    (ev.target as HTMLSelectElement).value as typeof searchSort,
                  ),
              },
              e("option", { value: "relevance" }, "По релевантности"),
              e("option", { value: "newest" }, "Сначала новые"),
              e("option", { value: "oldest" }, "Сначала старые"),
            ),
          )
        : e(
            "label",
            { class: "sort-control" },
            e("span", null, "Сортировка"),
            e(
              "select",
              {
                value: sort,
                onChange: (ev: Event) =>
                  setSort(
                    (ev.target as HTMLSelectElement).value as typeof sort,
                  ),
              },
              e("option", { value: "newest" }, "Сначала новые"),
              e("option", { value: "oldest" }, "Сначала старые"),
              e("option", { value: "title" }, "По заголовку"),
            ),
          ),
    ),
    state?.sessionReviewRequired &&
      e(
        "div",
        { class: "inline-alert warning session-review-banner", role: "status" },
        e(UiIcon, { name: "warning", size: 18 }),
        e(
          "div",
          null,
          e("strong", null, "Синхронизация приостановлена"),
          e(
            "p",
            null,
            reviewItems.length
              ? `Проверьте локальные изменения: ${reviewItems.length}.`
              : "Проверяем актуальное состояние сервера…",
          ),
        ),
        reviewItems.length > 0 &&
          e(
            "button",
            { class: "primary", onClick: () => setScreen("outbox-review") },
            "Проверить",
          ),
      ),
    e(
      "div",
      { class: "notes-desktop-tool-row" },
      v?.key &&
        e(
          "details",
          {
            class: "notes-filter-menu notes-desktop-filters app-popover",
            open: desktopMenu === "filters",
            onToggle: (event: Event) => {
              const open = (event.currentTarget as HTMLDetailsElement).open;
              setDesktopMenu((current) =>
                open ? "filters" : current === "filters" ? null : current,
              );
            },
          },
          e(
            "summary",
            null,
            e(UiIcon, { name: "search", size: 17 }),
            "Фильтры",
            (quickFilter !== "all" || selectedTags.length > 0) &&
              e(
                "span",
                { class: "filter-count" },
                String((quickFilter !== "all" ? 1 : 0) + selectedTags.length),
              ),
          ),
          e(
            "div",
            { class: "notes-filter-popover" },
            e(
              "fieldset",
              { class: "desktop-filter-group" },
              e("legend", null, "Показывать"),
              (
                [
                  ["all", "Все"],
                  ["pinned", "Закреплённые"],
                  ["untagged", "Без тегов"],
                  ["reminder", "С напоминанием"],
                ] as const
              ).map(([value, label]) =>
                e(
                  "label",
                  { class: "desktop-filter-option", key: value },
                  e("input", {
                    type: "radio",
                    name: "note-filter",
                    checked: quickFilter === value,
                    onChange: () => setQuickFilter(value),
                  }),
                  e("span", null, label),
                ),
              ),
            ),
            e(TagPicker, {
              tags: activeTags(v.header.id),
              selectedIds: selectedTags,
              onChange: setSelectedTags,
              onManage: () => openTagManager("list"),
              mode: "inline",
            }),
          ),
        ),
      e(
        "details",
        {
          class: "notes-secondary-tools notes-desktop-more app-popover",
          open: desktopMenu === "vault",
          onToggle: (event: Event) => {
            const open = (event.currentTarget as HTMLDetailsElement).open;
            setDesktopMenu((current) =>
              open ? "vault" : current === "vault" ? null : current,
            );
          },
        },
        e(
          "summary",
          null,
          e(UiIcon, { name: "more", size: 18 }),
          "Хранилище и дополнительные действия",
        ),
        e(
          "div",
          { class: "planner-tools" },
          e(
            "button",
            { disabled: busy, onClick: () => form("create") },
            e(UiIcon, { name: "plus", size: 17 }),
            "Новое хранилище",
          ),
          e(
            "button",
            {
              disabled: !v?.key,
              onClick: () => {
                setQuery("");
                setSelectedTags([]);
                setScreen("archive");
              },
            },
            e(UiIcon, { name: "archive", size: 17 }),
            "Архив" +
              (v?.key
                ? " · " +
                  heads(v).filter(
                    (r) =>
                      notes[r.id] && statusOf(v, r, notes[r.id]) === "archived",
                  ).length
                : ""),
          ),
          e(
            "button",
            {
              disabled: !v?.key,
              onClick: () => {
                setQuery("");
                setSelectedTags([]);
                setScreen("trash");
              },
            },
            e(UiIcon, { name: "trash", size: 17 }),
            "Корзина" +
              (v?.key
                ? " · " +
                  heads(v).filter(
                    (r) =>
                      notes[r.id] &&
                      statusOf(v, r, notes[r.id]) === "trashed" &&
                      !v.purgePending?.includes(r.objectId),
                  ).length
                : ""),
          ),
          e(
            "button",
            { onClick: () => setScreen("stash") },
            "Отложенные · " + (state?.stash.length ?? 0),
          ),
          e(
            "button",
            {
              onClick: () => {
                setName(state?.deviceName ?? "Устройство");
                setScreen("device");
              },
            },
            e(UiIcon, { name: "devices", size: 17 }),
            state?.deviceName ?? "Устройство",
          ),
          v &&
            !v.deleted &&
            e(
              "div",
              { class: "vault-menu-group" },
              e(
                "p",
                { class: "vault-menu-caption" },
                v.systemUnlock
                  ? "Разблокировка · " +
                      autoLockLabel(v.systemUnlock.autoLockMs)
                  : "Разблокировка не настроена",
              ),
              v.systemUnlock &&
                v.key &&
                e(
                  "button",
                  {
                    disabled: busy,
                    onClick: () =>
                      void run(async () => {
                        await flush();
                        showDraft(null);
                        showViewing(null);
                        await lockVault(user, selected);
                        setStatus("Хранилище заблокировано.");
                      }),
                  },
                  e(UiIcon, { name: "lock", size: 17 }),
                  "Заблокировать сейчас",
                ),
              v.systemUnlock &&
                !v.key &&
                e(
                  "button",
                  {
                    disabled: busy,
                    onClick: () =>
                      void run(async () => {
                        await unlockVaultSystem(user, selected);
                        setStatus(
                          "Хранилище разблокировано системной проверкой.",
                        );
                      }),
                  },
                  e(UiIcon, { name: "key", size: 17 }),
                  "Разблокировать системно",
                ),
              v.systemUnlock &&
                e(
                  "button",
                  {
                    disabled: busy,
                    onClick: () => {
                      setAutoLockMs(v.systemUnlock!.autoLockMs);
                      setScreen("system-unlock");
                      setPhrase("");
                      setError("");
                    },
                  },
                  e(UiIcon, { name: "settings", size: 17 }),
                  "Настройки разблокировки",
                ),
              v.systemUnlock &&
                e(
                  "button",
                  {
                    disabled: busy,
                    onClick: async () => {
                      if (
                        await appConfirm("Фраза хранилища останется рабочей.", {
                          title:
                            "Забыть системную разблокировку на этом устройстве?",
                          confirmLabel: "Забыть",
                          danger: true,
                        })
                      )
                        void run(async () => {
                          await flush();
                          showDraft(null);
                          showViewing(null);
                          await forgetSystemUnlock(user, selected);
                          setStatus(
                            "Системная разблокировка забыта. Для открытия введите фразу.",
                          );
                        });
                    },
                  },
                  e(UiIcon, { name: "key", size: 17 }),
                  "Забыть системную разблокировку",
                ),
              !v.systemUnlock &&
                v.key &&
                e(
                  "button",
                  {
                    disabled: busy || Boolean(v.transfer),
                    onClick: () => {
                      setAutoLockMs(900_000);
                      setPhrase("");
                      setScreen("system-unlock");
                    },
                  },
                  e(UiIcon, { name: "lock", size: 17 }),
                  "Включить системную разблокировку",
                ),
              e(
                "button",
                {
                  disabled: busy || Boolean(v.transfer) || !v.access,
                  onClick: () => form("close-all", selected),
                },
                e(UiIcon, { name: "devices", size: 17 }),
                "Закрыть на всех устройствах",
              ),
              v.key &&
                e(
                  "button",
                  {
                    disabled: busy || Boolean(v.transfer),
                    onClick: () => void run(() => closeVault(user, selected)),
                  },
                  e(UiIcon, { name: "lock", size: 17 }),
                  "Закрыть хранилище",
                ),
              v.key &&
                e(
                  "button",
                  {
                    disabled: busy || Boolean(v.transfer),
                    onClick: () => form("transfer", selected),
                  },
                  e(UiIcon, { name: "key", size: 17 }),
                  "Забыл фразу · перенести",
                ),
              v.key &&
                e(
                  "button",
                  {
                    class: "danger-button",
                    disabled: busy || Boolean(v.transfer),
                    onClick: async () => {
                      const label = names[selected] || "это хранилище";
                      if (
                        await appConfirm(
                          "Хранилище исчезнет на остальных устройствах после синхронизации. Отменить это действие средствами приложения будет невозможно.",
                          {
                            title:
                              "Удалить «" +
                              label +
                              "» и все его серверные данные?",
                            confirmLabel: "Удалить хранилище",
                            danger: true,
                          },
                        )
                      )
                        void run(async () => {
                          await flush();
                          showDraft(null);
                          showViewing(null);
                          await deleteVault(user, selected);
                          setSelected("");
                          setScreen("choose-vault");
                          setStatus("Хранилище удалено.");
                        });
                    },
                  },
                  e(UiIcon, { name: "trash", size: 17 }),
                  "Удалить хранилище",
                ),
              v.syncError &&
                e("p", { class: "error", role: "status" }, v.syncError),
            ),
        ),
      ),
    ),
    state?.stash.length
      ? e(
          "p",
          { class: "auth-notice", role: "status" },
          "Есть заметки, не попавшие в конечное хранилище. Откройте «Отложенные заметки».",
        )
      : null,
    state?.vaults
      .filter((v) => v.deleted && v.records.some((r) => r.pending))
      .map((v) =>
        e(
          "div",
          { class: "auth-notice" },
          e(
            "p",
            null,
            "Удалённое хранилище содержит локальные изменения. Чтобы перенести их в отложенные заметки, откройте его прежней фразой.",
          ),
          e(
            "button",
            { onClick: () => form("open", v.header.id) },
            "Открыть для сохранения заметок",
          ),
          e(
            "button",
            {
              onClick: async () => {
                if (
                  await appConfirm("", {
                    title:
                      "Удалить локальные изменения без возможности восстановления?",
                    confirmLabel: "Удалить",
                    danger: true,
                  })
                )
                  void run(async () => {
                    await edit(user, async (s) => {
                      s.vaults = s.vaults.filter(
                        (x) => x.header.id !== v.header.id,
                      );
                    });
                  });
              },
            },
            "Удалить локальную копию",
          ),
        ),
      ),
    state?.vaults
      .filter((v) => !v.deleted && Boolean(v.purgedObjects?.length))
      .map((v) =>
        e(
          "div",
          { class: "auth-notice", key: "purged-" + v.header.id },
          e(
            "p",
            null,
            "На этом устройстве остались несинхронизированные версии окончательно удалённых заметок из «" +
              (names[v.header.id] || "закрытого хранилища") +
              "». Откройте хранилище прежней фразой, чтобы перенести их в отложенные заметки.",
          ),
          e(
            "button",
            { onClick: () => form("open", v.header.id) },
            "Открыть и сохранить",
          ),
          e(
            "button",
            {
              onClick: async () => {
                if (
                  await appConfirm("", {
                    title:
                      "Удалить эти локальные версии без возможности восстановления?",
                    confirmLabel: "Удалить",
                    danger: true,
                  })
                )
                  void run(() => discardPurgedObjects(user, v.header.id));
              },
            },
            "Удалить локальные версии",
          ),
        ),
      ),
    !active.length &&
      e(
        "div",
        { class: "empty-state" },
        e("h2", null, "Пока нет хранилищ"),
        e("p", null, "Создайте первое хранилище и задайте его фразу."),
      ),
    v &&
      !v.deleted &&
      (!v.key
        ? e(
            "button",
            { class: "primary", onClick: () => void activateVault(selected) },
            "Открыть хранилище",
          )
        : e(
            "div",
            null,
            v.transfer &&
              e(
                "p",
                { class: "auth-notice" },
                "Перенос подготовлен. Подключитесь к сети и завершите синхронизацию. Исходник сохранён до подтверждения.",
              ),
            !heads(v).some(
              (r) =>
                notes[r.id] &&
                entityKind(notes[r.id]) === "note" &&
                statusOf(v, r, notes[r.id]) === "active",
            ) &&
              !normalizedQuery &&
              e(
                "div",
                { class: "empty-state" },
                e("h2", null, "Пока нет заметок"),
                e(
                  "p",
                  null,
                  "Создайте первую заметку или верните заметку из архива.",
                ),
              ),
            heads(v).some(
              (r) =>
                notes[r.id] &&
                entityKind(notes[r.id]) === "note" &&
                statusOf(v, r, notes[r.id]) === "active",
            ) &&
              !visibleItems.length &&
              e(
                "div",
                { class: "empty-state" },
                e("h2", null, "Ничего не найдено"),
                e("p", null, "Измените запрос или сбросьте фильтры."),
                e(
                  "button",
                  {
                    onClick: () => {
                      setQuery("");
                      setSelectedTags([]);
                      setQuickFilter("all");
                    },
                  },
                  "Сбросить фильтры",
                ),
              ),
            [...new Set(heads(v).map((r) => r.objectId))]
              .filter((objectId) => {
                const versions = heads(v).filter(
                  (r) => r.objectId === objectId,
                );
                return (
                  versions.length > 1 &&
                  versions.some(
                    (r) =>
                      notes[r.id] &&
                      entityKind(notes[r.id]) === "note" &&
                      statusOf(v, r, notes[r.id]) === "active",
                  )
                );
              })
              .map((objectId) =>
                e(
                  "button",
                  {
                    disabled: busy || Boolean(v.transfer),
                    onClick: () => {
                      const versions = heads(v)
                        .filter((r) => r.objectId === objectId)
                        .map((r) => r.id);
                      setComparison({
                        objectId,
                        versions,
                        chosen: versions[0],
                      });
                      setScreen("conflict");
                    },
                  },
                  "Сравнить версии: " +
                    (notes[heads(v).find((r) => r.objectId === objectId)!.id]
                      ?.title || "Без заголовка"),
                ),
              ),
            visibleItems.map(({ current, revision: r, note }) => {
              const allChips = tagChips(current.header.id, note!.tagIds),
                chips = allChips.slice(0, 2),
                hiddenTagCount = Math.max(0, allChips.length - chips.length),
                attachments = note!.attachments ?? [],
                coverItem = note!.cover
                  ? attachments.find(
                      (item) => item.id === note!.cover!.attachmentId,
                    )
                  : undefined,
                metadata = [
                  note!.checklist?.length
                    ? note!.checklist.filter((item) => item.done).length +
                      " / " +
                      note!.checklist.length
                    : null,
                  note!.reminder
                    ? new Date(note!.reminder.local + "Z").toLocaleString(
                        "ru-RU",
                        {
                          timeZone: "UTC",
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        },
                      )
                    : null,
                ].filter(Boolean),
                swipeId = current.header.id + "." + r.id,
                canSwipeDelete =
                  !current.transfer &&
                  !current.membershipRevoked &&
                  current.role !== "viewer",
                swipeOffset = noteSwipe?.id === swipeId ? noteSwipe.offset : 0;
              const finishSwipe = () => {
                const offset = noteSwipeOffset.current,
                  width = noteSwipeWidth.current;
                noteSwipeTouchX.current = null;
                if (offset >= Math.max(140, width * 0.55)) {
                  setNoteSwipe({ id: swipeId, offset: width, dragging: false });
                  window.setTimeout(
                    () =>
                      void confirmMainNoteTrash(
                        current,
                        r.objectId,
                        note!.title,
                      ),
                    180,
                  );
                } else if (offset > 46)
                  setNoteSwipe({ id: swipeId, offset: 82, dragging: false });
                else setNoteSwipe(null);
              };
              return e(
                "div",
                {
                  class:
                    "note-list-item main-note-swipe" +
                    (noteSwipe?.id === swipeId && noteSwipe.dragging
                      ? " dragging"
                      : ""),
                  key: swipeId,
                  "data-swipe-id": swipeId,
                  style: { "--swipe-reveal": swipeOffset + "px" },
                },
                canSwipeDelete &&
                  e(
                    "button",
                    {
                      class: "main-note-swipe-action",
                      "aria-label": "Переместить заметку в корзину",
                      onClick: () =>
                        void confirmMainNoteTrash(
                          current,
                          r.objectId,
                          note!.title,
                        ),
                    },
                    e(UiIcon, { name: "trash", size: 21 }),
                  ),
                e(
                  "button",
                  {
                    class:
                      "note-row" +
                      (note!.pinned ? " pinned" : "") +
                      (coverItem ? " has-cover" : ""),
                    disabled: Boolean(current.transfer),
                    style: canSwipeDelete
                      ? { transform: `translateX(-${swipeOffset}px)` }
                      : undefined,
                    onTouchStart: canSwipeDelete
                      ? (event: TouchEvent) => {
                          const element = event.currentTarget as HTMLElement,
                            existing =
                              noteSwipe?.id === swipeId ? noteSwipe.offset : 0;
                          noteSwipeTouchX.current =
                            event.touches[0]?.clientX ?? null;
                          noteSwipeWidth.current =
                            element.getBoundingClientRect().width;
                          noteSwipeStartOffset.current = existing;
                          noteSwipeOffset.current = existing;
                          noteSwipeMoved.current = false;
                          setNoteSwipe({
                            id: swipeId,
                            offset: existing,
                            dragging: true,
                          });
                        }
                      : undefined,
                    onTouchMove: canSwipeDelete
                      ? (event: TouchEvent) => {
                          const start = noteSwipeTouchX.current,
                            currentX = event.touches[0]?.clientX;
                          if (start !== null && currentX !== undefined) {
                            const delta = start - currentX,
                              activation = window.innerWidth * 0.05,
                              distance = Math.abs(delta),
                              drag =
                                distance >= activation
                                  ? Math.sign(delta) * (distance - activation)
                                  : 0,
                              offset = Math.max(
                                0,
                                Math.min(
                                  noteSwipeWidth.current,
                                  noteSwipeStartOffset.current + drag,
                                ),
                              );
                            noteSwipeOffset.current = offset;
                            if (distance >= activation)
                              noteSwipeMoved.current = true;
                            setNoteSwipe({
                              id: swipeId,
                              offset,
                              dragging: true,
                            });
                          }
                        }
                      : undefined,
                    onTouchEnd: canSwipeDelete ? finishSwipe : undefined,
                    onTouchCancel: canSwipeDelete
                      ? () => {
                          noteSwipeTouchX.current = null;
                          noteSwipeOffset.current =
                            noteSwipeStartOffset.current;
                          setNoteSwipe(
                            noteSwipeStartOffset.current
                              ? {
                                  id: swipeId,
                                  offset: noteSwipeStartOffset.current,
                                  dragging: false,
                                }
                              : null,
                          );
                        }
                      : undefined,
                    onClick: () => {
                      if (noteSwipeMoved.current) {
                        noteSwipeMoved.current = false;
                        return;
                      }
                      if (noteSwipe?.id === swipeId && noteSwipe.offset > 0) {
                        setNoteSwipe(null);
                        return;
                      }
                      openRevision(current, r);
                    },
                  },
                  coverItem &&
                    e(
                      "span",
                      { class: "note-list-cover-slot" },
                      e(BlobImage, {
                        key: coverItem.id,
                        cacheKey: current.header.id + "." + coverItem.id,
                        alt: "",
                        className: "note-list-cover",
                        load: () =>
                          attachmentPreviewBlob(
                            user,
                            current.header.id,
                            coverItem,
                          ),
                      }),
                    ),
                  e(
                    "span",
                    { class: "note-row-content" },
                    e(
                      "strong",
                      null,
                      note!.pinned
                        ? "📌 " + (note!.title || "Без заголовка")
                        : note!.title || "Без заголовка",
                    ),
                    normalizedQuery &&
                      e("small", null, names[current.header.id] || "Хранилище"),
                    e(
                      "span",
                      { class: "note-preview" },
                      note!.text.slice(0, 140),
                    ),
                    (chips.length > 0 ||
                      attachments.length > 0 ||
                      metadata.length > 0) &&
                      e(
                        "span",
                        { class: "note-meta-line" },
                        chips.map((tag) =>
                          e(
                            "span",
                            {
                              class: "tag-chip",
                              style: { "--tag-color": tag.color },
                              key: tag.id,
                            },
                            tag.name,
                          ),
                        ),
                        hiddenTagCount > 0 &&
                          e(
                            "span",
                            {
                              class: "tag-overflow-count",
                              "aria-label": "Ещё тегов: " + hiddenTagCount,
                              title: "Ещё тегов: " + hiddenTagCount,
                            },
                            "+" + hiddenTagCount,
                          ),
                        attachments.length > 0 &&
                          e(
                            "span",
                            {
                              class: "note-attachment-count",
                              "aria-label":
                                "Прикреплено файлов: " + attachments.length,
                              title:
                                "Прикреплено файлов: " + attachments.length,
                            },
                            e(UiIcon, { name: "paperclip", size: 14 }),
                            String(attachments.length),
                          ),
                        metadata.map((value, index) =>
                          e(
                            "span",
                            { class: "note-meta", key: "meta-" + index },
                            value,
                          ),
                        ),
                      ),
                    heads(current).filter((x) => x.objectId === r.objectId)
                      .length > 1 &&
                      e("small", null, "Есть другая версия — обе сохранены"),
                  ),
                ),
                e(
                  "button",
                  {
                    class: "row-edit-button",
                    disabled: Boolean(current.transfer),
                    onClick: () => editRevision(current, r),
                    "aria-label":
                      "Редактировать заметку «" +
                      (note!.title || "Без заголовка") +
                      "»",
                  },
                  "Редактировать",
                ),
              );
            }),
            e(
              "button",
              {
                class: "primary note-fab",
                disabled: busy || Boolean(v.transfer),
                "aria-label": "Новая заметка",
                onClick: () => {
                  if (v.key)
                    showDraft({
                      vault: selected,
                      object: crypto.randomUUID(),
                      revision: null,
                      title: "",
                      text: "",
                      dirty: false,
                      key: v.key,
                      editorMode: "create",
                    });
                },
              },
              e(UiIcon, { name: "plus", size: 24 }),
            ),
          )),
    feedback,
  );
}
