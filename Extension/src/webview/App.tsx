import {
  ArrowLeft,
  ArrowUp,
  Brain,
  Check,
  Cloud,
  Copy,
  FileText,
  Laptop,
  List,
  Lock,
  Plus,
  Settings,
  Shield,
  SquareTerminal,
  Square,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  Trash2
} from 'lucide-react';
import { Fragment, FormEvent, KeyboardEvent, MouseEvent, PointerEvent, UIEvent, WheelEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { NapActivityItem, WebviewToExtensionMessage } from '../shared/protocol';
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
const SCROLL_BOTTOM_THRESHOLD = 80;
const SCROLL_LOCK_THRESHOLD = 2;
const PROGRAMMATIC_SCROLL_GRACE_MS = 260;
const LIVE_SCROLL_BOTTOM_PADDING = 18;

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
  const [copiedMessageId, setCopiedMessageId] = useState<string>();
  const [responseVotes, setResponseVotes] = useState<Record<string, ResponseVote>>({});
  const [elapsedNow, setElapsedNow] = useState(() => Date.now());
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelineContentEndRef = useRef<HTMLDivElement>(null);
  const composerPanelRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastAnchoredUserMessageId = useRef<string>();
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

  const markProgrammaticScroll = useCallback(() => {
    ignoreScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
    userScrollIntentRef.current = false;
  }, []);

  const distanceFromBottom = useCallback((element: HTMLElement) =>
    element.scrollHeight - element.scrollTop - element.clientHeight
  , []);

  const distanceFromLiveBottom = useCallback((element: HTMLElement) => {
    const contentEnd = timelineContentEndRef.current;
    if (!contentEnd) {
      return distanceFromBottom(element);
    }
    return contentEnd.offsetTop - element.scrollTop - element.clientHeight + LIVE_SCROLL_BOTTOM_PADDING;
  }, [distanceFromBottom]);

  const isNearBottom = useCallback((element: HTMLElement) =>
    distanceFromLiveBottom(element) <= SCROLL_BOTTOM_THRESHOLD
  , [distanceFromLiveBottom]);

  const isAtBottom = useCallback((element: HTMLElement) =>
    distanceFromLiveBottom(element) <= SCROLL_LOCK_THRESHOLD
  , [distanceFromLiveBottom]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }

    markProgrammaticScroll();
    if (scrollFrameRef.current !== undefined) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }

    const applyScroll = (nextBehavior: ScrollBehavior) => {
      const currentTimeline = timelineRef.current;
      if (!currentTimeline) {
        return;
      }

      const contentEnd = timelineContentEndRef.current;
      const targetTop = contentEnd
        ? contentEnd.offsetTop - currentTimeline.clientHeight + LIVE_SCROLL_BOTTOM_PADDING
        : currentTimeline.scrollHeight;
      currentTimeline.scrollTo({
        top: Math.max(0, targetTop),
        behavior: nextBehavior
      });
    };

    scrollFrameRef.current = window.requestAnimationFrame(() => {
      applyScroll(behavior);
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        if (isScrollPinnedRef.current) {
          markProgrammaticScroll();
          applyScroll('auto');
        }
        scrollFrameRef.current = undefined;
      });
    });
  }, [markProgrammaticScroll]);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = true;
  }, []);

  const onTimelineScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const timeline = event.currentTarget;
    const atBottom = isAtBottom(timeline);
    if (Date.now() <= ignoreScrollUntilRef.current) {
      isScrollPinnedRef.current = atBottom || isScrollPinnedRef.current;
      return;
    }

    if (atBottom) {
      isScrollPinnedRef.current = true;
      userScrollIntentRef.current = false;
      return;
    }

    if (userScrollIntentRef.current && Date.now() > ignoreScrollUntilRef.current) {
      isScrollPinnedRef.current = false;
    }
  }, [isAtBottom]);

  const onTimelineWheel = useCallback((event: WheelEvent<HTMLElement>) => {
    markUserScrollIntent();
    if (event.deltaY < 0 || !isAtBottom(event.currentTarget)) {
      isScrollPinnedRef.current = false;
    }
  }, [isAtBottom, markUserScrollIntent]);

  const onTimelinePointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    markUserScrollIntent();
    if (!isAtBottom(event.currentTarget)) {
      isScrollPinnedRef.current = false;
    }
  }, [isAtBottom, markUserScrollIntent]);

  const onTimelineKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'].includes(event.key)) {
      return;
    }

    markUserScrollIntent();
    if (event.key !== 'End') {
      isScrollPinnedRef.current = false;
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
      scrollToBottom('smooth');
    });
  }, [scrollToBottom, state.messages]);

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

      if (isScrollPinnedRef.current || (!userScrollIntentRef.current && isNearBottom(timeline))) {
        isScrollPinnedRef.current = true;
        scrollToBottom('smooth');
      }
    });
  }, [isNearBottom, scrollToBottom, state.activityKind, state.activityText, state.messages, state.status]);

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

  const latestStreamingAssistant = useMemo(() => [...state.messages].reverse().find(message =>
    message.role === 'assistant' && message.status === 'streaming'
  ), [state.messages]);
  const latestStreamingAssistantIndex = latestStreamingAssistant
    ? state.messages.findIndex(message => message.id === latestStreamingAssistant.id)
    : -1;
  const activeTurnUserMessageId = latestStreamingAssistantIndex > -1
    ? [...state.messages.slice(0, latestStreamingAssistantIndex)].reverse().find(message => message.role === 'user')?.id
    : undefined;
  const activeTurnElapsedLabel = latestStreamingAssistant
    ? `Working for ${formatElapsedTime(elapsedNow - latestStreamingAssistant.createdAt)}`
    : undefined;
  const isStreaming = state.status === 'streaming';
  const latestLog = state.logs[state.logs.length - 1];
  const modelOptions = state.models.length > 0
    ? state.models
    : [{ id: state.modelId, label: state.modelId, description: 'Current model' }];
  const selectedModel = modelOptions.find(model => model.id === state.modelId) ?? modelOptions[0];
  const isAuthenticated = state.auth.status === 'authenticated';
  const sessions = state.sessions;
  const waitingText = state.activityText;
  const waitingKind = state.activityKind ?? 'thinking';
  const activityItems = state.activityItems ?? [];
  const latestAssistantMessageId = [...state.messages].reverse().find(message => message.role === 'assistant')?.id;
  const editedActivityItems = getEditedActivityItems(activityItems);

  useEffect(() => {
    if (!latestStreamingAssistant) {
      return;
    }

    setElapsedNow(Date.now());
    const interval = window.setInterval(() => setElapsedNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [latestStreamingAssistant?.id]);

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
      {activePage === 'sessions' ? (
        <section className="sessions-page" aria-label="Nap sessions">
          <header className="app-page-header app-page-header--sessions">
            <span>Sessions</span>
            <div className="header-actions" aria-label="Nap session actions">
              <button type="button" title="Sessions" aria-label="Sessions" onClick={openSessionsPage}>
                <List size={16} />
              </button>
              <button type="button" title="Settings" aria-label="Settings" onClick={() => post({ type: 'openSettings' })}>
                <Settings size={16} />
              </button>
              <button type="button" title="New chat" aria-label="New chat" onClick={() => post({ type: 'newSession' })}>
                <Plus size={16} />
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
            <ArrowLeft size={14} strokeWidth={1.8} />
          </button>
          <span>{state.title || 'New Chat'}</span>
          <div className="header-actions" aria-label="Nap chat actions">
            <button type="button" title="Sessions" aria-label="Sessions" onClick={openSessionsPage}>
              <List size={16} />
            </button>
            <button type="button" title="Settings" aria-label="Settings" onClick={() => post({ type: 'openSettings' })}>
              <Settings size={16} />
            </button>
            <button type="button" title="New chat" aria-label="New chat" onClick={() => post({ type: 'newSession' })}>
              <Plus size={16} />
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
          onKeyDown={onTimelineKeyDown}
          onTouchStart={markUserScrollIntent}
          onTouchMove={markUserScrollIntent}
          tabIndex={0}
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
        ) : state.messages.map((message, index) => {
          const followingAssistant = message.role === 'user'
            ? state.messages.slice(index + 1).find(item => item.role === 'assistant')
            : undefined;
          const completedTurnLabel = followingAssistant?.status !== 'streaming' && followingAssistant?.completedAt
            ? `Worked for ${formatWorkedSeconds(followingAssistant.completedAt - followingAssistant.createdAt)}`
            : undefined;
          const turnDividerLabel = message.id === activeTurnUserMessageId ? activeTurnElapsedLabel : completedTurnLabel;
          const showTurnDivider = message.role === 'user' && (index > 0 || Boolean(turnDividerLabel));
          const responseCompletedAt = message.completedAt ?? message.createdAt;
          return (
            <Fragment key={message.id}>
              {showTurnDivider ? <TurnDivider label={turnDividerLabel} /> : null}
              <article className={`message message--${message.role}`} data-message-id={message.id}>
                <div className="message-body">
                  {message.role === 'assistant' ? (
                    <>
                      {message.content ? (
                        <AssistantContent content={message.content} compactFinal={message.status === 'complete'} />
                      ) : null}
                      {message.status === 'streaming' && waitingText ? (
                        <ActivityLine kind={waitingKind} text={waitingText} />
                      ) : !message.content ? (
                        <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown('...') }} />
                      ) : null}
                    </>
                  ) : message.content || '...'}
                </div>
                {message.role === 'assistant' && message.content && message.status !== 'streaming' ? (
                  <div className="response-meta">
                    <div className="response-actions" aria-label="Response actions">
                      <button type="button" title="Copy response" aria-label="Copy response" onClick={() => copyResponse(message.id, getCopyableAssistantContent(message.content, message.status))}>
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
                      <time className="response-time" dateTime={new Date(responseCompletedAt).toISOString()}>
                        {formatClockTime(responseCompletedAt)}
                      </time>
                    </div>
                  </div>
                ) : null}
              </article>
            </Fragment>
          );
        })}
        {state.messages.length > 0 ? <div ref={timelineContentEndRef} className="timeline-content-end" aria-hidden="true" /> : null}
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
              {isStreaming ? (
                <button className="send-button send-button--stop" type="button" title="Stop" aria-label="Stop" onClick={() => post({ type: 'stopGeneration' })}>
                  <Square size={10} />
                </button>
              ) : (
                <button className="send-button" type="submit" title={isAuthenticated ? 'Send' : 'Sign in required'} aria-label="Send" disabled={!draft.trim() || !isAuthenticated}>
                  <ArrowUp size={20} strokeWidth={1.35} />
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

function TurnDivider({ label }: { label?: string }) {
  return (
    <div className={`turn-divider${label ? ' turn-divider--active' : ''}`} aria-label={label ?? 'Conversation divider'}>
      {label ? <span>{label}</span> : <span aria-hidden="true" />}
    </div>
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
      <Icon size={13} aria-hidden="true" />
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

function getEditedActivityItems(items: NapActivityItem[]): NapActivityItem[] {
  const byFile = new Map<string, NapActivityItem>();
  for (const item of items) {
    if (item.verb !== 'edit') {
      continue;
    }
    const key = item.filePath ?? item.title ?? item.id;
    byFile.set(key, item);
  }
  return [...byFile.values()];
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

function getRuntimeIcon(target: RuntimeTarget) {
  if (target === 'cloud') {
    return Cloud;
  }
  if (target === 'cli') {
    return SquareTerminal;
  }
  return Laptop;
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

function formatWorkedSeconds(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  return `${seconds} ${seconds === 1 ? 'Second' : 'Seconds'}`;
}

function formatClockTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(timestamp);
}
