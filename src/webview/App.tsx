import {
  ArrowUp,
  Check,
  ChevronLeft,
  Cloud,
  Copy,
  Laptop,
  Lock,
  Mic,
  Shield,
  SquareTerminal,
  Square,
  ThumbsDown,
  ThumbsUp
} from 'lucide-react';
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
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
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string>();
  const [responseVotes, setResponseVotes] = useState<Record<string, ResponseVote>>({});
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerPanelRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastAnchoredUserMessageId = useRef<string>();
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
    return () => window.removeEventListener('message', listener);
  }, [post]);

  useEffect(() => {
    const latestUserMessage = [...state.messages].reverse().find(message => message.role === 'user');
    if (!latestUserMessage || latestUserMessage.id === lastAnchoredUserMessageId.current) {
      return;
    }

    lastAnchoredUserMessageId.current = latestUserMessage.id;
    requestAnimationFrame(() => {
      const timeline = timelineRef.current;
      const userMessage = timeline?.querySelector<HTMLElement>(`[data-message-id="${latestUserMessage.id}"]`);
      if (!timeline || !userMessage) {
        return;
      }

      timeline.scrollTo({
        top: userMessage.offsetTop - timeline.clientTop - (timeline.clientHeight * 0.25),
        behavior: 'smooth'
      });
    });
  }, [state.messages]);

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
  const sessions = state.sessions.length > 0
    ? state.sessions
    : [{
      id: state.sessionId,
      title: 'New Chat',
      preview: '',
      messageCount: state.messages.length,
      updatedAt: Date.now()
    }];

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

  const copyResponse = useCallback((messageId: string, content: string) => {
    void navigator.clipboard?.writeText(content).then(() => {
      setCopiedMessageId(messageId);
      window.setTimeout(() => {
        setCopiedMessageId(current => current === messageId ? undefined : current);
      }, 1000);
    });
  }, []);

  const RuntimeIcon = getRuntimeIcon(runtimeTarget);

  return (
    <div className="nap-shell">
      {sessionsOpen ? (
        <section className="sessions-page" aria-label="Nap sessions">
          <header className="sessions-page-header">
            <button type="button" aria-label="Back to chat" onClick={() => setSessionsOpen(false)}>
              <ChevronLeft size={16} />
            </button>
            <span>Sessions</span>
          </header>
          <div className="sessions-list">
            {sessions.map(session => (
              <button
                key={session.id}
                type="button"
                className={`session-item${session.id === state.sessionId ? ' is-current' : ''}`}
                onClick={() => {
                  if (session.id !== state.sessionId) {
                    post({ type: 'openSession', sessionId: session.id });
                  }
                  setSessionsOpen(false);
                }}
              >
                <span className="session-title">{session.title}</span>
                <span className="session-meta">{session.messageCount} messages - {formatRelativeTime(session.updatedAt)}</span>
                {session.preview ? <span className="session-preview">{session.preview}</span> : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {!sessionsOpen ? (
        <button
          className="sessions-toggle"
          type="button"
          title="Sessions"
          aria-label="Show sessions"
          aria-expanded={sessionsOpen}
          onClick={() => setSessionsOpen(true)}
        >
          <ChevronLeft size={16} />
        </button>
      ) : null}

      {!sessionsOpen ? (
        <main className="timeline" ref={timelineRef} aria-label="Nap conversation">
        {state.messages.length === 0 ? (
          <div className="empty-state">
            {window.__NAP_LOGO_URI__ ? (
              <img className="empty-state-logo" src={window.__NAP_LOGO_URI__} alt="Nap" />
            ) : null}
            <p>Start a Nap Chat below</p>
          </div>
        ) : state.messages.map(message => (
          <article key={message.id} className={`message message--${message.role}`} data-message-id={message.id}>
            <div className="message-body">
              {message.role === 'assistant' && message.status === 'streaming' && !message.content ? (
                <span className="analysing-text">Analysing</span>
              ) : message.role === 'assistant' ? (
                <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content || '...') }} />
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

      {!sessionsOpen ? (
        <section className="log-strip" aria-label="Nap log">
        <span className={`log-dot log-dot--${latestLog?.level ?? 'trace'}`} />
        <span className="log-text">{latestLog ? latestLog.message : 'Session idle'}</span>
        </section>
      ) : null}

      {!sessionsOpen ? (
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
                <button className="send-button" type="submit" title="Send" aria-label="Send" disabled={!draft.trim()}>
                  <ArrowUp size={15} />
                </button>
              )}
            </div>
          </div>
        </form>

        <div className="composer-options" aria-label="Nap run options">
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
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}
