import {
  ArrowLeft,
  Brain,
  Check,
  ChevronDown,
  CircleUserRound,
  FileText,
  FolderOpen,
  Image,
  List,
  Lock,
  LogOut,
  Plus,
  ChevronRight,
  Settings,
  Shield,
  SquareTerminal,
  Square,
  Sparkles,
  Target,
  TriangleAlert,
  Trash2
} from 'lucide-react';
import { ChangeEvent, DragEvent, Fragment, FormEvent, KeyboardEvent, MouseEvent, PointerEvent, SyntheticEvent, UIEvent, WheelEvent, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { NapActivityItem, NapAuthState, NapMode, NapWorkspaceChangeSummary, WebviewToExtensionMessage } from '../shared/protocol';
import { getVsCodeApi } from './vscodeApi';
import { initialViewState, napViewReducer } from './state';
import { renderMarkdown } from './markdown';

const approvalModes = ['default', 'bypass'] as const;
type ApprovalMode = typeof approvalModes[number];
type OpenMenu = 'account' | 'add' | 'approval' | 'model' | 'slash' | undefined;
type ActivePage = 'chat' | 'sessions';
type LocalIconName = 'archive' | 'arrowUp' | 'copy' | 'defaultPermissions' | 'diff' | 'drag' | 'edit' | 'fullPermissions' | 'new' | 'settings' | 'settingsCat';
type SlashAction = 'review' | 'goal' | 'mcp' | 'plan' | 'doctor' | 'apply' | 'resume' | 'fork' | 'cloud' | 'search';
type SlashMatch = { query: string; start: number; end: number };
type ReviewSummaryByMessageId = Record<string, NapWorkspaceChangeSummary>;

const slashCommands: Array<{ action: SlashAction; label: string; keywords: string[] }> = [
  { action: 'review', label: 'Review', keywords: ['review', 'changes', 'diff'] },
  { action: 'goal', label: 'Goals', keywords: ['goal', 'goals', 'set goal'] },
  { action: 'mcp', label: 'MCP', keywords: ['mcp', 'server', 'connector'] },
  { action: 'plan', label: 'Plan Mode', keywords: ['plan', 'planning', 'mode'] },
  { action: 'doctor', label: 'Doctor', keywords: ['doctor', 'diagnose', 'debug'] },
  { action: 'apply', label: 'Apply', keywords: ['apply', 'patch', 'diff'] },
  { action: 'resume', label: 'Resume', keywords: ['resume', 'continue', 'session'] },
  { action: 'fork', label: 'Fork', keywords: ['fork', 'branch', 'copy'] },
  { action: 'cloud', label: 'Cloud', keywords: ['cloud', 'tasks', 'remote'] },
  { action: 'search', label: 'Web Search', keywords: ['search', 'web', 'browse'] }
];

const approvalLabels: Record<ApprovalMode, string> = {
  default: 'Default Permissions',
  bypass: 'Full Permissions'
};

const COMPOSER_MIN_HEIGHT = 92;
const COMPOSER_MAX_HEIGHT = 220;
const COMPOSER_SINGLE_LINE_GROW_THRESHOLD = 20;
const SCROLL_LOCK_THRESHOLD = 6;
const PROGRAMMATIC_SCROLL_GRACE_MS = 420;
const SMOOTH_SCROLL_DURATION_MS = 180;
const COMPOSER_TEXT_STOP_OFFSET = 20;

function getActiveSlashMatch(value: string, caretIndex: number): SlashMatch | undefined {
  const tokenStart = Math.max(value.lastIndexOf(' ', caretIndex - 1), value.lastIndexOf('\n', caretIndex - 1), value.lastIndexOf('\t', caretIndex - 1)) + 1;
  const nextSpace = value.slice(caretIndex).search(/\s/);
  const tokenEnd = nextSpace === -1 ? value.length : caretIndex + nextSpace;
  const token = value.slice(tokenStart, tokenEnd);
  if (!token.startsWith('/') || token.includes('/', 1) || caretIndex < tokenStart + 1) {
    return undefined;
  }

  return {
    query: token.slice(1, Math.max(1, caretIndex - tokenStart)).toLowerCase(),
    start: tokenStart,
    end: tokenEnd
  };
}

declare global {
  interface Window {
    __NAP_LOGO_URI__?: string;
    __NAP_ICON_URIS__?: Record<LocalIconName, string>;
  }
}

export function App() {
  const [state, dispatch] = useReducer(napViewReducer, initialViewState);
  const [draft, setDraft] = useState('');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('default');
  const [openMenu, setOpenMenu] = useState<OpenMenu>();
  const [slashQuery, setSlashQuery] = useState('');
  const [slashMatch, setSlashMatch] = useState<SlashMatch>();
  const [showAllModels, setShowAllModels] = useState(false);
  const [activePage, setActivePage] = useState<ActivePage>('chat');
  const [copiedMessageId, setCopiedMessageId] = useState<string>();
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isAuthVerifying, setIsAuthVerifying] = useState(true);
  const [hasSeenAuthLanding, setHasSeenAuthLanding] = useState(() =>
    window.localStorage.getItem('nap.authLandingSeen') === 'true'
  );
  const [draggedQueuedPromptId, setDraggedQueuedPromptId] = useState<string>();
  const [elapsedNow, setElapsedNow] = useState(() => Date.now());
  const [reviewSummariesByMessageId, setReviewSummariesByMessageId] = useState<ReviewSummaryByMessageId>({});
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelineContentEndRef = useRef<HTMLDivElement>(null);
  const composerPanelRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastAnchoredUserMessageId = useRef<string>();
  const lastOpenedSessionId = useRef<string>();
  const reviewSummarySessionId = useRef<string>();
  const isScrollPinnedRef = useRef(true);
  const userScrollIntentRef = useRef(false);
  const ignoreScrollUntilRef = useRef(0);
  const scrollFrameRef = useRef<number>();
  const vscode = useMemo(() => getVsCodeApi(), []);

  const post = useCallback((message: WebviewToExtensionMessage) => {
    vscode.postMessage(message);
  }, [vscode]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type === 'showChat') {
        setActivePage('chat');
      }
      if (event.data?.type === 'sessionState') {
        setIsInitialLoading(false);
        setIsAuthVerifying(event.data.state?.auth?.status === 'unknown');
        const sessionId = event.data.state?.sessionId;
        if (sessionId && sessionId !== reviewSummarySessionId.current) {
          reviewSummarySessionId.current = sessionId;
          setReviewSummariesByMessageId({});
        }
      }
      if (event.data?.type === 'authStateChanged') {
        setIsInitialLoading(false);
        setIsAuthVerifying(event.data.auth?.status === 'unknown');
        if (event.data.auth?.status === 'authenticated') {
          window.localStorage.setItem('nap.authLandingSeen', 'true');
          setHasSeenAuthLanding(true);
        }
      }
      if (event.data?.type === 'error') {
        setIsInitialLoading(false);
        setIsAuthVerifying(false);
      }
      if (event.data?.type === 'workspaceChangesChanged') {
        const messageId = event.data.messageId;
        const workspaceChanges = event.data.workspaceChanges;
        if (workspaceChanges?.filesChanged > 0 && typeof messageId === 'string' && messageId) {
          setReviewSummariesByMessageId(previous => ({
            ...previous,
            [messageId]: cloneWorkspaceChangeSummary(workspaceChanges)
          }));
        }
      }
      dispatch({ type: 'extensionMessage', message: event.data });
    };
    window.addEventListener('message', listener);
    post({ type: 'ready' });
    return () => {
      window.removeEventListener('message', listener);
      if (scrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, [post]);

  const markProgrammaticScroll = useCallback((duration = PROGRAMMATIC_SCROLL_GRACE_MS) => {
    ignoreScrollUntilRef.current = Date.now() + duration;
    userScrollIntentRef.current = false;
  }, []);

  const cancelScrollAnimation = useCallback(() => {
    if (scrollFrameRef.current !== undefined) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = undefined;
    }
  }, []);

  const getTimelineTargetTop = useCallback((element: HTMLElement) => {
    return Math.max(0, element.scrollHeight - element.clientHeight);
  }, []);

  const distanceFromBottom = useCallback((element: HTMLElement) =>
    getTimelineTargetTop(element) - element.scrollTop
  , [getTimelineTargetTop]);

  const isAtBottom = useCallback((element: HTMLElement) =>
    distanceFromBottom(element) <= SCROLL_LOCK_THRESHOLD
  , [distanceFromBottom]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }

    cancelScrollAnimation();

    const getTargetTop = () => {
      const currentTimeline = timelineRef.current;
      if (!currentTimeline) {
        return 0;
      }

      return getTimelineTargetTop(currentTimeline);
    };

    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const startTop = timeline.scrollTop;
    const targetTop = getTargetTop();
    const distance = targetTop - startTop;
    const shouldAnimate = behavior === 'smooth' && !prefersReducedMotion && Math.abs(distance) > 4;

    if (!shouldAnimate) {
      markProgrammaticScroll(PROGRAMMATIC_SCROLL_GRACE_MS);
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        const currentTimeline = timelineRef.current;
        if (!currentTimeline) {
          scrollFrameRef.current = undefined;
          return;
        }

        currentTimeline.scrollTop = getTargetTop();
        scrollFrameRef.current = undefined;
      });
      return;
    }

    markProgrammaticScroll(SMOOTH_SCROLL_DURATION_MS + PROGRAMMATIC_SCROLL_GRACE_MS);
    const startedAt = performance.now();
    const step = (now: number) => {
      const currentTimeline = timelineRef.current;
      if (!currentTimeline || !isScrollPinnedRef.current) {
        scrollFrameRef.current = undefined;
        return;
      }

      const progress = Math.min(1, (now - startedAt) / SMOOTH_SCROLL_DURATION_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      currentTimeline.scrollTop = startTop + distance * eased;

      if (progress < 1) {
        scrollFrameRef.current = window.requestAnimationFrame(step);
        return;
      }

      currentTimeline.scrollTop = getTargetTop();
      scrollFrameRef.current = undefined;
    };
    scrollFrameRef.current = window.requestAnimationFrame(step);
  }, [cancelScrollAnimation, getTimelineTargetTop, markProgrammaticScroll]);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = true;
  }, []);

  const onTimelineScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const timeline = event.currentTarget;
    const atBottom = isAtBottom(timeline);
    if (Date.now() <= ignoreScrollUntilRef.current) {
      if (!atBottom && userScrollIntentRef.current) {
        cancelScrollAnimation();
        isScrollPinnedRef.current = false;
      }
      if (atBottom) {
        isScrollPinnedRef.current = true;
      }
      return;
    }

    const wasPinned = isScrollPinnedRef.current;
    isScrollPinnedRef.current = atBottom;
    userScrollIntentRef.current = !atBottom;
    if (!wasPinned && atBottom) {
      scrollToBottom('smooth');
    }
  }, [cancelScrollAnimation, isAtBottom, scrollToBottom]);

  const onTimelineWheel = useCallback((event: WheelEvent<HTMLElement>) => {
    markUserScrollIntent();
    if (event.deltaY < 0) {
      cancelScrollAnimation();
      isScrollPinnedRef.current = false;
      return;
    }

    window.requestAnimationFrame(() => {
      isScrollPinnedRef.current = isAtBottom(event.currentTarget);
      userScrollIntentRef.current = !isScrollPinnedRef.current;
    });
  }, [isAtBottom, markUserScrollIntent]);

  const onTimelinePointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    markUserScrollIntent();
    cancelScrollAnimation();
    if (!isAtBottom(event.currentTarget)) {
      isScrollPinnedRef.current = false;
    }
  }, [cancelScrollAnimation, isAtBottom, markUserScrollIntent]);

  const onTimelineKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'].includes(event.key)) {
      return;
    }

    markUserScrollIntent();
    if (event.key !== 'End') {
      cancelScrollAnimation();
      isScrollPinnedRef.current = false;
      return;
    }

    window.requestAnimationFrame(() => {
      const timeline = timelineRef.current;
      if (!timeline) {
        return;
      }
      isScrollPinnedRef.current = isAtBottom(timeline);
      userScrollIntentRef.current = !isScrollPinnedRef.current;
    });
  }, [cancelScrollAnimation, isAtBottom, markUserScrollIntent]);

  useEffect(() => {
    if (state.sessionId === 'pending' || state.sessionId === lastOpenedSessionId.current) {
      return;
    }

    lastOpenedSessionId.current = state.sessionId;
    lastAnchoredUserMessageId.current = [...state.messages].reverse().find(message => message.role === 'user')?.id;
    isScrollPinnedRef.current = true;
    userScrollIntentRef.current = false;
    requestAnimationFrame(() => {
      scrollToBottom('auto');
      requestAnimationFrame(() => scrollToBottom('auto'));
    });
  }, [scrollToBottom, state.messages, state.sessionId]);

  useEffect(() => {
    const latestUserMessage = [...state.messages].reverse().find(message => message.role === 'user');
    if (!latestUserMessage || latestUserMessage.id === lastAnchoredUserMessageId.current) {
      return;
    }

    lastAnchoredUserMessageId.current = latestUserMessage.id;
    isScrollPinnedRef.current = true;
    requestAnimationFrame(() => {
      scrollToBottom('smooth');
    });
  }, [scrollToBottom, state.messages]);

  useEffect(() => {
    if (openMenu !== 'model') {
      setShowAllModels(false);
    }

    if (!openMenu) {
      return;
    }

    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (composerPanelRef.current?.contains(target) || target instanceof Element && target.closest('[data-menu-root="true"]')) {
        return;
      }

      setOpenMenu(undefined);
    };

    window.addEventListener('pointerdown', closeOnOutsideClick);
    return () => window.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [openMenu]);

  useLayoutEffect(() => {
    if (!openMenu) {
      return;
    }

    const clampOpenMenu = () => {
      const menu = document.querySelector<HTMLElement>(`.floating-menu[data-menu="${openMenu}"]`);
      if (!menu) {
        return;
      }

      const shell = menu.closest<HTMLElement>('.nap-shell') ?? document.documentElement;
      const dropdown = menu.closest<HTMLElement>('.floating-dropdown');
      const shellRect = shell.getBoundingClientRect();
      const dropdownRect = dropdown?.getBoundingClientRect();
      const shellInset = 4;
      const availableWidth = Math.max(120, shellRect.width - shellInset * 2);
      const availableAbove = dropdownRect
        ? dropdownRect.top - shellRect.top - shellInset
        : shellRect.height - shellInset * 2;

      menu.classList.remove('floating-menu--align-end');
      menu.style.maxWidth = `${availableWidth}px`;
      menu.style.maxHeight = `${Math.max(96, availableAbove)}px`;

      if (openMenu === 'model') {
        return;
      }

      const rect = menu.getBoundingClientRect();
      if (rect.right > shellRect.right - shellInset) {
        menu.classList.add('floating-menu--align-end');
      }
      if (rect.left < shellRect.left + shellInset) {
        menu.classList.remove('floating-menu--align-end');
      }
    };

    const frame = window.requestAnimationFrame(clampOpenMenu);
    window.addEventListener('resize', clampOpenMenu);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', clampOpenMenu);
    };
  }, [openMenu]);

  useEffect(() => {
    const latestStreamingAssistant = [...state.messages].reverse().find(message =>
      message.role === 'assistant' && message.status === 'streaming'
    );
    if (!latestStreamingAssistant) {
      return;
    }

    requestAnimationFrame(() => {
      const timeline = timelineRef.current;
      if (!timeline) {
        return;
      }

      if (isScrollPinnedRef.current) {
        scrollToBottom('auto');
      }
    });
  }, [scrollToBottom, state.activityKind, state.activityText, state.messages, state.status]);

  useLayoutEffect(() => {
    const panel = composerPanelRef.current;
    if (!panel) {
      return;
    }

    const syncComposerSafeArea = () => {
      const nextHeight = panel.getBoundingClientRect().height;
      const safeArea = Math.max(1, Math.ceil(nextHeight + COMPOSER_TEXT_STOP_OFFSET));
      timelineRef.current?.style.setProperty('--composer-safe-area', `${safeArea}px`);
      panel.closest<HTMLElement>('.nap-shell')?.style.setProperty('--composer-safe-area', `${safeArea}px`);
      return nextHeight;
    };

    let previousHeight = syncComposerSafeArea();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(entries => {
      const nextHeight = entries[0]?.contentRect.height ?? panel.getBoundingClientRect().height;
      const safeArea = Math.max(1, Math.ceil(nextHeight + COMPOSER_TEXT_STOP_OFFSET));
      timelineRef.current?.style.setProperty('--composer-safe-area', `${safeArea}px`);
      panel.closest<HTMLElement>('.nap-shell')?.style.setProperty('--composer-safe-area', `${safeArea}px`);
      if (Math.abs(nextHeight - previousHeight) < 0.5) {
        return;
      }

      previousHeight = nextHeight;
      if (isScrollPinnedRef.current) {
        scrollToBottom('auto');
      }
    });

    observer.observe(panel);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  const resizeComposer = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = 'auto';
    const measuredHeight = textarea.scrollHeight;
    const isSingleLine = !textarea.value.includes('\n');
    const shouldStayAtBaseHeight = isSingleLine && measuredHeight <= COMPOSER_MIN_HEIGHT + COMPOSER_SINGLE_LINE_GROW_THRESHOLD;
    const nextHeight = shouldStayAtBaseHeight
      ? COMPOSER_MIN_HEIGHT
      : Math.min(Math.max(measuredHeight, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = measuredHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeComposer();
  }, [draft, resizeComposer]);

  const latestStreamingAssistant = useMemo(() => [...state.messages].reverse().find(message =>
    message.role === 'assistant' && message.status === 'streaming'
  ), [state.messages]);
  const isStreaming = state.status === 'streaming';
  const modelOptions = (state.models.length > 0
    ? state.models
    : [{ id: state.modelId, label: state.modelId, description: 'Current model' }]
  ).filter(model => model.id !== 'auto');
  const visibleModelOptions = showAllModels ? modelOptions : modelOptions.slice(0, 4);
  const hasMoreModels = modelOptions.length > visibleModelOptions.length;
  const selectedModel = modelOptions.find(model => model.id === state.modelId) ?? modelOptions[0];
  const isAuthenticated = state.auth.status === 'authenticated';
  const sessions = state.sessions;
  const waitingText = state.activityText ?? (isStreaming && !latestStreamingAssistant?.content ? 'Thinking' : undefined);
  const waitingKind = state.activityKind ?? 'thinking';
  const activityItems = state.activityItems ?? [];
  const queuedPrompts = state.queuedPrompts ?? [];
  const hasDraft = draft.trim().length > 0;
  const showStopButton = isStreaming && !hasDraft;
  const showComposer = isAuthenticated && (activePage === 'chat' || activePage === 'sessions');

  const stopGeneration = useCallback(() => {
    if (!isStreaming) {
      return;
    }

    post({ type: 'stopGeneration' });
  }, [isStreaming, post]);

  const clearActiveMode = useCallback(() => {
    post({ type: 'setMode', mode: 'chat' });
    setOpenMenu(undefined);
  }, [post]);

  useEffect(() => {
    if (!latestStreamingAssistant) {
      return;
    }

    setElapsedNow(Date.now());
    const interval = window.setInterval(() => setElapsedNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [latestStreamingAssistant?.id]);

  const expandModelMenu = useCallback(() => {
    const menu = document.querySelector<HTMLElement>('.floating-menu[data-menu="model"]');
    if (menu) {
      const rect = menu.getBoundingClientRect();
      menu.classList.add('model-menu--expanding');
      menu.style.width = `${rect.width}px`;
      menu.style.height = `${rect.height}px`;
    }

    setShowAllModels(true);

    window.requestAnimationFrame(() => {
      const expandedMenu = document.querySelector<HTMLElement>('.floating-menu[data-menu="model"]');
      if (!expandedMenu) {
        return;
      }

      const maxHeight = Number.parseFloat(expandedMenu.style.maxHeight);
      const targetHeight = Number.isFinite(maxHeight)
        ? Math.min(expandedMenu.scrollHeight, maxHeight)
        : expandedMenu.scrollHeight;
      expandedMenu.style.height = `${targetHeight}px`;

      window.setTimeout(() => {
        expandedMenu.classList.remove('model-menu--expanding');
        expandedMenu.style.height = '';
      }, 210);
    });
  }, []);

  const seedComposerText = useCallback((text: string) => {
    setDraft(previous => previous.trim() ? `${previous.trimEnd()}\n${text}` : text);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const chooseAddAction = useCallback((action: 'files' | 'plan' | 'goal' | 'image') => {
    if (action === 'plan') {
      post({ type: 'setMode', mode: 'plan' });
    } else if (action === 'goal') {
      seedComposerText('Goal: ');
    } else if (action === 'files') {
      seedComposerText('Add files and folders: ');
    } else {
      seedComposerText('Add image: ');
    }
    setOpenMenu(undefined);
  }, [post, seedComposerText]);

  const syncSlashMenu = useCallback((value: string, caretIndex: number | null) => {
    const match = caretIndex === null ? undefined : getActiveSlashMatch(value, caretIndex);
    if (!match) {
      setSlashQuery('');
      setSlashMatch(undefined);
      setOpenMenu(current => current === 'slash' ? undefined : current);
      return;
    }

    setSlashQuery(match.query);
    setSlashMatch(match);
    setOpenMenu('slash');
  }, []);

  const removeActiveSlashCommand = useCallback(() => {
    setDraft(current => {
      if (!slashMatch) {
        return current;
      }

      const next = `${current.slice(0, slashMatch.start)}${current.slice(slashMatch.end)}`;
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(slashMatch.start, slashMatch.start);
      });
      return next;
    });
    setSlashQuery('');
    setSlashMatch(undefined);
  }, [slashMatch]);

  const chooseSlashAction = useCallback((action: SlashAction) => {
    removeActiveSlashCommand();
    if (action === 'review') {
      post({ type: 'reviewChanges' });
    } else if (action === 'plan') {
      post({ type: 'setMode', mode: 'plan' });
    } else if (action === 'goal') {
      seedComposerText('Goal: ');
    } else if (action === 'mcp') {
      seedComposerText('MCP: ');
    } else if (action === 'doctor') {
      seedComposerText('Run doctor and diagnose this workspace.');
    } else if (action === 'apply') {
      seedComposerText('Apply the latest Nap diff to the workspace.');
    } else if (action === 'resume') {
      seedComposerText('Resume the previous Nap session.');
    } else if (action === 'fork') {
      seedComposerText('Fork the previous Nap session.');
    } else if (action === 'cloud') {
      seedComposerText('Show Nap Cloud tasks for this workspace.');
    } else if (action === 'search') {
      seedComposerText('Use web search: ');
    }
    setOpenMenu(undefined);
  }, [post, removeActiveSlashCommand, seedComposerText]);

  useEffect(() => {
    const focusComposerOnTyping = (event: globalThis.KeyboardEvent) => {
      if (
        activePage !== 'chat' ||
        openMenu ||
        event.defaultPrevented ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key.length !== 1 ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      event.preventDefault();
      setDraft(current => `${current}${event.key}`);
      requestAnimationFrame(() => textareaRef.current?.focus());
    };

    window.addEventListener('keydown', focusComposerOnTyping);
    return () => window.removeEventListener('keydown', focusComposerOnTyping);
  }, [activePage, openMenu]);

  useEffect(() => {
    const stopOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isStreaming) {
        return;
      }

      event.preventDefault();
      stopGeneration();
    };

    window.addEventListener('keydown', stopOnEscape);
    return () => window.removeEventListener('keydown', stopOnEscape);
  }, [isStreaming, stopGeneration]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt) {
      return;
    }
    if (activePage === 'sessions') {
      setActivePage('chat');
      post({ type: 'newSessionWithPrompt', prompt });
    } else {
      post({ type: 'sendPrompt', prompt });
    }
    setDraft('');
    setOpenMenu(undefined);
  };

  const onComposerChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setDraft(value);
    syncSlashMenu(value, event.target.selectionStart);
  };

  const onComposerSelectionChange = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget;
    syncSlashMenu(target.value, target.selectionStart);
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && isStreaming) {
      event.preventDefault();
      stopGeneration();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const onTimelineClick = useCallback((event: MouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const link = target.closest<HTMLAnchorElement>('a[data-nap-file]');
    const filePath = link?.dataset.napFile;
    if (!filePath) {
      return;
    }

    event.preventDefault();
    post({ type: 'openFile', filePath });
  }, [post]);

  const copyResponse = useCallback((messageId: string, content: string) => {
    void navigator.clipboard?.writeText(content).then(() => {
      setCopiedMessageId(messageId);
      window.setTimeout(() => {
        setCopiedMessageId(current => current === messageId ? undefined : current);
      }, 1000);
    });
  }, []);

  const openSessionsPage = useCallback(() => {
    post({ type: 'refreshSessions' });
    setActivePage('sessions');
  }, [post]);

  const startNewChat = useCallback(() => {
    setActivePage('chat');
    post({ type: 'newSession' });
  }, [post]);

  const editQueuedPrompt = useCallback((item: { id: string; prompt: string }) => {
    post({ type: 'deleteQueuedPrompt', promptId: item.id });
    setDraft(item.prompt);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [post]);

  const onQueueDragStart = useCallback((event: DragEvent<HTMLElement>, promptId: string) => {
    setDraggedQueuedPromptId(promptId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', promptId);
  }, []);

  const onQueueDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onQueueDrop = useCallback((event: DragEvent<HTMLElement>, targetPromptId: string) => {
    event.preventDefault();
    const promptId = event.dataTransfer.getData('text/plain') || draggedQueuedPromptId;
    setDraggedQueuedPromptId(undefined);
    if (!promptId || promptId === targetPromptId) {
      return;
    }
    post({ type: 'reorderQueuedPrompt', promptId, targetPromptId });
  }, [draggedQueuedPromptId, post]);

  const startAuthLogin = useCallback(() => {
    window.localStorage.setItem('nap.authLandingSeen', 'true');
    setHasSeenAuthLanding(true);
    setIsAuthVerifying(true);
    post({ type: 'authLogin' });
  }, [post]);

  const openDocs = useCallback(() => {
    post({ type: 'openExternal', url: 'https://www.nap-code.com/docs' });
  }, [post]);

  const showLoadingOverlay = isInitialLoading || isAuthVerifying;
  const loadingLabel = isInitialLoading ? 'Loading Nap' : 'Verifying auth';
  const showAuthLanding = activePage === 'chat'
    && !showLoadingOverlay
    && state.auth.status === 'signedOut'
    && !hasSeenAuthLanding;
  const showAuthLoading = activePage === 'chat'
    && !showAuthLanding
    && !isAuthenticated;

  return (
    <div className="nap-shell">
      {showLoadingOverlay || showAuthLoading ? (
        <div className="loading-overlay" role="status" aria-live="polite" aria-label={loadingLabel}>
          <div className="loading-spinner" aria-hidden="true" />
          {isInitialLoading ? <span>{loadingLabel}</span> : null}
        </div>
      ) : null}
      {showAuthLanding ? (
        <main className="auth-landing" aria-label="Nap sign in">
          <section className="auth-landing-content">
            {window.__NAP_LOGO_URI__ ? (
              <span
                className="auth-landing-logo"
                role="img"
                aria-label="Nap"
                style={{ WebkitMaskImage: `url("${window.__NAP_LOGO_URI__}")`, maskImage: `url("${window.__NAP_LOGO_URI__}")` }}
              />
            ) : null}
            <div className="auth-landing-copy">
              <h1>Nap in your environment</h1>
              <p>Nap can index codebase, edit code, run commands, review changes and fix vulnerabilities.</p>
            </div>
            <div className="auth-landing-actions">
              <button type="button" className="auth-landing-button auth-landing-button--secondary" onClick={openDocs}>
                <FileText size={14} aria-hidden="true" />
                <span>Docs</span>
              </button>
              <button type="button" className="auth-landing-button auth-landing-button--primary" onClick={startAuthLogin}>
                <Lock size={14} aria-hidden="true" />
                <span>Login</span>
              </button>
            </div>
          </section>
        </main>
      ) : null}
      {activePage === 'sessions' ? (
        <section className="sessions-page" aria-label="Nap sessions">
          {window.__NAP_LOGO_URI__ ? (
            <span
              className="sessions-page-logo"
              aria-hidden="true"
              style={{ WebkitMaskImage: `url("${window.__NAP_LOGO_URI__}")`, maskImage: `url("${window.__NAP_LOGO_URI__}")` }}
            />
          ) : null}
          <header className="app-page-header app-page-header--sessions">
            <span>Sessions</span>
            <div className="header-actions" aria-label="Nap session actions">
              <button type="button" title="Sessions" aria-label="Sessions" onClick={openSessionsPage}>
                <LocalIcon name="archive" />
              </button>
              <HeaderSettingsDropdown
                auth={state.auth}
                open={openMenu === 'account'}
                onToggle={() => setOpenMenu(openMenu === 'account' ? undefined : 'account')}
                onOpenSettings={() => {
                  setOpenMenu(undefined);
                  post({ type: 'openSettings' });
                }}
                onLogout={() => {
                  setOpenMenu(undefined);
                  window.localStorage.removeItem('nap.authLandingSeen');
                  setHasSeenAuthLanding(false);
                  post({ type: 'authLogout' });
                }}
              />
              <button type="button" title="New chat" aria-label="New chat" onClick={startNewChat}>
                <LocalIcon name="new" />
              </button>
            </div>
          </header>
          <div className="sessions-list">
            {sessions.length === 0 ? (
              <div className="sessions-empty" aria-hidden="true" />
            ) : sessions.map(session => (
              <div key={session.id} className="session-item">
                <button
                  type="button"
                  className="session-item-main"
                  onClick={() => {
                    if (session.id !== state.sessionId) {
                      post({ type: 'openSession', sessionId: session.id });
                    }
                    setActivePage('chat');
                  }}
                >
                  <span className="session-title">{session.title}</span>
                  <span className="session-time">{formatRelativeTime(session.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  className="session-delete-button"
                  title="Delete session"
                  aria-label={`Delete ${session.title}`}
                  onClick={() => post({ type: 'deleteSession', sessionId: session.id })}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {activePage === 'chat' && isAuthenticated ? (
        <header className="app-page-header">
          <button type="button" className="header-nav-button" title="Sessions" aria-label="Sessions" onClick={openSessionsPage}>
            <ArrowLeft size={14} strokeWidth={1.8} />
          </button>
          <span>{state.title || 'New Chat'}</span>
          <div className="header-actions" aria-label="Nap chat actions">
            <button type="button" title="Sessions" aria-label="Sessions" onClick={openSessionsPage}>
              <LocalIcon name="archive" />
            </button>
            <HeaderSettingsDropdown
              auth={state.auth}
              open={openMenu === 'account'}
              onToggle={() => setOpenMenu(openMenu === 'account' ? undefined : 'account')}
              onOpenSettings={() => {
                setOpenMenu(undefined);
                post({ type: 'openSettings' });
              }}
              onLogout={() => {
                setOpenMenu(undefined);
                window.localStorage.removeItem('nap.authLandingSeen');
                setHasSeenAuthLanding(false);
                post({ type: 'authLogout' });
              }}
            />
            <button type="button" title="New chat" aria-label="New chat" onClick={startNewChat}>
              <LocalIcon name="new" />
            </button>
          </div>
        </header>
      ) : null}

      {activePage === 'chat' && isAuthenticated ? (
        <main
          className="timeline"
          ref={timelineRef}
          aria-label="Nap conversation"
          onClick={onTimelineClick}
          onScroll={onTimelineScroll}
          onWheel={onTimelineWheel}
          onPointerDown={onTimelinePointerDown}
          onKeyDown={onTimelineKeyDown}
          onTouchStart={markUserScrollIntent}
          onTouchMove={markUserScrollIntent}
          tabIndex={0}
        >
        {state.messages.length === 0 ? (
          <div className="empty-state">
            {window.__NAP_LOGO_URI__ ? (
              <span
                className="empty-state-logo"
                role="img"
                aria-label="Nap"
                style={{ WebkitMaskImage: `url("${window.__NAP_LOGO_URI__}")`, maskImage: `url("${window.__NAP_LOGO_URI__}")` }}
              />
            ) : null}
          </div>
        ) : state.messages.map((message, index) => {
          const messageReviewSummary = message.workspaceChanges ?? reviewSummariesByMessageId[message.id];
          const responseCompletedAt = message.completedAt ?? message.createdAt;
          const pairedAssistant = message.role === 'user'
            ? state.messages.slice(index + 1).find(item => item.role === 'assistant')
            : undefined;
          const turnTiming = pairedAssistant?.status === 'streaming'
            ? `Working for ${formatElapsedTime(elapsedNow - pairedAssistant.createdAt)}`
            : pairedAssistant?.completedAt
              ? `Worked for ${formatElapsedTime(pairedAssistant.completedAt - pairedAssistant.createdAt)}`
              : undefined;
          const showTurnDivider = message.role === 'user' && (index > 0 || !!turnTiming);
          return (
            <Fragment key={message.id}>
              {showTurnDivider ? <TurnDivider label={turnTiming} /> : null}
              <article className={`message message--${message.role}`} data-message-id={message.id}>
                <div className="message-body">
                  {message.role === 'assistant' ? (
                    <>
                      {message.content ? (
                        <AssistantContent content={message.content} compactFinal={message.status === 'complete'} />
                      ) : null}
                      {message.status === 'streaming' && waitingText ? (
                        <ActivityLine kind={waitingKind} text={waitingText} />
                      ) : null}
                    </>
                  ) : message.content}
                </div>
                {message.role === 'assistant' && message.content && message.status !== 'streaming' ? (
                  <div className="response-meta">
                    <div className="response-actions" aria-label="Response actions">
                      <button type="button" title="Copy response" aria-label="Copy response" onClick={() => copyResponse(message.id, getCopyableAssistantContent(message.content, message.status))}>
                        {copiedMessageId === message.id ? <Check size={14} /> : <LocalIcon name="copy" />}
                      </button>
                      <time className="response-time" dateTime={new Date(responseCompletedAt).toISOString()}>
                        {formatClockTime(responseCompletedAt)}
                      </time>
                    </div>
                  </div>
                ) : null}
                {message.role === 'assistant' && messageReviewSummary?.filesChanged > 0 ? (
                  <ChangeSummaryBar
                    summary={messageReviewSummary}
                    onReview={() => post({ type: 'reviewChanges', messageId: message.id })}
                    onReviewFile={filePath => post({ type: 'reviewFileChanges', filePath, messageId: message.id })}
                  />
                ) : null}
              </article>
            </Fragment>
          );
        })}
        {state.messages.length > 0 ? <div ref={timelineContentEndRef} className="timeline-content-end" aria-hidden="true" /> : null}
        </main>
      ) : null}

      {showComposer ? <div className="composer-bottom-fill" aria-hidden="true" /> : null}

      {showComposer ? (
        <footer className="composer-panel" ref={composerPanelRef}>
          {queuedPrompts.length > 0 ? (
            <section className="prompt-queue" aria-label="Queued prompts">
              {queuedPrompts.map(item => (
                <div
                  key={item.id}
                  className={`prompt-queue-item${draggedQueuedPromptId === item.id ? ' is-dragging' : ''}`}
                  draggable
                  onDragStart={event => onQueueDragStart(event, item.id)}
                  onDragEnd={() => setDraggedQueuedPromptId(undefined)}
                  onDragOver={onQueueDragOver}
                  onDrop={event => onQueueDrop(event, item.id)}
                >
                  <button
                    type="button"
                    className="prompt-queue-action prompt-queue-drag"
                    title="Drag queued prompt"
                    aria-label="Drag queued prompt"
                    tabIndex={-1}
                  >
                    <LocalIcon name="drag" />
                  </button>
                  <span className="prompt-queue-text">{item.prompt}</span>
                  <button
                    type="button"
                    className="prompt-queue-action prompt-queue-delete"
                    title="Remove queued prompt"
                    aria-label="Remove queued prompt"
                    onClick={() => post({ type: 'deleteQueuedPrompt', promptId: item.id })}
                  >
                    <Trash2 size={11} />
                  </button>
                  <button
                    type="button"
                    className="prompt-queue-action prompt-queue-edit"
                    title="Edit queued prompt"
                    aria-label="Edit queued prompt"
                    onClick={() => editQueuedPrompt(item)}
                  >
                    <LocalIcon name="edit" />
                  </button>
                </div>
              ))}
            </section>
          ) : null}
          {openMenu === 'add' || openMenu === 'slash' ? (
            <div className="composer-overlay" aria-live="polite">
              {openMenu === 'add' ? (
                <ComposerAddPanel
                  onChooseAdd={chooseAddAction}
                />
              ) : null}
              {openMenu === 'slash' ? (
                <ComposerSlashPanel
                  query={slashQuery}
                  onChooseAction={chooseSlashAction}
                />
              ) : null}
            </div>
          ) : null}
        <form className="composer" onSubmit={onSubmit}>
          <div className="composer-input">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={onComposerChange}
              onSelect={onComposerSelectionChange}
              onClick={onComposerSelectionChange}
              onKeyUp={onComposerSelectionChange}
              onKeyDown={onComposerKeyDown}
              placeholder="Describe what you want to build"
              rows={2}
              aria-label="Message Nap"
              disabled={!isAuthenticated}
            />
            <div className="composer-actions">
              <div className="floating-dropdown model-dropdown">
                <button type="button" className="floating-select model-select" aria-label="Model" aria-expanded={openMenu === 'model'} onClick={() => setOpenMenu(openMenu === 'model' ? undefined : 'model')}>
                  <span>{selectedModel?.label ?? state.modelId}</span>
                  <ChevronDown className="model-chevron" size={13} strokeWidth={1.7} aria-hidden="true" />
                </button>
                {openMenu === 'model' ? (
                  <div className={`floating-menu model-menu${showAllModels ? ' model-menu--expanded' : ''}`} role="menu" data-menu="model">
                    {visibleModelOptions.map(model => (
                      <button
                        key={model.id}
                        type="button"
                        className="floating-menu-item"
                        role="menuitemradio"
                        aria-checked={state.modelId === model.id}
                        onClick={() => {
                          post({ type: 'setModel', modelId: model.id });
                          setOpenMenu(undefined);
                        }}
                      >
                        <span>{model.label}</span>
                        {state.modelId === model.id ? <Check size={12} /> : null}
                      </button>
                    ))}
                    {hasMoreModels ? (
                      <button
                        type="button"
                        className="floating-menu-item floating-menu-item--more"
                        role="menuitem"
                        aria-expanded={showAllModels}
                        onClick={expandModelMenu}
                      >
                        <span>More</span>
                        <ChevronRight size={12} strokeWidth={1.8} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {showStopButton ? (
                <button className="send-button send-button--stop" type="button" title="Stop" aria-label="Stop" onClick={stopGeneration}>
                  <Square size={10} />
                </button>
              ) : (
                <button className="send-button" type="submit" title={isAuthenticated ? 'Send' : 'Sign in required'} aria-label="Send" disabled={!hasDraft || !isAuthenticated}>
                  <LocalIcon name="arrowUp" className="send-icon" />
                </button>
              )}
            </div>
            <div className="composer-left-actions">
              <button className="composer-plus-button" type="button" title="Add context" aria-label="Add context" aria-expanded={openMenu === 'add'} onClick={() => setOpenMenu(openMenu === 'add' ? undefined : 'add')}>
                <Plus size={18} strokeWidth={1.9} />
              </button>
              <div className="floating-dropdown permissions-dropdown">
                <button type="button" className={`floating-select permissions-select permissions-select--${approvalMode}`} aria-label="Permissions" aria-expanded={openMenu === 'approval'} onClick={() => setOpenMenu(openMenu === 'approval' ? undefined : 'approval')}>
                  <LocalIcon name={approvalMode === 'bypass' ? 'fullPermissions' : 'defaultPermissions'} />
                  <ChevronDown className="model-chevron" size={13} strokeWidth={1.7} aria-hidden="true" />
                </button>
                {openMenu === 'approval' ? (
                  <div className="floating-menu permissions-menu" role="menu" data-menu="approval">
                    {approvalModes.map(mode => (
                      <button key={mode} type="button" className={`floating-menu-item permissions-menu-item permissions-menu-item--${mode}`} role="menuitemradio" aria-label={approvalLabels[mode]} title={approvalLabels[mode]} aria-checked={approvalMode === mode} onClick={() => { setApprovalMode(mode); setOpenMenu(undefined); }}>
                        <LocalIcon name={mode === 'bypass' ? 'fullPermissions' : 'defaultPermissions'} />
                        <span>{approvalLabels[mode]}</span>
                        {approvalMode === mode ? <Check size={12} /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {state.mode !== 'chat' ? (
                <button
                  type="button"
                  className={`active-mode-button active-mode-button--${state.mode}`}
                  title={`${modeLabel(state.mode)} active. Click to turn off.`}
                  aria-label={`${modeLabel(state.mode)} active. Turn off mode.`}
                  onClick={clearActiveMode}
                >
                  <ModeIcon mode={state.mode} />
                </button>
              ) : null}
            </div>
          </div>
        </form>
        </footer>
      ) : null}
    </div>
  );
}

function LocalIcon({ name, className }: { name: LocalIconName; className?: string }) {
  const uri = window.__NAP_ICON_URIS__?.[name];
  if (!uri) {
    return null;
  }
  return (
    <span
      className={`local-icon local-icon--${name}${className ? ` ${className}` : ''}`}
      style={{ WebkitMaskImage: `url("${uri}")`, maskImage: `url("${uri}")` }}
      aria-hidden="true"
    />
  );
}

type AssistantContentSegment =
  | { type: 'markdown'; content: string }
  | { type: 'activity'; item: NapActivityItem };

function AssistantContent({ content, compactFinal }: { content: string; compactFinal?: boolean }) {
  const segments = useMemo(() => parseAssistantContentSegments(content, Boolean(compactFinal)), [compactFinal, content]);
  return (
    <div className="assistant-content">
      {segments.map((segment, index) => segment.type === 'activity' ? (
        <div key={`activity-${segment.item.id}-${index}`} className="inline-activity">
          <ActivityTrailItem item={segment.item} />
        </div>
      ) : segment.content.trim() ? (
        <div key={`markdown-${index}`} className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(segment.content) }} />
      ) : null)}
    </div>
  );
}

function ActivityTrail({ items }: { items: NapActivityItem[] }) {
  return (
    <div className="activity-trail" aria-label="Nap activity">
      {items.map(item => (
        <ActivityTrailItem key={item.id} item={item} />
      ))}
    </div>
  );
}

function ActivityTrailItem({ item }: { item: NapActivityItem }) {
  const { kind, text } = item;
  const Icon = activityKindIcon(kind);
  const parts = splitActivityParagraphs(formatActivityText(kind, text));
  const isAction = item.verb && !['think', 'write', 'status'].includes(item.verb);
  if (isAction) {
    return (
      <div className={`activity-trail-item activity-trail-item--action activity-trail-item--${kind}`}>
        <Icon size={13} aria-hidden="true" />
        <span className="activity-action-copy">
          <span>{item.title ?? formatActivityText(kind, text)}</span>
          <ActivityStats item={item} />
        </span>
      </div>
    );
  }

  return (
    <div className={`activity-trail-item activity-trail-item--${kind}`}>
      <Icon size={11} aria-hidden="true" />
      <span className="activity-text-stack">
        {parts.map((part, index) => (
          <span key={`${part}-${index}`}>{part}</span>
        ))}
      </span>
    </div>
  );
}

function EditedFilesSummary({ items }: { items: NapActivityItem[] }) {
  return (
    <div className="edited-files-summary" aria-label="Edited files">
      <div className="edited-files-heading">Edited {items.length} {items.length === 1 ? 'file' : 'files'}</div>
      {items.map(item => (
        <div key={item.id} className="edited-file-row">
          <span>{item.filePath ? fileName(item.filePath) : item.title ?? 'File'}</span>
          <ActivityStats item={item} />
        </div>
      ))}
    </div>
  );
}

function ActivityStats({ item }: { item: NapActivityItem }) {
  if (item.additions === undefined && item.deletions === undefined) {
    return null;
  }
  return (
    <span className="activity-stats">
      <span className="activity-stat-add">+{item.additions ?? 0}</span>
      <span className="activity-stat-del">-{item.deletions ?? 0}</span>
    </span>
  );
}

function ChangeSummaryBar({
  summary,
  onReview,
  onReviewFile
}: {
  summary: NapWorkspaceChangeSummary;
  onReview(): void;
  onReviewFile(filePath: string): void;
}) {
  const files = summary.files ?? [];
  const [expanded, setExpanded] = useState(false);
  const canExpand = files.length > 0;
  const singleFileName = files.length === 1 ? fileName(files[0].filePath) : undefined;
  const title = singleFileName ? `Edited ${singleFileName}` : `Edited ${summary.filesChanged} ${summary.filesChanged === 1 ? 'File' : 'Files'}`;
  return (
    <section className={`change-summary-bar${expanded ? ' is-expanded' : ''}`} aria-label="Changed files summary">
      <div className="change-summary-main">
        <span className="change-summary-icon">
          <LocalIcon name="diff" />
        </span>
        <button
          type="button"
          className="change-summary-title"
          aria-label={expanded ? 'Hide changed files' : 'Show changed files'}
          aria-expanded={expanded}
          disabled={!canExpand}
          onClick={() => setExpanded(current => !current)}
        >
          {canExpand ? <ChevronRight size={12.5} aria-hidden="true" /> : null}
          <span>{title}</span>
        </button>
        <div className="change-summary-actions">
          <span className="change-summary-stats" aria-label={`${summary.additions} additions and ${summary.deletions} deletions`}>
            <span className="change-summary-add">+{summary.additions}</span>
            <span className="change-summary-del">-{summary.deletions}</span>
          </span>
          <button type="button" className="change-summary-review" onClick={onReview}>
            Review
          </button>
        </div>
      </div>
      <div className="change-summary-file-reveal" aria-hidden={!expanded}>
        <div className="change-summary-file-list" aria-label="Changed files">
          {files.map(file => (
            <button key={file.filePath} type="button" className="change-summary-file" tabIndex={expanded ? 0 : -1} onClick={() => onReviewFile(file.filePath)}>
              <FileText size={12} aria-hidden="true" />
              <span>{file.filePath}</span>
              <span className="change-summary-file-stats">
                <span className="change-summary-add">+{file.additions}</span>
                <span className="change-summary-del">-{file.deletions}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function HeaderSettingsDropdown({
  auth,
  open,
  onToggle,
  onOpenSettings,
  onLogout
}: {
  auth: NapAuthState;
  open: boolean;
  onToggle(): void;
  onOpenSettings(): void;
  onLogout(): void;
}) {
  const email = auth.accountEmail ?? auth.accountName ?? auth.label;
  return (
    <div className="floating-dropdown header-settings-dropdown" data-menu-root="true">
      <button type="button" title="Settings" aria-label="Settings" aria-expanded={open} onClick={onToggle}>
        <LocalIcon name="settings" />
      </button>
      {open ? (
        <div className="account-menu" role="menu" data-menu="account">
          <div className="account-menu-email" aria-disabled="true">
            <CircleUserRound size={12} aria-hidden="true" />
            <span>{email}</span>
          </div>
          <button type="button" className="account-menu-item" role="menuitem" onClick={onOpenSettings}>
            <LocalIcon name="settingsCat" />
            <span>Nap Settings</span>
          </button>
          <button type="button" className="account-menu-item account-menu-item--logout" role="menuitem" onClick={onLogout}>
            <LogOut size={13} aria-hidden="true" />
            <span>Log out</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ComposerAddPanel({
  onChooseAdd
}: {
  onChooseAdd(action: 'files' | 'plan' | 'goal' | 'image'): void;
}) {
  return (
    <section className="composer-panel-menu add-panel" aria-label="Add context" data-menu="add">
      <div className="composer-panel-section" role="group" aria-label="Add">
        <div className="composer-panel-heading">Add</div>
        <button type="button" className="composer-panel-item" onClick={() => onChooseAdd('files')}>
          <FolderOpen size={14} aria-hidden="true" />
          <span>Files and folders</span>
        </button>
        <button type="button" className="composer-panel-item" onClick={() => onChooseAdd('plan')}>
          <List size={14} aria-hidden="true" />
          <span>Plan Mode</span>
        </button>
        <button type="button" className="composer-panel-item" onClick={() => onChooseAdd('goal')}>
          <Target size={14} aria-hidden="true" />
          <span>Set Goal</span>
        </button>
        <button type="button" className="composer-panel-item" onClick={() => onChooseAdd('image')}>
          <Image size={14} aria-hidden="true" />
          <span>Add Image</span>
        </button>
      </div>
    </section>
  );
}

function ComposerSlashPanel({
  query,
  onChooseAction
}: {
  query: string;
  onChooseAction(action: SlashAction): void;
}) {
  const visibleCommands = slashCommands.filter(command => {
    if (!query) {
      return true;
    }

    const normalizedLabel = command.label.toLowerCase().replace(/\s+/g, '');
    return normalizedLabel.includes(query)
      || command.action.includes(query)
      || command.keywords.some(keyword => keyword.replace(/\s+/g, '').includes(query));
  });

  return (
    <section className="composer-panel-menu slash-panel" aria-label="Nap slash commands" data-menu="slash">
      <div className="composer-panel-section" role="group" aria-label="Commands">
        <div className="composer-panel-heading">Commands</div>
        {visibleCommands.length > 0 ? visibleCommands.map(command => (
          <button key={command.action} type="button" className="composer-panel-item" onClick={() => onChooseAction(command.action)}>
            <SlashCommandIcon action={command.action} />
            <span>{command.label}</span>
          </button>
        )) : (
          <div className="composer-panel-empty">No matching commands</div>
        )}
      </div>
    </section>
  );
}

function SlashCommandIcon({ action }: { action: SlashAction }) {
  if (action === 'review') {
    return <FileText size={14} aria-hidden="true" />;
  }
  if (action === 'goal') {
    return <Target size={14} aria-hidden="true" />;
  }
  if (action === 'mcp') {
    return <SquareTerminal size={14} aria-hidden="true" />;
  }
  if (action === 'plan') {
    return <List size={14} aria-hidden="true" />;
  }
  if (action === 'doctor') {
    return <Brain size={14} aria-hidden="true" />;
  }
  if (action === 'apply') {
    return <LocalIcon name="copy" />;
  }
  if (action === 'fork') {
    return <Settings size={14} aria-hidden="true" />;
  }
  if (action === 'cloud') {
    return <Lock size={14} aria-hidden="true" />;
  }

  return <Sparkles size={14} aria-hidden="true" />;
}

function modeLabel(mode: NapMode) {
  if (mode === 'plan') {
    return 'Plan Mode';
  }
  if (mode === 'debug') {
    return 'Debug Mode';
  }
  if (mode === 'security') {
    return 'Security Mode';
  }

  return 'Chat Mode';
}

function ModeIcon({ mode }: { mode: NapMode }) {
  if (mode === 'plan') {
    return <List size={13} aria-hidden="true" />;
  }
  if (mode === 'debug') {
    return <Brain size={13} aria-hidden="true" />;
  }
  if (mode === 'security') {
    return <Shield size={13} aria-hidden="true" />;
  }

  return <Sparkles size={13} aria-hidden="true" />;
}

function TurnDivider({ label }: { label?: string }) {
  return (
    <div className={`turn-divider${label ? ' turn-divider--active' : ''}`} aria-label={label ?? 'Conversation divider'}>
      {label ? <span>{label}</span> : <span aria-hidden="true" />}
    </div>
  );
}

function ActivityLine({ kind, text }: { kind: string; text: string }) {
  const Icon = activityKindIcon(kind);
  const parts = splitActivityParagraphs(text);
  return (
    <span className={`activity-line activity-line--${kind}`} title={activityKindLabel(kind)}>
      <Icon size={13} aria-hidden="true" />
      <span className="activity-text-stack">
        {parts.map((part, index) => (
          <span key={`${part}-${index}`}>{part}</span>
        ))}
      </span>
    </span>
  );
}

function parseAssistantContentSegments(content: string, compactFinal = false): AssistantContentSegment[] {
  const markerPattern = createNapActivityMarkerPattern();
  if (compactFinal) {
    const finalContent = getFinalAssistantContent(content, markerPattern);
    return [{ type: 'markdown', content: finalContent }];
  }

  const segments: AssistantContentSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = markerPattern.exec(content)) !== null) {
    const markdownContent = content.slice(lastIndex, match.index);
    if (markdownContent) {
      segments.push({ type: 'markdown', content: markdownContent });
    }

    const item = decodeInlineActivity(match[1]);
    if (item) {
      segments.push({ type: 'activity', item });
    }
    lastIndex = markerPattern.lastIndex;
  }

  const remainder = content.slice(lastIndex);
  if (remainder) {
    segments.push({ type: 'markdown', content: remainder });
  }
  return segments.length > 0 ? segments : [{ type: 'markdown', content }];
}

function getCopyableAssistantContent(content: string, status: string): string {
  return status === 'complete'
    ? getFinalAssistantContent(content, createNapActivityMarkerPattern())
    : content.replace(createNapActivityMarkerPattern(), '\n').trim();
}

function createNapActivityMarkerPattern(): RegExp {
  return /(?:^|\n):::nap-activity[ \t]+([A-Za-z0-9+/_=-]+)(?:\r?\n:::)?[ \t]*(?:\r?\n)?/g;
}

function getFinalAssistantContent(content: string, markerPattern: RegExp): string {
  let lastMarkerEnd = -1;
  let match: RegExpExecArray | null;
  markerPattern.lastIndex = 0;
  while ((match = markerPattern.exec(content)) !== null) {
    lastMarkerEnd = markerPattern.lastIndex;
  }
  markerPattern.lastIndex = 0;

  if (lastMarkerEnd > -1) {
    const finalText = content.slice(lastMarkerEnd).trim();
    if (finalText) {
      return trimLeadingProgressParagraphs(finalText);
    }
  }

  return content.replace(markerPattern, '\n').trim();
}

function trimLeadingProgressParagraphs(content: string): string {
  const paragraphs = content.split(/\n{2,}/);
  let firstImportant = 0;
  while (firstImportant < paragraphs.length - 1 && isProgressParagraph(paragraphs[firstImportant])) {
    firstImportant += 1;
  }
  return paragraphs.slice(firstImportant).join('\n\n').trim();
}

function isProgressParagraph(paragraph: string): boolean {
  const text = paragraph.trim();
  return /^(i('|’)m|i('|’)ll|i have|i’ve|next i('|’)m|now i('|’)m|checking|reading|running|editing|searching)\b/i.test(text);
}

function decodeInlineActivity(encoded: string): NapActivityItem | undefined {
  try {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const item = JSON.parse(decoded) as Partial<NapActivityItem>;
    if (!item.kind || !item.text) {
      return undefined;
    }
    return {
      id: item.id ?? `inline-activity-${encoded.slice(0, 10)}`,
      text: item.text,
      kind: item.kind,
      createdAt: item.createdAt ?? Date.now(),
      verb: item.verb,
      filePath: item.filePath,
      title: item.title,
      detail: item.detail,
      additions: item.additions,
      deletions: item.deletions
    };
  } catch {
    return undefined;
  }
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function cloneWorkspaceChangeSummary(summary: NapWorkspaceChangeSummary): NapWorkspaceChangeSummary {
  return {
    ...summary,
    files: summary.files?.map(file => ({ ...file }))
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(target.closest('input, textarea, select, button, [contenteditable="true"], [role="textbox"]'));
}

function formatActivityText(kind: string, text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) {
    return kind === 'file' ? 'Editing file' : activityKindLabel(kind);
  }
  if (kind === 'file' && !/file|edit|read|write|patch|update/i.test(clean)) {
    return `Editing file ${clean}`;
  }
  return clean;
}

function splitActivityParagraphs(text: string): string[] {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\s*\n+\s*/g, '\n')
    .trim();
  if (!normalized) {
    return [];
  }

  const explicit = normalized
    .split(/\n+/)
    .map(part => part.trim())
    .filter(Boolean);
  if (explicit.length > 1) {
    return explicit;
  }

  const compact = normalized.replace(/\s+/g, ' ');
  const pieces = compact.match(/[^.!?]+(?:[.!?]+|$)/g)
    ?.map(part => part.trim())
    .filter(Boolean) ?? [compact];

  const merged: string[] = [];
  for (const piece of pieces) {
    const previous = merged[merged.length - 1];
    if (!previous || previous.length > 56 || piece.length > 90) {
      merged.push(piece);
    } else {
      merged[merged.length - 1] = `${previous} ${piece}`;
    }
  }

  return merged;
}

function activityKindIcon(kind: string) {
  switch (kind) {
    case 'reasoning':
    case 'thinking':
      return Brain;
    case 'plan':
      return List;
    case 'tool':
      return Settings;
    case 'command':
      return SquareTerminal;
    case 'file':
      return FileText;
    case 'warning':
    case 'error':
      return TriangleAlert;
    case 'writing':
      return Sparkles;
    case 'status':
    default:
      return Sparkles;
  }
}

function activityKindLabel(kind: string): string {
  switch (kind) {
    case 'reasoning':
      return 'Reasoning';
    case 'plan':
      return 'Plan';
    case 'tool':
      return 'Tool';
    case 'command':
      return 'Command';
    case 'file':
      return 'Files';
    case 'warning':
      return 'Warning';
    case 'error':
      return 'Error';
    case 'writing':
      return 'Writing';
    case 'status':
      return 'Status';
    default:
      return 'Thinking';
  }
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return 'now';
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  return `${Math.floor(hours / 24)}d`;
}

function formatElapsedTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function formatClockTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(timestamp);
}
