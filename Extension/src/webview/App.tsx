import {
  ArrowUp,
  Check,
  ChevronLeft,
  Cloud,
  Copy,
  Laptop,
  List,
  Lock,
  Mic,
  Plus,
  Settings,
  Shield,
  SquareTerminal,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2
} from 'lucide-react';
import { FormEvent, KeyboardEvent, MouseEvent, PointerEvent, UIEvent, WheelEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { WebviewToExtensionMessage } from '../shared/protocol';
import { getVsCodeApi } from './vscodeApi';
import { initialViewState, napViewReducer } from './state';
import { renderMarkdown } from './markdown';

const runtimeTargets = ['local', 'cli', 'cloud'] as const;
type RuntimeTarget = typeof runtimeTargets[number];

const approvalModes = ['default', 'bypass'] as const;
type ApprovalMode = typeof approvalModes[number];
type OpenMenu = 'runtime' | 'approval' | 'model' | undefined;
type ResponseVote = 'up' | 'down';
type ActivePage = 'chat' | 'sessions';

const runtimeLabels: Record<RuntimeTarget, string> = {
  local: 'Local',
  cli: 'Nap CLI',
  cloud: 'Cloud'
};

const approvalLabels: Record<ApprovalMode, string> = {
  default: 'Default approval',
  bypass: 'Bypass approval'
};

const COMPOSER_MIN_HEIGHT = 92;
const COMPOSER_MAX_HEIGHT = 220;
const SCROLL_BOTTOM_THRESHOLD = 96;
const PROGRAMMATIC_SCROLL_GRACE_MS = 220;
const BOOT_SPLASH_MIN_MS = 2000;
const BOOT_SPLASH_FALLBACK_MS = 3500;

declare global {
  interface Window {
    __NAP_LOGO_URI__?: string;
  }
}

export function App() {
  const [state, dispatch] = useReducer(napViewReducer, initialViewState);
  const [draft, setDraft] = useState('');
  const [runtimeTarget, setRuntimeTarget] = useState<RuntimeTarget>('local');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('default');
  const [openMenu, setOpenMenu] = useState<OpenMenu>();
  const [activePage, setActivePage] = useState<ActivePage>('chat');
  const [isBootSplashVisible, setIsBootSplashVisible] = useState(true);
  const [copiedMessageId, setCopiedMessageId] = useState<string>();
  const [responseVotes, setResponseVotes] = useState<Record<string, ResponseVote>>({});
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerPanelRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastAnchoredUserMessageId = useRef<string>();
  const isScrollPinnedRef = useRef(true);
  const userScrollIntentRef = useRef(false);
  const ignoreScrollUntilRef = useRef(0);
  const bootMinElapsedRef = useRef(false);
  const bootDataReadyRef = useRef(false);
  const vscode = useMemo(() => getVsCodeApi(), []);

  const post = useCallback((message: WebviewToExtensionMessage) => {
    vscode.postMessage(message);
  }, [vscode]);

  useEffect(() => {
    const maybeHideBootSplash = () => {
      if (bootMinElapsedRef.current && bootDataReadyRef.current) {
        setIsBootSplashVisible(false);
      }
    };

    const minTimer = window.setTimeout(() => {
      bootMinElapsedRef.current = true;
      maybeHideBootSplash();
    }, BOOT_SPLASH_MIN_MS);
    const fallbackTimer = window.setTimeout(() => {
      bootDataReadyRef.current = true;
      maybeHideBootSplash();
    }, BOOT_SPLASH_FALLBACK_MS);

    const listener = (event: MessageEvent) => {
      if (event.data?.type === 'sessionState') {
        bootDataReadyRef.current = true;
        maybeHideBootSplash();
      }
      dispatch({ type: 'extensionMessage', message: event.data });
    };
    window.addEventListener('message', listener);
    post({ type: 'ready' });
    return () => {
      window.clearTimeout(minTimer);
      window.clearTimeout(fallbackTimer);
      window.removeEventListener('message', listener);
    };
  }, [post]);

  const markProgrammaticScroll = useCallback(() => {
    ignoreScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
    userScrollIntentRef.current = false;
  }, []);

  const distanceFromBottom = useCallback((element: HTMLElement) =>
    element.scrollHeight - element.scrollTop - element.clientHeight
  , []);

  const isNearBottom = useCallback((element: HTMLElement) =>
    distanceFromBottom(element) <= SCROLL_BOTTOM_THRESHOLD
  , [distanceFromBottom]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }

    markProgrammaticScroll();
    timeline.scrollTo({
      top: timeline.scrollHeight,
      behavior
    });
  }, [markProgrammaticScroll]);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = true;
  }, []);

  const onTimelineScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const timeline = event.currentTarget;
    const nearBottom = isNearBottom(timeline);
    if (nearBottom) {
      isScrollPinnedRef.current = true;
      userScrollIntentRef.current = false;
      return;
    }

    if (userScrollIntentRef.current && Date.now() > ignoreScrollUntilRef.current) {
      isScrollPinnedRef.current = false;
    }
  }, [isNearBottom]);

  const onTimelineWheel = useCallback((event: WheelEvent<HTMLElement>) => {
    markUserScrollIntent();
    if (event.deltaY < 0) {
      isScrollPinnedRef.current = false;
    }
  }, [markUserScrollIntent]);

  const onTimelinePointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.currentTarget === event.target) {
      markUserScrollIntent();
    }
  }, [markUserScrollIntent]);

  useEffect(() => {
    const latestUserMessage = [...state.messages].reverse().find(message => message.role === 'user');
    if (!latestUserMessage || latestUserMessage.id === lastAnchoredUserMessageId.current) {
      return;
    }

    lastAnchoredUserMessageId.current = latestUserMessage.id;
    isScrollPinnedRef.current = true;
    requestAnimationFrame(() => {
      const timeline = timelineRef.current;
      const userMessage = timeline?.querySelector<HTMLElement>(`[data-message-id="${latestUserMessage.id}"]`);
      if (!timeline || !userMessage) {
        return;
      }

      markProgrammaticScroll();
      timeline.scrollTo({
        top: userMessage.offsetTop - timeline.clientTop - (timeline.clientHeight * 0.25),
        behavior: 'smooth'
      });
    });
  }, [markProgrammaticScroll, state.messages]);

  useEffect(() => {
    if (!openMenu) {
      return;
    }

    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || composerPanelRef.current?.contains(target)) {
        return;
      }

      setOpenMenu(undefined);
    };

    window.addEventListener('pointerdown', closeOnOutsideClick);
    return () => window.removeEventListener('pointerdown', closeOnOutsideClick);
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

      if (isScrollPinnedRef.current || isNearBottom(timeline)) {
        isScrollPinnedRef.current = true;
        scrollToBottom(latestStreamingAssistant.content ? 'auto' : 'smooth');
      }
    });
  }, [isNearBottom, scrollToBottom, state.messages]);

  const resizeComposer = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = 'auto';
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeComposer();
  }, [draft, resizeComposer]);

  const isStreaming = state.status === 'streaming';
  const latestLog = state.logs[state.logs.length - 1];
  const modelOptions = state.models.length > 0
    ? state.models
    : [{ id: state.modelId, label: state.modelId, description: 'Current model' }];
  const selectedModel = modelOptions.find(model => model.id === state.modelId) ?? modelOptions[0];
  const isAuthenticated = state.auth.status === 'authenticated';
  const sessions = state.sessions;
  const waitingText = state.activityText;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || isStreaming) {
      return;
    }
    post({ type: 'sendPrompt', prompt });
    setDraft('');
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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

  const RuntimeIcon = getRuntimeIcon(runtimeTarget);
  const openSessionsPage = useCallback(() => {
    post({ type: 'refreshSessions' });
    setActivePage('sessions');
  }, [post]);

  return (
    <div className="nap-shell">
      {isBootSplashVisible ? (
        <div className="boot-splash" aria-label="Loading Nap">
          {window.__NAP_LOGO_URI__ ? (
            <img className="boot-splash-logo" src={window.__NAP_LOGO_URI__} alt="" aria-hidden="true" />
          ) : null}
          <span className="boot-splash-text">Loading Nap</span>
        </div>
      ) : null}

      {activePage === 'sessions' ? (
        <section className="sessions-page" aria-label="Nap sessions">
          <header className="app-page-header">
            <button type="button" className="header-nav-button" title="Back to chat" aria-label="Back to chat" onClick={() => setActivePage('chat')}>
              <ChevronLeft size={13} />
            </button>
            <span>Sessions</span>
            <div className="header-actions" aria-label="Nap session actions">
              <button type="button" title="Sessions" aria-label="Sessions" onClick={openSessionsPage}>
                <List size={14} />
              </button>
              <button type="button" title="Settings" aria-label="Settings" onClick={() => post({ type: 'openSettings' })}>
                <Settings size={14} />
              </button>
              <button type="button" title="New chat" aria-label="New chat" onClick={() => post({ type: 'newSession' })}>
                <Plus size={14} />
              </button>
            </div>
          </header>
          <div className="sessions-list">
            {sessions.length === 0 ? (
              <div className="sessions-empty">
                <span>No daemon sessions yet</span>
              </div>
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

      {activePage === 'chat' ? (
        <header className="app-page-header">
          <button type="button" className="header-nav-button" title="Sessions" aria-label="Sessions" onClick={openSessionsPage}>
            <ChevronLeft size={13} />
          </button>
          <span>{state.title || 'New Chat'}</span>
          <div className="header-actions" aria-label="Nap chat actions">
            <button type="button" title="Sessions" aria-label="Sessions" onClick={openSessionsPage}>
              <List size={14} />
            </button>
            <button type="button" title="Settings" aria-label="Settings" onClick={() => post({ type: 'openSettings' })}>
              <Settings size={14} />
            </button>
            <button type="button" title="New chat" aria-label="New chat" onClick={() => post({ type: 'newSession' })}>
              <Plus size={14} />
            </button>
          </div>
        </header>
      ) : null}

      {activePage === 'chat' ? (
        <main
          className="timeline"
          ref={timelineRef}
          aria-label="Nap conversation"
          onClick={onTimelineClick}
          onScroll={onTimelineScroll}
          onWheel={onTimelineWheel}
          onPointerDown={onTimelinePointerDown}
          onTouchMove={markUserScrollIntent}
        >
        {state.messages.length === 0 ? (
          <div className="empty-state">
            {window.__NAP_LOGO_URI__ ? (
              <img className="empty-state-logo" src={window.__NAP_LOGO_URI__} alt="Nap" />
            ) : null}
            {isAuthenticated ? (
              <p>Start a Nap Chat below</p>
            ) : (
              <div className="auth-gate">
                <Lock size={16} />
                <p>Sign in to start Nap Chat</p>
                <button type="button" onClick={() => post({ type: 'authLogin' })}>
                  Sign in with Nap CLI
                </button>
              </div>
            )}
          </div>
        ) : state.messages.map(message => (
          <article key={message.id} className={`message message--${message.role}`} data-message-id={message.id}>
            <div className="message-body">
              {message.role === 'assistant' ? (
                <>
                  {message.content ? (
                    <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
                  ) : null}
                  {message.status === 'streaming' && waitingText ? (
                    <span className="waiting-text">{waitingText}</span>
                  ) : !message.content ? (
                    <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown('...') }} />
                  ) : null}
                </>
              ) : message.content || '...'}
            </div>
            {message.role === 'assistant' && message.content && message.status !== 'streaming' ? (
              <div className="response-actions" aria-label="Response actions">
                <button type="button" title="Copy response" aria-label="Copy response" onClick={() => copyResponse(message.id, message.content)}>
                  {copiedMessageId === message.id ? <Check size={14} /> : <Copy size={14} />}
                </button>
                <button
                  type="button"
                  className={responseVotes[message.id] === 'up' ? 'is-selected' : undefined}
                  title="Good response"
                  aria-label="Good response"
                  aria-pressed={responseVotes[message.id] === 'up'}
                  onClick={() => setResponseVotes(votes => ({ ...votes, [message.id]: 'up' }))}
                >
                  <ThumbsUp size={14} />
                </button>
                <button
                  type="button"
                  className={responseVotes[message.id] === 'down' ? 'is-selected' : undefined}
                  title="Bad response"
                  aria-label="Bad response"
                  aria-pressed={responseVotes[message.id] === 'down'}
                  onClick={() => setResponseVotes(votes => ({ ...votes, [message.id]: 'down' }))}
                >
                  <ThumbsDown size={14} />
                </button>
              </div>
            ) : null}
          </article>
        ))}
        {state.messages.length > 0 ? <div className="timeline-anchor-spacer" aria-hidden="true" /> : null}
        </main>
      ) : null}

      {activePage === 'chat' ? (
        <section className="log-strip" aria-label="Nap log">
        <span className={`log-dot log-dot--${latestLog?.level ?? 'trace'}`} />
        <span className="log-text">{latestLog ? latestLog.message : 'Session idle'}</span>
        </section>
      ) : null}

      {activePage === 'chat' ? (
        <footer className="composer-panel" ref={composerPanelRef}>
        <form className="composer" onSubmit={onSubmit}>
          <div className="composer-input">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={event => setDraft(event.target.value)}
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
                </button>
                {openMenu === 'model' ? (
                  <div className="floating-menu model-menu" role="menu">
                    {modelOptions.map(model => (
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
                  </div>
                ) : null}
              </div>
              <button className="mic-button" type="button" title="Voice input" aria-label="Voice input">
                <Mic size={13} />
              </button>
              {isStreaming ? (
                <button className="send-button send-button--stop" type="button" title="Stop" aria-label="Stop" onClick={() => post({ type: 'stopGeneration' })}>
                  <Square size={13} />
                </button>
              ) : (
                <button className="send-button" type="submit" title={isAuthenticated ? 'Send' : 'Sign in required'} aria-label="Send" disabled={!draft.trim() || !isAuthenticated}>
                  <ArrowUp size={15} />
                </button>
              )}
            </div>
          </div>
        </form>

        <div className="composer-options" aria-label="Nap run options">
          {!isAuthenticated ? (
            <button type="button" className="auth-inline-button" onClick={() => post({ type: 'authLogin' })}>
              <Lock size={12} />
              <span>Auth</span>
            </button>
          ) : null}
          <div className="floating-dropdown">
            <button type="button" className="floating-select" aria-label="Runtime target" aria-expanded={openMenu === 'runtime'} onClick={() => setOpenMenu(openMenu === 'runtime' ? undefined : 'runtime')}>
              <RuntimeIcon size={13} />
              <span>{runtimeLabels[runtimeTarget]}</span>
            </button>
            {openMenu === 'runtime' ? (
              <div className="floating-menu" role="menu">
                {runtimeTargets.map(target => {
                  const Icon = getRuntimeIcon(target);
                  const isLocked = target === 'cloud';
                  return (
                    <button
                      key={target}
                      type="button"
                      className="floating-menu-item"
                      role="menuitemradio"
                      aria-checked={runtimeTarget === target}
                      disabled={isLocked}
                      title={isLocked ? 'Cloud is locked for now' : undefined}
                      onClick={() => {
                        if (isLocked) {
                          return;
                        }
                        setRuntimeTarget(target);
                        setOpenMenu(undefined);
                      }}
                    >
                      <Icon size={13} />
                      <span>{runtimeLabels[target]}</span>
                      {isLocked ? <Lock size={11} /> : runtimeTarget === target ? <Check size={12} /> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          <div className="floating-dropdown">
            <button type="button" className="floating-select" aria-label="Approval mode" aria-expanded={openMenu === 'approval'} onClick={() => setOpenMenu(openMenu === 'approval' ? undefined : 'approval')}>
              <Shield size={13} />
              <span>{approvalLabels[approvalMode]}</span>
            </button>
            {openMenu === 'approval' ? (
              <div className="floating-menu" role="menu">
                {approvalModes.map(mode => (
                  <button key={mode} type="button" className="floating-menu-item" role="menuitemradio" aria-checked={approvalMode === mode} onClick={() => { setApprovalMode(mode); setOpenMenu(undefined); }}>
                    <Shield size={13} />
                    <span>{approvalLabels[mode]}</span>
                    {approvalMode === mode ? <Check size={12} /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        </footer>
      ) : null}
    </div>
  );
}

function getRuntimeIcon(target: RuntimeTarget) {
  if (target === 'cloud') {
    return Cloud;
  }
  if (target === 'cli') {
    return SquareTerminal;
  }
  return Laptop;
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
